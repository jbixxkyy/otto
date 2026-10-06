/** Provider configuration persisted in Otto's local SQLite settings database. */
import { getSetting, setSetting } from "../db.js";
import { getApiKey } from "./apiKey.js";

export type ProviderId = "google" | "openai-compatible";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function getProvider(): ProviderId {
  return getSetting("provider", "google") === "openai-compatible" ? "openai-compatible" : "google";
}

export function getOpenAICompatibleConfig(): OpenAICompatibleConfig {
  return {
    baseUrl: getSetting("openaiBaseUrl", "").trim().replace(/\/+$/, ""),
    model: getSetting("openaiModel", "").trim(),
    apiKey: getSetting("openaiApiKey", "").trim(),
  };
}

export function getProviderReadiness(): { ready: boolean; apiKeySet: boolean } {
  if (getProvider() === "google") {
    const apiKeySet = Boolean(getApiKey());
    return { ready: apiKeySet, apiKeySet };
  }
  const config = getOpenAICompatibleConfig();
  const apiKeySet = Boolean(config.apiKey);
  // Local endpoints such as Ollama intentionally need no credential.
  return { ready: Boolean(config.baseUrl && config.model), apiKeySet };
}

export function setProvider(value: string): ProviderId {
  if (value !== "google" && value !== "openai-compatible") {
    throw new Error("Provider must be google or openai-compatible.");
  }
  setSetting("provider", value);
  return value;
}

export function saveOpenAICompatibleApiKey(value: string): void {
  setSetting("openaiApiKey", value.trim());
}

export function saveOpenAICompatibleBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS API base URL.");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("The API base URL must use HTTP or HTTPS and cannot contain credentials, a query, or a fragment.");
  }
  const baseUrl = parsed.toString().replace(/\/+$/, "");
  setSetting("openaiBaseUrl", baseUrl);
  return baseUrl;
}

export function saveOpenAICompatibleModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 200) throw new Error("Model name is required and must be at most 200 characters.");
  setSetting("openaiModel", model);
  return model;
}

export function providerModel(): string {
  if (getProvider() === "openai-compatible") return getOpenAICompatibleConfig().model;
  return getSetting("model", "gemini-flash-latest");
}
