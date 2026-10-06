/**
 * The Otto agent loop.
 *
 * user command -> agent observes (screenshot / tool results) -> decides the next
 * tool call -> acts -> repeats until it finishes, is stopped, paused, or hits
 * maxSteps. Every step lands in activity_log (SQLite) and is broadcast over the
 * WebSocket so the Desktop tab updates live.
 *
 * STOP is immediate: `runAsync` receives the AbortController signal from
 * control.beginRun(), so pressing Stop tears the run down mid-stream.
 */
import { FileArtifactService, Runner, getFunctionCalls } from "@google/adk";
import type { BaseArtifactService, BaseMemoryService, BaseSessionService } from "@google/adk";
import {
  ARTIFACT_DIR,
  appendStep,
  finishActivity,
  startActivity,
  type ActivityKind,
  type ActivityStatus,
} from "../db.js";
import { broadcast } from "../bus.js";
import { assertFreeTierModel, buildAgent } from "./agent.js";
import { getApiKey } from "./apiKey.js";
import { getProvider, getProviderReadiness, providerModel } from "./provider.js";
import {
  APP_NAME,
  DEFAULT_USER_ID,
  OttoMemoryService,
  OttoSessionService,
  type AdkContent,
  contentText,
  userContent,
} from "./services.js";
import {
  beginRun,
  endRun,
  isPaused,
  isStopped,
  isTakenOver,
  setCurrentActivityId,
  statusSnapshot,
  stopAgent,
  waitWhilePaused,
} from "./control.js";
import {
  MAX_FALLBACK_PROBES,
  admit,
  allModelsBlocked,
  dailyBudgetWarning,
  fallbackCandidates,
  noteExhaustedUnknown,
  noteModelCall,
  noteThrottleLimit,
  noteThrottled,
  quotaExhaustedSeconds,
  retryAfterSeconds,
  type QuotaScope,
} from "./admission.js";

const MAX_STEPS = 12;

/**
 * Transient provider failures worth one more attempt. Deliberately narrow:
 * 429 (free-tier RPM), 500/502/503/504, and overload wording. A 400 is a request
 * defect - retrying it just burns quota - so it is not here.
 */
const TRANSIENT_CODES = /^(429|500|502|503|504)$/;
const TRANSIENT_TEXT = /high demand|overloaded|rate limit|quota exceeded/i;

/** Backoff for the retry when the provider gives no hint: long enough to clear a burst. */
const RETRY_DELAY_MS = 1200;

/**
 * Longest we will hold a single retry open. The provider's hint can say 30s;
 * waiting that long inside an HTTP request is worse than showing the error, so we
 * cap it and let the queue's cooldown handle the rest on the next run.
 */
const RETRY_MAX_WAIT_MS = 12_000;

/** "19h 31m" / "24m" / "45s" from a seconds count, for user-facing text. */
function humanDuration(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (seconds >= 60) return `${Math.max(1, Math.round(seconds / 60))}m`;
  return `${Math.max(1, Math.round(seconds))}s`;
}

function isTransient(detail: string): boolean {
  const code = detail.split(":")[0]?.trim() ?? "";
  return TRANSIENT_CODES.test(code) || TRANSIENT_TEXT.test(detail);
}

/** Thrown when no Google key is configured, so the UI can show the exact state. */
export class MissingApiKeyError extends Error {
  readonly code = "KEY_MISSING" as const;
  constructor() {
    super("The selected AI provider is not configured. Check Settings → Model.");
  }
}

export interface RunOptions {
  /** Called with each streamed text delta. */
  onDelta?: (chunk: string) => void;
  /** Called when a tool starts, for the Desktop readout ("Clicking Chrome..."). */
  onStep?: (text: string, tool?: string) => void;
  /** Activity row kind: chat-only requests vs anything touching the PC. */
  kind?: ActivityKind;
  /** Continue an existing ADK session so Otto remembers context. */
  adkSessionId?: string;
}

export interface RunResult {
  text: string;
  status: ActivityStatus;
  steps: number;
  adkSessionId: string;
  /** Model that actually answered - may differ from the saved setting after a fallback. */
  model: string;
  /** True when the saved model was quota-exhausted and Otto moved on by itself. */
  fellBack: boolean;
}

export function hasApiKey(): boolean {
  return getProviderReadiness().ready;
}

export function isKeyMissing(err: unknown): boolean {
  return err instanceof MissingApiKeyError || (err as { code?: string } | null)?.code === "KEY_MISSING";
}

const redactSecretsText = (text: string): string => text.replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]");

export function status() {
  return statusSnapshot();
}

/** Drop the memoised graph (used by the Danger zone "Stop agent" button). */
export function shutdown(): void {
  endRun();
}

const retryScopeByModel = new Map<string, QuotaScope>();

/**
 * Quota failures leave the model recorded here, so the NEXT run can skip it
 * without spending a call to rediscover that it is dead.
 *
 * Deliberately not persisted: quota state is per-process and time-sensitive, and
 * a stale "blocked" mark after a restart would strand Otto on a fallback that is
 * no longer the best choice.
 */
export function lastQuotaScope(model: string): QuotaScope | undefined {
  return retryScopeByModel.get(model.trim().toLowerCase());
}

function noteScope(model: string, scope: QuotaScope): void {
  retryScopeByModel.set(model.trim().toLowerCase(), scope);
}

/**
 * The models to try, in order: the saved one first, then fallbacks.
 *
 * Google's free-tier quota is per-model, so a dead model costs the user nothing
 * to route around - with a dozen models on the registry that turns ~20 calls/day
 * into many times that. This only ever moves AWAY from a model believed out of
 * quota; it never silently upgrades a working one, and the Settings choice is
 * never rewritten.
 */
function modelPlan(opts: RunOptions): string[] {
  const saved = assertFreeTierModel();
  if (!isExhausted(saved)) return [saved, ...fallbackCandidates(saved).slice(0, MAX_FALLBACK_PROBES)];

  const alternatives = fallbackCandidates(saved);
  if (alternatives.length) {
    opts.onStep?.(
      `${saved} has no quota left - Otto will answer on ${alternatives[0]} instead. ` +
        `Your Settings choice is unchanged.`,
    );
  }
  return [saved, ...alternatives.slice(0, MAX_FALLBACK_PROBES)];
}

function isExhausted(model: string): boolean {
  return quotaExhaustedSeconds(model) > 0;
}

export async function runOtto(userMessage: string, opts: RunOptions = {}): Promise<RunResult> {
  if (!hasApiKey()) throw new MissingApiKeyError();

  const provider = getProvider();
  const savedModel = providerModel();
  const plan = provider === "google" ? modelPlan(opts) : [savedModel];

  if (provider === "google" && allModelsBlocked(plan[0])) {
    throw new Error(
      `Every free-tier model on this key has used up its quota. They reset on Google's own schedule, ` +
        `usually within a day. Otto cannot answer until then.`,
    );
  }

  const sessionService = new OttoSessionService();
  const memoryService = new OttoMemoryService();
  const artifactService: BaseArtifactService = new FileArtifactService(ARTIFACT_DIR);

  const userId = DEFAULT_USER_ID;
  const abort = beginRun();
  const activityId = startActivity(titleFrom(userMessage), opts.kind ?? "chat");
  setCurrentActivityId(activityId);

  let stepCount = 0;
  let text = "";
  // ADK reports model failures (bad key, quota, safety) as an event carrying
  // errorCode/errorMessage and no content - it does not throw. Streaming replies
  // arrive as partial:true chunks plus one final full-text event, so keep both
  // and prefer the authoritative final text when it exists.
  let streamedText = "";
  let finalText = "";

  const logStep = (message: string, tool?: string, ok = true): void => {
    stepCount += 1;
    appendStep(activityId, { at: Date.now(), text: message, tool, ok });
    broadcast({ type: "step", activityId, text: message, tool, ok, at: Date.now() });
    opts.onStep?.(message, tool);
  };

  logStep(`You: ${trimForLog(userMessage)}`);

  let status: ActivityStatus = "done";
  // Overwritten per attempt with the provider's own "retry in Ns" hint when it
  // supplies one; otherwise the flat default.
  let retryWaitMs = RETRY_DELAY_MS;
  // Which model actually answered. Starts at the saved one and moves only when
  // that model turns out to be out of quota.
  let model = plan[0];
  let fellBack = false;
  // Session that produced the accepted answer, if any.
  let finalSessionId: string | undefined;

  try {
    // Two nested loops, deliberately:
    //   model  - try the next candidate when this one is out of quota
    //   attempt- retry the SAME model once on a transient failure
    //
    // Model order is the outer loop because a quota failure is not transient:
    // waiting does not help, but a different model does.
    for (let mi = 0; mi < plan.length; mi += 1) {
      model = plan[mi];
      if (mi > 0) {
        fellBack = true;
        logStep(`${model} has no quota left - trying ${plan[mi]}.`);
      }

      // Pace run starts before we touch the session or the model, so a burst of
      // clicks queues instead of walking into a 429.
      try {
        const gate = await admit(model);
        if (gate.queued && gate.waitedMs > 500) {
          broadcast({
            type: "step",
            activityId: 0,
            text: `Waiting for a free model slot (${Math.round(gate.waitedMs / 100) / 10}s)...`,
            ok: true,
            at: Date.now(),
          });
        }
      } catch (err) {
        // Admission refused (this model is blocked). Move to the next candidate
        // rather than failing the whole run.
        if (mi + 1 < plan.length) {
          logStep(`${err instanceof Error ? err.message : String(err)} - trying another model.`, undefined, false);
          continue;
        }
        throw err;
      }

      // Each model needs its own graph and its own session: the previous model's
      // failed attempt already appended this question to its session.
      const { root } = await buildAgent(provider === "google" ? model : undefined);
      const session =
        mi === 0 && opts.adkSessionId
          ? await sessionService.getOrCreateSession({ appName: APP_NAME, userId, sessionId: opts.adkSessionId })
          : await sessionService.getOrCreateSession({ appName: APP_NAME, userId });
      const runner = new Runner({
        appName: APP_NAME,
        agent: root,
        sessionService: sessionService as unknown as BaseSessionService,
        memoryService: memoryService as unknown as BaseMemoryService,
        artifactService,
      });

      // Warn on the way IN, while there is still time to switch models or wait.
      const budget = dailyBudgetWarning();
      if (budget && mi === 0) opts.onStep?.(budget);

      // Reset per model AND per retry: a previous model's partial text must never
      // bleed into this one's answer.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          streamedText = "";
          finalText = "";
          const waitSeconds = Math.ceil(retryWaitMs / 1000);
          logStep(`Model was busy - retrying in ${waitSeconds}s...`);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, retryWaitMs);
          if (typeof t.unref === "function") t.unref();
        });
        if (isStopped() || abort.signal.aborted) {
          status = "stopped";
          logStep("Stopped by the operator.", undefined, false);
          break;
        }
      }

      let transient = false;
      // Set when this attempt is finished and the OUTER model loop should move on.
      let exhausted = false;
      // True only when no further model can help, i.e. the user must be told.
      let outOfModels = false;

      const events = runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: userContent(userMessage) as never,
        abortSignal: abort.signal,
      });

      for await (const event of events) {
        // Every model round-trip draws on the daily budget, so count it rather
        // than learning the allowance by exhausting it.
        if (provider === "google" && event.content !== undefined && !event.partial && event.errorCode === undefined) {
          noteModelCall();
        }
        if (event.errorCode) {
          const detail = redactSecretsText(`${event.errorCode}: ${event.errorMessage ?? "model call failed"}`);
          if (provider !== "google") {
            if (attempt === 0 && isTransient(detail)) {
              transient = true;
              const hint = retryAfterSeconds(detail);
              retryWaitMs = hint ? Math.min(Math.ceil(hint * 1000), RETRY_MAX_WAIT_MS) : RETRY_DELAY_MS;
              logStep(`Provider was busy - retrying once in ${Math.ceil(retryWaitMs / 1000)}s...`, undefined, false);
              break;
            }
            status = "error";
            logStep(`Error: ${detail}`, undefined, false);
            opts.onDelta?.(`\\n\\n_Error: ${detail}_`);
            break;
          }
          if (attempt === 0 && isTransient(detail)) {
            const hint = retryAfterSeconds(detail);
            const scope = noteThrottleLimit(detail, hint);
            noteThrottled(hint, model);
            noteScope(model, scope);
            const code = detail.split(":")[0]?.trim() ?? "";

            // Any quota refusal means this model cannot serve the request RIGHT
            // NOW. Waiting helps only for an RPM throttle; for a daily budget it
            // cannot. Either way there is another model in the plan, so hand over
            // to it silently rather than making the user read a failure for a
            // question that Otto can still answer.
            const quotaRefusal =
              code === "429" && (hint === null || (scope === "period" && hint !== null));
            if (quotaRefusal) {
              // No deadline given: we cannot block on a countdown, but we must
              // stop choosing this model. With a deadline, noteThrottled already
              // recorded it.
              if (hint === null) noteExhaustedUnknown(model);
              // Only the LAST candidate has nowhere left to fall back to, so only
              // then does the user need to be told.
              outOfModels = mi + 1 >= plan.length;
              if (outOfModels) {
                status = "error";
                const why =
                  hint === null
                    ? `Google refused ${model} on quota grounds without saying when it resets`
                    : `Free-tier quota for ${model} is used up - Google says it resets in ${humanDuration(hint)}`;
                const msg =
                  `${why}. Otto has no other free model with quota left, so it cannot answer this. ` +
                  `They reset on Google's own schedule, usually within a day.`;
                logStep(msg, undefined, false);
                opts.onDelta?.(`\n\n_Error: ${msg}_`);
              } else {
                logStep(`${model} is out of quota - switching models.`, undefined, false);
              }
              exhausted = true;
              break;
            }

            // RPM throttle (or an unclassifiable one): retry once, honouring the
            // provider's own delay when it gave one. Some 429s carry no retry
            // hint at all, so the flat default covers that case.
            transient = true;
            retryWaitMs = hint ? Math.min(Math.ceil(hint * 1000), RETRY_MAX_WAIT_MS) : RETRY_DELAY_MS;
            break;
          }
          status = "error";
          logStep(`Error: ${detail}`, undefined, false);
          opts.onDelta?.(`\n\n_Error: ${detail}_`);
          break;
        }

        if (isStopped() || abort.signal.aborted) {
          stopAgent();
          status = "stopped";
          logStep("Stopped by the operator.", undefined, false);
          break;
        }

        if (isTakenOver()) {
          status = "paused";
          logStep("You took control - Otto is paused.", undefined, false);
          break;
        }

        if (isPaused()) {
          status = "paused";
          logStep("Paused - press Resume to continue.", undefined, false);
          await waitWhilePaused();
          if (isStopped()) {
            status = "stopped";
            logStep("Stopped by the operator.", undefined, false);
            break;
          }
          status = "running";
        }

        for (const call of getFunctionCalls(event)) {
          const args = (call.args ?? {}) as Record<string, unknown>;
          const toolName = String(call.name ?? "tool");
          logStep(describeTool(toolName, args), toolName);
          if (stepCount > MAX_STEPS) {
            stopAgent();
            status = "stopped";
            logStep(`Stopped after ${MAX_STEPS} steps so the loop stays bounded.`, undefined, false);
            break;
          }
        }

        const delta = contentText(event.content as AdkContent | undefined);
        if (delta) {
          if (event.partial) {
            streamedText += delta;
            opts.onDelta?.(delta);
          } else {
            finalText = delta;
            opts.onDelta?.(delta);
          }
        }
      }

      text = (finalText || streamedText).trim();
      if (text) finalSessionId = session.id;
      // A real answer ends the run, and so does an operator stop.
      if (text || status === "stopped" || status === "paused") break;
      // `exhausted` means this model is out of quota: the outer loop takes over.
      if (!transient || exhausted) break;

      // Retrying re-sends the message, so it needs a clean session.
      const retrySession = await sessionService
        .getOrCreateSession({ appName: APP_NAME, userId })
        .catch(() => undefined);
      if (!retrySession) {
        status = "error";
        logStep("Error: model was busy and a clean retry session could not be created.", undefined, false);
        opts.onDelta?.("\n\n_Error: model was busy - try again in a moment._");
        break;
      }
      session.id = retrySession.id;
    }
    }

    // Remember the finished turn so context survives restarts.
    if (text) {
      const answered = await sessionService
        .getSession({ appName: APP_NAME, userId, sessionId: finalSessionId! })
        .catch(() => undefined);
      if (answered) await memoryService.addSessionToMemory(answered).catch(() => undefined);
    }
  } catch (err) {
    if (isStopped()) {
      status = "stopped";
      logStep("Stopped by the operator.", undefined, false);
    } else {
      status = "error";
      // Redact anything key-shaped before it can reach the UI or the log.
      const message = redactSecretsText(err instanceof Error ? err.message : String(err));
      logStep(`Error: ${message}`, undefined, false);
      opts.onDelta?.(`\n\n_Error: ${message}_`);
    }
  } finally {
    finishActivity(activityId, status);
    setCurrentActivityId(null);
    broadcast({ type: "activity", id: activityId, status });
    endRun();
  }

  return {
    text: text.trim(),
    status,
    steps: stepCount,
    // A fallback run's real session is the one that finally answered; without this
    // the caller would store a dead model's empty session and lose the thread.
    adkSessionId: finalSessionId ?? opts.adkSessionId ?? "",
    model,
    fellBack,
  };
}

/** "Clicking the Chrome icon..." style readout for the Desktop tab. */
function describeTool(name: string, args: Record<string, unknown>): string {
  const s = (key: string): string => {
    const v = args[key];
    return typeof v === "string" ? v : JSON.stringify(v ?? "");
  };
  switch (name) {
    case "screenshot":
      return "Taking a screenshot...";
    case "mouse_move":
      return `Moving the mouse to ${s("x")}, ${s("y")}...`;
    case "click":
      return `Clicking (${s("button") || "left"})...`;
    case "type_text":
      return `Typing "${trimForLog(s("text"), 40)}"...`;
    case "press_key":
      return `Pressing ${s("combo")}...`;
    case "open_app":
      return `Opening ${s("name")}...`;
    case "run_command":
      return `Wants to run: ${trimForLog(s("command"), 60)} - waiting for your confirmation`;
    case "write_file":
      return `Writing ${s("path")}...`;
    case "read_file":
      return `Reading ${s("path")}...`;
    case "list_dir":
      return `Listing ${s("path") || "."}...`;
    default:
      return name.startsWith("mcp__") ? `Using MCP tool ${name.replace("mcp__", "").replace("__", " / ")}...` : `Using ${name}...`;
  }
}

function trimForLog(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  if (!t) return "Otto task";
  return t.length > 60 ? `${t.slice(0, 60)}...` : t;
}
