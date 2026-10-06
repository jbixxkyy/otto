/**
 * Google API key configuration.
 *
 * The Settings UI stores the key in Otto's local SQLite settings table. The
 * environment variable remains a fallback for existing deployments. The secret
 * is never returned to the browser; it is mirrored into process.env only for
 * libraries (such as the Google ADK) that read credentials from the environment.
 */
import { getSetting, setSetting } from "../db.js";

const SETTING_KEY = "googleApiKey";
const ENV_API_KEY = process.env.GOOGLE_API_KEY?.trim() ?? "";

export type ApiKeySource = "settings" | "environment" | "missing";

export function getApiKey(): string {
  const saved = getSetting(SETTING_KEY, "").trim();
  return saved || ENV_API_KEY;
}

export function getApiKeySource(): ApiKeySource {
  if (getSetting(SETTING_KEY, "").trim()) return "settings";
  return ENV_API_KEY ? "environment" : "missing";
}

/** Load the persisted setting (or env fallback) for SDKs that inspect process.env. */
export function initializeApiKey(): void {
  const key = getApiKey();
  if (key) process.env.GOOGLE_API_KEY = key;
  else delete process.env.GOOGLE_API_KEY;
}

/** Persist or clear the Settings override. The key is deliberately never returned. */
export function saveApiKey(value: string): void {
  const key = value.trim();
  setSetting(SETTING_KEY, key);
  initializeApiKey();
}
