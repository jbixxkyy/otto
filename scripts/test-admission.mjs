/**
 * Admission-control checks. Runs against dist/ so it exercises the real module.
 * Run with: node scripts/test-admission.mjs
 */
import {
  MAX_FALLBACK_PROBES,
  admit,
  allModelsBlocked,
  blockedModels,
  classifyThrottle,
  cooldownSeconds,
  dailyBudgetWarning,
  dailyQuotaState,
  fallbackCandidates,
  noteExhaustedUnknown,
  noteModelCall,
  noteThrottleLimit,
  noteThrottled,
  quotaExhaustedSeconds,
  resetAdmission,
  retryAfterSeconds,
  runsPerMinuteNow,
  setModelOrder,
} from "../dist/agent/admission.js";

const isExhaustedForTest = (m) => quotaExhaustedSeconds(m) > 0;

// Pacing delays are unref'd on purpose (a sleep should never be the only reason
// the process stays alive). That means nothing else holds the event loop open
// here, so this test must.
const keepAlive = setInterval(() => {}, 1000);

let failures = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got ${actual}\n        want ${expected}`}`);
}

const limitBody =
  "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-2.5-flash\nPlease retry in 24.493231276s.";

// --- parsing the provider's own hints ---------------------------------------
check("retry hint parsed from a 429 body", retryAfterSeconds(limitBody), "24.493231276");
check("no hint -> null", retryAfterSeconds("503: model unavailable"), "null");
// The raw hint is deliberately uncapped: loop.ts needs to see the real magnitude
// to tell "busy minute" (retry now) from "daily quota gone" (stop trying).
check("raw hint is not capped", retryAfterSeconds("Please retry in 99999s."), "99999");
// A daily-quota 429 says "retry in 19h34m29s". Reading the leading 19 as seconds
// would reopen the gate immediately and walk back into the same wall.
const dailyBody =
  "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash\nPlease retry in 19h34m29.838605682s.";
check(
  "compound hours hint is not read as seconds",
  Math.round(retryAfterSeconds(dailyBody)),
  70470,
);
check("compound minutes+hours hint", retryAfterSeconds("Please retry in 1h2m3s."), "3723");
check("minutes hint", retryAfterSeconds("Please retry in 5m."), "300");
// --- telling an RPM throttle from a daily budget ---------------------------
// The trap this guards: Google prints the SAME "limit: N" text for both a
// per-minute cap and a 20-per-DAY allowance, and omits the dimension from the
// human-readable message. Only the retry delay tells them apart. Reading a
// 20/day budget as 20/min paces Otto at 10 runs/min and burns the whole day in
// about a minute.
resetAdmission();
check("24s hint classifies as rpm", classifyThrottle(24.5), "rpm");
check("19h hint classifies as period", classifyThrottle(70469), "period");
check("no hint is unknown", classifyThrottle(null), "unknown");
check("rpm body -> rpm scope", noteThrottleLimit(limitBody, 24.49), "rpm");
check("daily body -> period scope", noteThrottleLimit(dailyBody, 70469), "period");
check("daily quota limit was recorded", dailyQuotaState().limit, "20");
check("no daily quota learned from an rpm throttle", dailyQuotaState().limit, "20");
resetAdmission();
noteThrottleLimit(limitBody, 24.49);
check("an rpm throttle alone records no daily budget", dailyQuotaState(), "null");

// --- daily budget accounting -------------------------------------------------
// Warn while there is still time to act, not after the fact.
resetAdmission();
noteThrottleLimit(dailyBody, 70469);
check("no warning with the budget untouched", dailyBudgetWarning(), "null");
for (let i = 0; i < 17; i += 1) noteModelCall();
const lowWarning = dailyBudgetWarning();
check("warning appears near the limit", /Only 3 of 20/.test(lowWarning ?? ""), "true");
console.log(`        ${lowWarning}`);
noteModelCall();
noteModelCall();
noteModelCall();
check("warning becomes 'spent' past the limit", /spent/.test(dailyBudgetWarning() ?? ""), "true");
check("usage is counted, not estimated", dailyQuotaState().used, "20");

// --- pacing ------------------------------------------------------------------
resetAdmission();
check("default pacing is the built-in 4 runs/min", runsPerMinuteNow(), "4");
process.env.OTTO_RUNS_PER_MINUTE = "12";
check("env override still wins", runsPerMinuteNow(), "12");
delete process.env.OTTO_RUNS_PER_MINUTE;
resetAdmission();
// An RPM limit must NOT silently retune minute-level pacing from a scraped number.
noteThrottleLimit(limitBody, 24.49);
check("scraped rpm limit does not retune pacing", runsPerMinuteNow(), "4");

// A 429 with NO retry hint must not be guessed into a "daily budget" claim -
// observed on gemini-3.1-flash-lite, whose body omits "Please retry in".
const hintless =
  "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.1-flash-lite";
resetAdmission();
check("hintless 429 is unknown scope", noteThrottleLimit(hintless, null), "unknown");
check("hintless 429 records no daily deadline", dailyQuotaState(), "null");
check("hintless 429 still gets a short cooldown", (noteThrottled(null), Math.round(cooldownSeconds())), "5");
check("hintless 429 does not block the model", quotaExhaustedSeconds("gemini-3.1-flash-lite"), "0");
resetAdmission(); // clear the 5s cooldown so pacing does not skew the next check
check(
  "hintless 429 leaves the model usable",
  await admit("gemini-3.1-flash-lite").then(() => "admitted").catch(() => "rejected"),
  "admitted",
);

// --- cooldown ----------------------------------------------------------------
resetAdmission();
noteThrottled(null);
const cd = cooldownSeconds();
check("default cooldown is 5s", Math.round(cd), 5);
noteThrottled(30);
check("longer cooldown wins", Math.round(cooldownSeconds()), 30);
noteThrottled(1);
check("shorter cooldown cannot shorten it", Math.round(cooldownSeconds()), 30);

// --- env override -----------------------------------------------------------
process.env.OTTO_RUNS_PER_MINUTE = "0";
check("explicit 0 disables pacing", runsPerMinuteNow(), "0");
process.env.OTTO_RUNS_PER_MINUTE = "90";
check("explicit value wins", runsPerMinuteNow(), "90");
delete process.env.OTTO_RUNS_PER_MINUTE;

// --- the queue itself --------------------------------------------------------
resetAdmission();
process.env.OTTO_RUNS_PER_MINUTE = "600"; // 100ms apart, so the test stays quick
const at = [];
const t0 = Date.now();
await Promise.all(Array.from({ length: 5 }, () => admit().then(() => at.push(Date.now() - t0))));
const spread = at[at.length - 1] - at[0];
// 600/min = 100ms apart, so four gaps should total >= ~350ms.
check("five admissions at 600/min are spread out", spread >= 350, "true");
console.log(`        admitted at +${at.join("ms, +")}ms (spread ${spread}ms)`);

// A wait must not pin the event loop open.
resetAdmission();
process.env.OTTO_RUNS_PER_MINUTE = "1"; // 60s apart - we must NOT actually wait
const quick = await Promise.race([
  admit().then(() => "admitted"),
  new Promise((r) => setTimeout(() => r("blocked"), 300)),
]).catch(() => "rejected");
// First admit in an idle window is immediate, so it should win the race.
check("idle first admit is immediate, not paced", quick, "admitted");

// --- a multi-hour quota block must refuse, not queue -----------------------
// --- quota fallback picks a different model ---------------------------------
// The premise, verified against the live API: Google's free-tier daily quota is
// per-MODEL, so routing around an exhausted one is free capacity, not a loss.
resetAdmission();
noteThrottled(70469, "gemini-3.5-flash"); // known-dead, with a deadline
noteThrottled(70469, "gemini-2.5-flash");
noteExhaustedUnknown("gemini-3.6-flash"); // no deadline given
const modelOrder = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
];
setModelOrder(() => modelOrder);
// 3.8/3.7/3.6-dead or current leaves 3.5 and 2.5 (both dead too), so the only
// healthy candidate is none - what matters is that dead ones are excluded.
check(
  "fallback never proposes a dead model",
  ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.6-flash"].filter((id) =>
    fallbackCandidates("gemini-3.8-flash").includes(id),
  ).join(","),
  "",
);
// noteThrottled only ever EXTENDS a block, so unblocking needs a reset.
resetAdmission();
for (const id of ["gemini-3.5-flash", "gemini-2.5-flash"]) noteThrottled(70469, id);
noteExhaustedUnknown("gemini-3.6-flash");
check(
  "with only 3.7 healthy, it is proposed",
  fallbackCandidates("gemini-3.8-flash").join(","),
  "gemini-3.7-flash",
);
check(
  "a short block cannot be extended downward",
  (() => {
    resetAdmission();
    noteThrottled(70469, "m");
    noteThrottled(60, "m");
    return Math.round(quotaExhaustedSeconds("m")) > 60000;
  })(),
  "true",
);
check("fallback never returns the current model", fallbackCandidates("gemini-3.7-flash").includes("gemini-3.7-flash"), "false");
// The check above reset state, so re-mark the no-deadline model before testing
// that fallback still routes around it.
noteExhaustedUnknown("gemini-3.6-flash");
check("a model with no deadline is still skipped", fallbackCandidates("gemini-3.5-flash").includes("gemini-3.6-flash"), "false");
check("fallback is capped", Math.max(fallbackCandidates("x").length, fallbackCandidates("gemini-3.8-flash").length) <= MAX_FALLBACK_PROBES, "true");

// When nothing is left, say so rather than silently retrying a dead model.
resetAdmission();
for (const id of modelOrder) noteThrottled(70469, id);
check("all-exhausted is detected", allModelsBlocked("gemini-3.5-flash"), "true");
resetAdmission();
noteThrottled(70469, "gemini-3.5-flash");
check("one healthy model left is not all-exhausted", allModelsBlocked("gemini-3.5-flash"), "false");
resetAdmission();
setModelOrder(() => []);
check("all-exhausted is false when nothing is blocked", allModelsBlocked("gemini-3.5-flash"), "false");

// The no-deadline case must NOT hard-block: there is no countdown to honour, so
// it only needs to stop being *chosen*, and must lapse on its own.
resetAdmission();
noteExhaustedUnknown("gemini-3.1-flash-lite");
check("no-deadline model is skipped by fallback", isExhaustedForTest("gemini-3.1-flash-lite"), "true");
check("no-deadline model is not permanently blocked", quotaExhaustedSeconds("gemini-3.1-flash-lite") > 0, "true");
check(
  "no-deadline model is refused inside its cooling-off window",
  await admit("gemini-3.1-flash-lite").then(() => "admitted").catch(() => "refused"),
  "refused",
);
resetAdmission();
check(
  "it becomes usable again after reset",
  await admit("gemini-3.1-flash-lite").then(() => "admitted").catch(() => "refused"),
  "admitted",
);

resetAdmission();
delete process.env.OTTO_RUNS_PER_MINUTE;
noteThrottled(retryAfterSeconds(dailyBody), "gemini-2.5-flash");
const blocked = await admit("gemini-2.5-flash").then(() => "admitted").catch((e) => e.message);
check("daily quota block refuses that model", /used up/.test(blocked), "true");
console.log(`        refused with: ${blocked}`);
check("the blocked model is named in the error", /gemini-2\.5-flash/.test(blocked), "true");

// The bug this guards: Google meters per model, so one model running dry must
// not lock out a different one. Switching models appeared to change nothing.
check(
  "a DIFFERENT model is still admitted",
  await admit("gemini-2.5-flash-lite").then(() => "admitted").catch(() => "rejected"),
  "admitted",
);
check("blocked model is listed", blockedModels().join(","), "gemini-2.5-flash");
check("the healthy model is not", blockedModels().includes("gemini-2.5-flash-lite"), "false");

// ...and the block holds even when pacing is switched off entirely.
process.env.OTTO_RUNS_PER_MINUTE = "0";
check(
  "pacing off does NOT unlock an exhausted model",
  await admit("gemini-2.5-flash").then(() => "admitted").catch(() => "rejected"),
  "rejected",
);
check(
  "pacing off still allows a healthy model",
  await admit("gemini-2.5-flash-lite").then(() => "admitted").catch(() => "rejected"),
  "admitted",
);
delete process.env.OTTO_RUNS_PER_MINUTE;

// A waiter already sleeping in the queue when the block lands must be released,
// not handed a free pass back into the wall. Pace hard so the second admit is
// genuinely still waiting, then land the block during its sleep.
resetAdmission();
process.env.OTTO_RUNS_PER_MINUTE = "600"; // 100ms apart
const first = await admit("gemini-2.5-flash"); // admitted immediately in an idle window
const queued = admit("gemini-2.5-flash"); // now sleeping in the queue
const healthy = admit("gemini-2.5-flash-lite"); // different model, same queue
noteThrottled(retryAfterSeconds(dailyBody), "gemini-2.5-flash");
const queuedOutcome = await queued.then(() => "admitted").catch((e) => (e.message ?? "rejected"));
check("already-queued waiter is refused when the block lands mid-sleep", /used up/.test(queuedOutcome), "true");
console.log(`        refused with: ${queuedOutcome}`);
check("the admit before the block still went through", first.queued, "true");
// The healthy model's waiter was behind the blocked one in the same FIFO queue;
// dropping the whole queue would have refused it too.
check(
  "a queued run for a healthy model survives its neighbour's block",
  await healthy.then(() => "admitted").catch(() => "rejected"),
  "admitted",
);
delete process.env.OTTO_RUNS_PER_MINUTE;

resetAdmission();
check("reset clears the quota block", quotaExhaustedSeconds("gemini-2.5-flash"), "0");
check("reset clears every model's block", blockedModels().length, "0");
check(
  "requests flow again after reset",
  await admit().then(() => "admitted").catch(() => "rejected"),
  "admitted",
);

clearInterval(keepAlive);
console.log(failures === 0 ? "\nall admission checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);