/**
 * SQLite persistence for Otto (node:sqlite builtin - no native module to compile).
 *
 * Tables
 *   conversations  id, title, created_at
 *   messages       id, conversation_id, role, content, created_at
 *   activity_log   id, title, kind, status, steps (JSON), created_at
 *   settings       key, value  (also backs the Settings toggles + MCP overrides)
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DATA_DIR = process.env.OTTO_DATA_DIR
  ? path.resolve(process.env.OTTO_DATA_DIR)
  : path.join(process.cwd(), "data");
export const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, "otto.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      status     TEXT NOT NULL,
      steps      TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
  `);
  return db;
}

// ---- settings ---------------------------------------------------------------
export function getSetting(key: string, fallback: string): string {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function getBoolSetting(key: string, fallback = false): boolean {
  const raw = getSetting(key, String(fallback));
  return raw === "1" || raw === "true";
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

// ---- conversations ----------------------------------------------------------
export interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
}

export function createConversation(title = "New chat"): ConversationRow {
  const id = randomUUID();
  const created = Date.now();
  getDb().prepare("INSERT INTO conversations (id, title, created_at) VALUES (?, ?, ?)").run(id, title, created);
  return { id, title, created_at: created };
}

export function getConversation(id: string): ConversationRow | undefined {
  return getDb().prepare("SELECT * FROM conversations WHERE id = ?").get(id) as unknown as ConversationRow | undefined;
}

export function listConversations(limit = 200): ConversationRow[] {
  return getDb()
    .prepare("SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as ConversationRow[];
}

export function touchConversation(id: string, title?: string): void {
  if (!getConversation(id)) return;
  if (title) getDb().prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
}

export function deleteConversation(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  d.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

// ---- messages ---------------------------------------------------------------
export interface MessageRow {
  id: number;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
}

export function addMessage(conversationId: string, role: MessageRow["role"], content: string): MessageRow {
  const created = Date.now();
  const res = getDb()
    .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, role, content, created);
  return { id: Number(res.lastInsertRowid), conversation_id: conversationId, role, content, created_at: created };
}

export function getMessages(conversationId: string, limit = 200): MessageRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?")
    .all(conversationId, limit) as unknown as MessageRow[];
  return rows;
}

// ---- activity log -----------------------------------------------------------
export type ActivityKind = "computer" | "chat" | "server";
export type ActivityStatus = "running" | "done" | "paused" | "stopped" | "error";

export interface ActivityStep {
  at: number;
  text: string;
  tool?: string;
  ok?: boolean;
}

export interface ActivityRow {
  id: number;
  title: string;
  kind: ActivityKind;
  status: ActivityStatus;
  steps: string; // JSON
  created_at: number;
}

export interface Activity {
  id: number;
  title: string;
  kind: ActivityKind;
  status: ActivityStatus;
  steps: ActivityStep[];
  created_at: number;
}

export function startActivity(title: string, kind: ActivityKind): number {
  const res = getDb()
    .prepare("INSERT INTO activity_log (title, kind, status, steps, created_at) VALUES (?, ?, 'running', '[]', ?)")
    .run(title, kind, Date.now());
  return Number(res.lastInsertRowid);
}

export function appendStep(id: number, step: ActivityStep): void {
  const row = getDb().prepare("SELECT steps FROM activity_log WHERE id = ?").get(id) as { steps: string } | undefined;
  const steps: ActivityStep[] = row ? safeParse(row.steps) : [];
  steps.push(step);
  getDb().prepare("UPDATE activity_log SET steps = ? WHERE id = ?").run(JSON.stringify(steps.slice(-200)), id);
}

export function finishActivity(id: number, status: ActivityStatus): void {
  getDb().prepare("UPDATE activity_log SET status = ? WHERE id = ?").run(status, id);
}

export function listActivity(limit = 100): Activity[] {
  const rows = getDb()
    .prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as ActivityRow[];
  return rows.map((r) => ({ ...r, steps: safeParse(r.steps) }));
}

// ---- memory -----------------------------------------------------------------
export function eraseAllMemory(): void {
  const d = getDb();
  d.exec("DELETE FROM messages");
  d.exec("DELETE FROM conversations");
  d.exec("DELETE FROM activity_log");
  // settings (toggles/theme) intentionally survive - they are configuration, not memory
}

function safeParse(text: string): ActivityStep[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as ActivityStep[]) : [];
  } catch {
    return [];
  }
}