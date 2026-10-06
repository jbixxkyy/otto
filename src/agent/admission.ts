/**
 * Run admission control.
 *
 * Google's free tier enforces requests-per-minute per project. When Otto exceeds
 * it, every model call in a run fails with 429 and the user gets an error in the
 * chat instead of an answer - which is exactly what a burst of activity produces.
 *
 * Rather than discovering the limit by hitting it, we pace run starts: a bounded
 * FIFO queue that spaces admissions at least `60_000 / runsPerMinute` apart. The
 * first run through an idle period is admitted immediately; later ones wait.
 *
 * Scope note: this is deliberately RUN-level, not request-level. One run is not
 * one model call - a plain chat turn makes two (the root router, then the
 * sub-agent it transfers to) and a desktop task makes more. Pacing runs is a
 * coarse approximation of the real request count, chosen because it is the only
 * seam Otto controls without wrapping the ADK's model layer.
 *
 * Set OTTO_RUNS_PER_MINUTE=0 to disable entirely (unbounded).
 */
/**
 * Conservative on purpose. A plain chat turn costs TWO model calls (root router,
 * then the sub-agent it transfers to), and the free tier's RPM allowance on this
 * account is small - so a few runs/min is the honest ceiling. Paces a lone
 * request barely at all; it only bites when you actually send a burst.
 *
 * Note this paces MINUTES. The binding constraint on a free key is usually the
 * per-DAY budget instead (20 calls/day here), which no amount of minute-level
 * pacing can fix - hence the separate daily accounting below.
 */
const DEFAULT_RUNS_PER_MINUTE = 4;

/** Model calls a single run is assumed to cost, for budgeting a daily allowance. */
const CALLS_PER_RUN = 2;

/** Runs may queue this deep before new requests are refused locally. */
const MAX_QUEUE = 32;

/** Upper bound on a single admission wait, so an idle server never stales forever. */
const MAX_WAIT_MS = 20_000;

/** Headroom kept in reserve so Otto warns before it is already cut off. */
const DAILY_WARN_THRESHOLD = 0.2;

/**
 * Runs queued for a given model, so /api/health can say "3 waiting" without
 * reaching into this module's internals.
 */
export function queueDepth(model?: string): number {
  const key = model?.trim().toLowerCase();
  if (key === undefined) return waiters.length;
  return waiters.filter((w) => w.model === key).length;
}

/** Effective pacing for diagnostics: configured, or the built-in default. */
export function describePacing(): { runsPerMinute: number; source: "env" | "default" } {
  return configuredRunsPerMinute() !== null
    ? { runsPerMinute: runsPerMinuteNow(), source: "env" }
    : { runsPerMinute: DEFAULT_RUNS_PER_MINUTE, source: "default" };
}

/** Env override. Returns null when unset so the learned/default value applies. */
function configuredRunsPerMinute(): number | null {
  const raw = (process.env.OTTO_RUNS_PER_MINUTE ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 600);
}

/**
 * Which quota a 429 is really about, from the retry hint the provider gave.
 *
 * The hidden trap: the same "limit: 20" text appears for both a per-minute cap
 * and a 20-per-DAY budget. The only honest discriminator is the retry delay - an
 * RPM throttle says "retry in 24s", a daily budget says "retry in 19h".
 */
export function classifyThrottle(retryHint: number | null): QuotaScope {
  if (retryHint === null) return "unknown";
  return retryHint > RPM_HINT_CEILING_S ? "period" : "rpm";
}

export interface AdmissionResult {
  waitedMs: number;
  queued: boolean;
}

interface Waiter {
  resolve: (result: AdmissionResult) => void;
  reject: (err: Error) => void;
  queuedAt: number;
  /** Model this run intends to use; quota blocks are per-model. */
  model: string;
}

let waiters: Waiter[] = [];
let pumping = false;
let lastAdmissionAt = 0;

/**
 * Google's 429 bodies end with "Please retry in 24.49s." - but when a DAILY quota
 * is what ran out it says "Please retry in 19h34m29.83s." Honouring that beats any
 * static guess, so a throttled response parks later admissions until the deadline.
 *
 * Deliberately matches every unit in the phrase rather than the first number: a
 * naive /([0-9.]+)s/ reads "19h34m29s" as 29 seconds and then cheerfully lets
 * the next request straight back into the same wall.
 */
const RETRY_HINT = /please retry in\s+((?:[0-9]+(?:\.[0-9]+)?\s*[hms]\s*)+)/i;

/**
 * "limit: 20, model: gemini-2.5-flash" - but the number alone does NOT say whether
 * that is per-minute or per-day. The human-readable message omits the dimension;
 * only the structured QuotaFailure names it (GenerateRequestsPerDayPerProject).
 *
 * Getting this wrong is not cosmetic: reading a 20/day allowance as 20/min makes
 * the pacer open the gate at 10 runs/min, which is ~1200x the real daily budget,
 * and Otto then burns the day's quota in about a minute. So the retry hint is the
 * authority on dimension - anything past a few minutes is a daily/period quota,
 * never an RPM one.
 */
const LIMIT_HINT = /limit:\s*([0-9]+)/i;

/** Units in seconds. */
const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };

/** Longer than this and waiting is pointless - surface the deadline instead. */
export const MAX_HONOURED_COOLDOWN_S = 300;

/**
 * An RPM throttle asks you back within a minute or two. Past that it is a daily
 * or hourly budget, and pacing by RPM is the wrong instrument entirely.
 */
const RPM_HINT_CEILING_S = 120;

let cooldownUntil = 0;

export type QuotaScope = "rpm" | "period" | "unknown";

export function runsPerMinuteNow(): number {
  return configuredRunsPerMinute() ?? DEFAULT_RUNS_PER_MINUTE;
}

/**
 * The daily allowance the provider reported, and how many model calls Otto has
 * made against it since. Useful in its own right: "20/day, 14 used" tells the
 * user far more than an opaque 429 ever did.
 */
export interface DailyQuota {
  limit: number;
  used: number;
  resetsInSeconds: number;
}

let dailyQuota: DailyQuota | null = null;

/** When the currently-tracked period was learned, so "resets in" counts down. */
let quotaLearnedAt = Date.now();

/**
 * Calls made since the current period started. Counted rather than inferred so
 * the user can be warned before they are cut off, instead of after.
 */
let callsThisPeriod = 0;

export function noteModelCall(): void {
  callsThisPeriod += 1;
  if (dailyQuota) dailyQuota.used = callsThisPeriod;
}

/**
 * Whether the next run is likely to be the one that breaks the daily budget.
 * Warns on the way in, because "quota exhausted" as a dead end helps nobody.
 */
export function dailyBudgetWarning(): string | null {
  if (!dailyQuota || dailyQuota.limit <= 0) return null;
  const left = dailyQuota.limit - callsThisPeriod;
  if (left > dailyQuota.limit * DAILY_WARN_THRESHOLD) return null;
  const when =
    dailyQuota.resetsInSeconds >= 3600
      ? `${Math.floor(dailyQuota.resetsInSeconds / 3600)}h ${Math.round((dailyQuota.resetsInSeconds % 3600) / 60)}m`
      : `${Math.max(1, Math.round(dailyQuota.resetsInSeconds / 60))}m`;
  if (left <= 0) return `Daily free-tier budget for this model is spent. It resets in ${when}.`;
  return `Only ${left} of ${dailyQuota.limit} daily model calls left (resets in ${when}) - Otto may be cut off mid-answer.`;
}

export function dailyQuotaState(): DailyQuota | null {
  if (!dailyQuota) return null;
  return {
    limit: dailyQuota.limit,
    used: callsThisPeriod,
    resetsInSeconds: Math.max(0, dailyQuota.resetsInSeconds - Math.round((Date.now() - quotaLearnedAt) / 1000)),
  };
}

/**
 * How many models to try before giving up on a run.
 *
 * Kept low deliberately. Each probe costs a model call, and a probe that finds a
 * working model is not wasted - but a probe that finds nothing is. Three is
 * enough to ride out one exhausted model, which is the overwhelmingly common case.
 */
export const MAX_FALLBACK_PROBES = 3;

/** Registry order, injected by models.ts to avoid a circular import. */
let registryOrder: () => string[] = () => [];

export function setModelOrder(fn: () => string[]): void {
  registryOrder = fn;
}

/**
 * Models whose quota is believed exhausted are skipped; the rest are offered in
 * Google's own ranking order (best-first), current model excluded.
 *
 * Free-tier quota is per-model on Google's side - verified by probing models with
 * untouched budgets while others were exhausted - so skipping a dead model costs
 * nothing and buys a working one.
 */
export function fallbackCandidates(current: string): string[] {
  const blocked = blockedModels();
  const now = current.trim().toLowerCase();
  return registryOrder()
    .filter((id) => id !== now && !blocked.includes(id))
    .slice(0, MAX_FALLBACK_PROBES);
}

/** True when every candidate is blocked and no run can succeed. */
export function allModelsBlocked(current: string): boolean {
  const blocked = blockedModels();
  const order = registryOrder();
  return order.length > 0 && order.every((id) => id === current.trim().toLowerCase() || blocked.includes(id));
}

/**
 * Read the reported quota off a throttled response and work out what kind it is.
 * Returns null when the body has no usable limit.
 */
export function noteThrottleLimit(detail: string, retryHint: number | null): QuotaScope {
  const match = LIMIT_HINT.exec(detail);
  const limit = match?.[1] ? Number(match[1]) : NaN;

  const scope: QuotaScope =
    retryHint === null
      ? "unknown"
      : retryHint > RPM_HINT_CEILING_S
        ? "period"
        : "rpm";

  // Only a period-scope throttle with a real countdown can be tracked; without
  // one there is no deadline to count down to, so record nothing.
  if (scope === "period" && retryHint !== null && Number.isFinite(limit) && limit > 0) {
    // A longer countdown means a period further out; that is the one to track.
    const existing = dailyQuota?.resetsInSeconds ?? 0;
    if (retryHint >= existing) {
      dailyQuota = { limit, used: 0, resetsInSeconds: Math.round(retryHint) };
      quotaLearnedAt = Date.now();
      callsThisPeriod = 0;
    }
  }
  return scope;
}

/**
 * Seconds to wait, parsed from a 429 body, or null if there is no hint.
 * Understands compound durations, so "19h34m29s" comes back as 70469 - large
 * enough that callers can recognise it as "come back tomorrow" rather than
 * mistaking it for a short pause.
 */
export function retryAfterSeconds(detail: string): number | null {
  const match = RETRY_HINT.exec(detail);
  if (!match?.[1]) return null;

  let total = 0;
  let seen = false;
  for (const part of match[1].matchAll(/([0-9]+(?:\.[0-9]+)?)\s*([hms])/gi)) {
    const amount = Number(part[1]);
    const unit = UNIT_SECONDS[part[2].toLowerCase()];
    if (!Number.isFinite(amount) || unit === undefined) continue;
    total += amount * unit;
    seen = true;
  }
  return seen && total > 0 ? total : null;
}

/** Model id -> epoch ms until which its quota is believed exhausted. */
const quotaBlocks = new Map<string, number>();

/**
 * Record that the provider is throttling us, with the parsed hint if there was
 * one. A hint beyond MAX_HONOURED_COOLDOWN_S means the quota is exhausted for
 * hours, not seconds.
 *
 * The long block is keyed by model on purpose. Google meters free-tier quota per
 * model, so exhausting gemini-2.5-flash must not stop Otto answering on
 * flash-lite - and one global block does exactly that, which is how this bug
 * found itself: switching models appeared to change nothing.
 */
export function noteThrottled(seconds: number | null, model = ""): void {
  if (seconds !== null && seconds > MAX_HONOURED_COOLDOWN_S) {
    const until = Date.now() + Math.min(seconds, 86_400) * 1000;
    const key = model.trim().toLowerCase();
    // An unkeyed block (no model given) applies to everything, so record it
    // against a wildcard that every lookup checks.
    quotaBlocks.set(key || "*", Math.max(quotaBlocks.get(key || "*") ?? 0, until));
    return;
  }
  const wait = seconds ?? 5;
  cooldownUntil = Math.max(cooldownUntil, Date.now() + wait * 1000);
}

/** Seconds until the model's quota frees up, or 0 when it is believed available. */
export function quotaExhaustedSeconds(model = ""): number {
  const key = model.trim().toLowerCase();
  const until = Math.max(quotaBlocks.get(key) ?? 0, quotaBlocks.get("*") ?? 0);
  return Math.max(0, (until - Date.now()) / 1000);
}

/** Models currently believed quota-exhausted, for diagnostics. */
export function blockedModels(): string[] {
  const now = Date.now();
  for (const [key, until] of quotaBlocks) if (until <= now) quotaBlocks.delete(key);
  return [...quotaBlocks.keys()];
}

/**
 * Mark a model exhausted with no known deadline.
 *
 * For the "429 with no retry hint" case: Google refuses on quota grounds but
 * refuses to say when it resets. That is not enough to block the model outright
 * (we have no deadline to count down to), but it IS enough to stop choosing it -
 * a fresh attempt usually means a different quota dimension.
 */
const UNKNOWN_RESET_WINDOW_MS = 30 * 60 * 1000;

export function noteExhaustedUnknown(model: string): void {
  const key = model.trim().toLowerCase();
  if (!key) return;
  quotaBlocks.set(key, Math.max(quotaBlocks.get(key) ?? 0, Date.now() + UNKNOWN_RESET_WINDOW_MS));
}

function quotaMessage(model: string): string | null {
  const seconds = quotaExhaustedSeconds(model);
  if (seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds - hours * 3600) / 60);
  const when =
    hours >= 1
      ? `in ${hours}h${minutes}m`
      : seconds >= 60
        ? `in ${Math.round(seconds / 60)}m`
        : `in ${Math.round(seconds)}s`;
  const which = model.trim() ? `${model.trim()} ` : "";
  return `Google's free-tier quota for ${which}is used up. It resets ${when} - Otto will not send requests to this model until then.`;
}

/** Seconds remaining on any active cooldown; 0 when clear. */
export function cooldownSeconds(): number {
  return Math.max(0, (cooldownUntil - Date.now()) / 1000);
}

/** Clear pacing history, cooldown, and anyone waiting. */
export function resetAdmission(): void {
  waiters = [];
  lastAdmissionAt = 0;
  cooldownUntil = 0;
  quotaBlocks.clear();
  dailyQuota = null;
  quotaLearnedAt = Date.now();
  callsThisPeriod = 0;
  pumping = false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Do not hold the event loop open for a pacing sleep.
    if (typeof t.unref === "function") t.unref();
  });
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (waiters.length > 0) {
      const model = waiters[0].model;
      // Refuse rather than queue while this model's quota block is believed active.
      const blocked = quotaMessage(model);
      if (blocked) {
        // Drop everyone waiting on THAT model only - a run queued for flash-lite
        // is unaffected by flash running dry.
        for (const waiter of waiters.splice(0)) {
          if (quotaMessage(waiter.model)) waiter.reject(new Error(quotaMessage(waiter.model)!));
          else waiters.push(waiter);
        }
        if (waiters.length === 0) return;
        continue;
      }
      const rpm = runsPerMinuteNow();
      if (rpm > 0) {
        const interval = 60_000 / rpm;
        // A cooldown outranks the steady-state interval: if the provider asked us
        // to wait 24s, 5s pacing would just walk back into the same 429.
        const gap = Math.max(lastAdmissionAt + interval, cooldownUntil) - Date.now();
        if (gap > 0) await delay(Math.min(gap, MAX_WAIT_MS));

        // Re-check after sleeping: a quota block can land WHILE we were waiting,
        // and releasing a waiter into it just produces another 429.
        const late = quotaMessage(model);
        if (late) {
          for (const waiter of waiters.splice(0)) {
            const msg = quotaMessage(waiter.model);
            if (msg) waiter.reject(new Error(msg));
            else waiters.push(waiter);
          }
          if (waiters.length === 0) return;
          continue;
        }
      }
      lastAdmissionAt = Date.now();
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ waitedMs: Date.now() - waiter.queuedAt, queued: true });
    }
  } finally {
    pumping = false;
  }
}

/**
 * Wait for a turn in the admission queue. Rejects only when the queue is full, the
 * signal is already aborted, or `model`'s quota is known to be exhausted.
 */
export function admit(model = "", signal?: AbortSignal): Promise<AdmissionResult> {
  const rpm = runsPerMinuteNow();
  // A blocked model must be refused even with pacing disabled, or OTTO_RUNS_PER_MINUTE=0
  // would turn "do not hammer a dead quota" into "hammer it freely".
  if (signal?.aborted) return Promise.reject(new Error("cancelled before admission"));
  const blocked = quotaMessage(model);
  if (blocked) return Promise.reject(new Error(blocked));
  if (rpm <= 0) return Promise.resolve({ waitedMs: 0, queued: false });

  return new Promise<AdmissionResult>((resolve, reject) => {
    if (waiters.length >= MAX_QUEUE) {
      reject(new Error(`Otto already has ${MAX_QUEUE} requests waiting. Try again in a moment.`));
      return;
    }
    waiters.push({ resolve, reject, queuedAt: Date.now(), model: model.trim().toLowerCase() });
    void pump();
  });
}
