/**
 * Otto's model registry: the live Gemini model list, refreshed from Google.
 *
 * At startup `refreshModels()` asks the Google models endpoint
 * (https://generativelanguage.googleapis.com/v1beta/models) which models
 * exist right now, keeps only text/chat-capable Gemini models, and replaces
 * the in-memory registry. When the fetch fails (no key, offline, API error)
 * the registry stays on FALLBACK_MODELS - a curated free-tier list verified
 * against the API in Sept 2026. (Note: gemini-2.0-flash, once on the list,
 * no longer appears in the API response, so it is not in the fallback.)
 *
 * PUT /api/settings validation and the frontend pickers both read this
 * registry, so a model discovered live is always accepted by the API.
 */
export interface ModelInfo {
  id: string;
  label: string;
}

/** Curated free-tier fallback, verified against the live API (Sept 2026). */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "gemini-flash-latest", label: "Gemini Flash (latest)" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
  // gemini-2.5-pro is deliberately absent: Google now answers it with
  // "404 no longer available to new users", so listing it would only ever
  // produce a failure. Re-add it if Google reopens it for this tier.
];

export const DEFAULT_MODEL = "gemini-flash-latest";

export type ModelSource = "live" | "fallback";

import { getSetting } from "../db.js";
import { getApiKey, initializeApiKey } from "./apiKey.js";

let registry: ModelInfo[] = [...FALLBACK_MODELS];
let source: ModelSource = "fallback";

/** The current list: live from Google when refreshModels() succeeded. */
export function availableModels(): ModelInfo[] {
  return [...registry];
}

/** Just the ids, in registry (best-first) order. */
export function modelIds(): string[] {
  return registry.map((m) => m.id);
}

export function modelSource(): ModelSource {
  return source;
}

export function isFreeTierModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return registry.some((m) => m.id === id);
}

export function resolveModel(): string {
  try {
    const saved = getSetting("model", "").trim();
    if (saved && isFreeTierModel(saved)) return saved.toLowerCase();
  } catch {
    /* DB unavailable (early boot) - fall through to env */
  }
  const env = (process.env.MODEL?.trim() || "").toLowerCase();
  if (env && isFreeTierModel(env)) return env;
  return DEFAULT_MODEL;
}

export function assertFreeTierModel(model: string = resolveModel()): string {
  const id = model.trim().toLowerCase();
  if (!isFreeTierModel(id)) {
    throw new Error(
      `Otto only runs free-tier Google models (${registry.map((m) => m.id).join(", ")}). Refusing to use "${model}".`,
    );
  }
  return id;
}

/**
 * Models the API response rules out for plain chat (TTS, images, video...).
 * `2\.5-pro` is included because the models endpoint still lists it but
 * generateContent answers "404 no longer available to new users" - it is
 * advertised, not usable.
 */
const EXCLUDED =
  /tts|transcribe|image|embedding|aqa|veo|robotics|computer-use|customtools|omni|antigravity|deep-research|\blive\b|preview|gemini-2\.5-pro/i;

function prettyLabel(id: string, displayName?: string): string {
  if (displayName && displayName.trim()) return displayName.trim();
  return id
    .replace(/^gemini-/, "Gemini ")
    .replace(/-latest$/, " (latest)")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Rank: *-latest aliases first, then higher versions first, stable over preview. */
function rank(id: string): [number, number, number] {
  const latest = id.endsWith("-latest") ? 0 : 1;
  const preview = /preview/i.test(id) ? 1 : 0;
  const m = id.match(/(\d+)(?:\.(\d+))?/);
  const major = m ? Number(m[1]) : 0;
  const minor = m?.[2] ? Number(m[2]) : 0;
  return [latest, -(major * 100 + minor), preview];
}

/**
 * Replace the registry with the live list from Google. Never throws and
 * never leaves an empty registry: on any failure the fallback stands.
 */
export async function refreshModels(): Promise<ModelSource> {
  const key = getApiKey();
  if (!key) return source;
  initializeApiKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return source;
    const data = (await res.json()) as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    const live: ModelInfo[] = [];
    for (const m of data.models ?? []) {
      const full = String(m.name ?? "");
      if (!full.startsWith("models/gemini-")) continue;
      const id = full.replace(/^models\//, "").toLowerCase();
      if (EXCLUDED.test(id)) continue;
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      if (!/flash|pro/.test(id)) continue;
      live.push({ id, label: prettyLabel(id, m.displayName) });
    }
    if (!live.length) return source;
    live.sort((a, b) => {
      const ra = rank(a.id);
      const rb = rank(b.id);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.id.localeCompare(b.id);
    });
    // Keep the default selectable even if Google ever drops the alias.
    if (!live.some((m) => m.id === DEFAULT_MODEL)) {
      live.unshift({ id: DEFAULT_MODEL, label: "Gemini Flash (latest)" });
    }
    registry = live.slice(0, 20);
    source = "live";
  } catch {
    /* offline / timeout / bad key - the curated fallback stands */
  } finally {
    clearTimeout(timer);
  }
  return source;
}
