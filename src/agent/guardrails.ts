/**
 * Input and output guardrails, built on the ADK model-callback surface.
 *
 * ADK 2.2 ships no guardrail API, so both checks are expressed as callbacks:
 *
 *   inputGuardrail  -> beforeModelCallback. Scans the newest user turn; returning an
 *                      LlmResponse skips the model call entirely.
 *   outputGuardrail -> afterModelCallback. Returning an LlmResponse replaces the
 *                      model's own, so redacted text is what the user sees.
 *
 * Both are attached to every agent in the graph, so a sub-agent cannot bypass them.
 */
import type { Content, Part } from "@google/genai";
import type { LlmRequest, LlmResponse } from "@google/adk";

/** Values that must never appear in a reply. */
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "Google API key", pattern: /AIza[0-9A-Za-z_-]{10,}/g },
  { label: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "private key block", pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
];

/**
 * Phrases that only appear when someone is trying to override Otto's own
 * instructions. Matched against the user's own text only - never against tool
 * output, which is untrusted data by design.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:your\s+|the\s+)?(?:previous\s+|prior\s+|above\s+|earlier\s+)*(?:instructions?|rules?|prompts?|guidelines?)/i,
  /disregard\s+(?:all\s+|any\s+)?(?:your\s+|the\s+)?(?:previous\s+|prior\s+|above\s+|earlier\s+)*(?:instructions?|rules?|prompts?|guidelines?|system\s+prompt)/i,
  /(?:reveal|print|show|output|repeat|echo)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions|system\s+instructions)/i,
  /you\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak)\s+mode/i,
  /new\s+(?:system\s+)?(?:instructions?|system\s+prompt)\s*[:>]/i,
  /\bDAN\s+mode\b/i,
  /\bpretend\s+(?:you\s+are|to\s+be)\s+(?:an?\s+)?(?:unrestricted|unfiltered|jailbroken)\b/i,
];

const REFUSAL =
  "I won't act on that. It looks like an attempt to override my instructions, so I stopped before " +
  "calling the model. Ask me a normal question, or use the Desktop tab if you want me to act on the machine.";

function textOf(part: Part | undefined): string {
  return typeof part?.text === "string" ? part.text : "";
}

/** Concatenated text of every part in a Content block. */
function blockText(content: Content | undefined): string {
  if (!content?.parts) return "";
  return content.parts.map(textOf).join("\n");
}

/** The user's own text from the most recent user turn. Assistant turns are skipped. */
function latestUserText(request: LlmRequest): string {
  const contents = Array.isArray(request.contents) ? request.contents : [];
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const entry = contents[i];
    if (entry?.role === "user") return blockText(entry);
  }
  return "";
}

export interface GuardrailVerdict {
  blocked: boolean;
  reason: string;
}

/** Pure predicate, exported so it can be unit tested without an agent. */
export function screenInput(text: string): GuardrailVerdict {
  if (!text.trim()) return { blocked: false, reason: "" };
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return { blocked: true, reason: `matched ${pattern.source}` };
  }
  return { blocked: false, reason: "" };
}

/** Applies every secret pattern; returns the scrubbed text and what it removed. */
export function redactSecrets(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text;
  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      removed.push(label);
      pattern.lastIndex = 0;
      out = out.replace(pattern, `[redacted ${label}]`);
    }
  }
  return { text: out, removed };
}

function refusalResponse(reason: string): LlmResponse {
  return {
    content: { role: "model", parts: [{ text: REFUSAL }] },
    turnComplete: true,
    customMetadata: { ottoGuardrail: "input", reason },
  };
}

/**
 * beforeModelCallback. Returning a response here means the model is never called,
 * so an injection attempt costs nothing and cannot be laundered through the model.
 */
export function inputGuardrail(params: { request: LlmRequest }): LlmResponse | undefined {
  const verdict = screenInput(latestUserText(params.request));
  if (verdict.blocked) {
    console.warn(`[guardrail] input blocked: ${verdict.reason}`);
    return refusalResponse(verdict.reason);
  }
  return undefined;
}

/**
 * afterModelCallback. Returns a new response whose text parts are scrubbed,
 * leaving function calls and metadata untouched so tool calling keeps working.
 */
export function outputGuardrail(params: { response: LlmResponse }): LlmResponse | undefined {
  const content = params.response.content;
  if (!content?.parts?.length) return undefined;

  let changed = false;
  const removedKinds = new Set<string>();
  const parts = content.parts.map((part) => {
    if (typeof part?.text !== "string" || part.text === "") return part;
    const { text, removed } = redactSecrets(part.text);
    if (!removed.length) return part;
    changed = true;
    for (const kind of removed) removedKinds.add(kind);
    return { ...part, text };
  });

  if (!changed) return undefined;

  console.warn(`[guardrail] redacted from reply: ${[...removedKinds].join(", ")}`);
  return {
    ...params.response,
    content: { ...content, parts },
    customMetadata: { ...(params.response.customMetadata ?? {}), ottoGuardrail: "output" },
  };
}
