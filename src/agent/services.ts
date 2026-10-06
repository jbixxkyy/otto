/**
 * SQLite-backed ADK session + memory services.
 *
 * We implement ADK's two service interfaces ourselves instead of using the
 * bundled `DatabaseSessionService`, because that one routes SQLite through
 * MikroORM and therefore needs a *native* sqlite driver that must be compiled
 * on every platform. Otto has to `npm install && npm run build && npm start`
 * cleanly on both Linux and Windows, so we implement the same contracts on top
 * of Node's built-in `node:sqlite`:
 *
 *   BaseSessionService -> OttoSessionService  (persistent sessions + event log)
 *   BaseMemoryService  -> OttoMemoryService   (recall across restarts)
 *
 * Both satisfy the ADK interfaces structurally, so
 * `new Runner({ sessionService, memoryService, ... })` accepts them unchanged.
 *
 * ADK contracts mirrored here (node_modules/@google/adk/dist/types):
 *   sessions/base_session_service.d.ts -> createSession, getSession,
 *     getOrCreateSession, listSessions, deleteSession, appendEvent({session,event})
 *   memory/base_memory_service.d.ts    -> addSessionToMemory, searchMemory
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";
import { resetAdmission } from "./admission.js";

export const APP_NAME = "otto";
export const DEFAULT_USER_ID = "josh";

/** Structural mirror of `@google/genai` Content as ADK passes it around. */
export interface AdkContent {
  role: string;
  parts: Array<Record<string, unknown>>;
}

export interface AdkEvent {
  id: string;
  invocationId: string;
  author: string;
  actions: Record<string, unknown>;
  timestamp: number;
  content?: AdkContent;
  partial?: boolean;
  turnComplete?: boolean;
  longRunningToolIds?: string[];
  branch?: string;
  [key: string]: unknown;
}

export interface AdkSession {
  id: string;
  appName: string;
  userId: string;
  state: Record<string, unknown>;
  events: AdkEvent[];
  lastUpdateTime: number;
}

export interface AdkMemoryEntry {
  id?: string;
  content: AdkContent;
  author?: string;
  timestamp?: string;
}

let schemaReady = false;

function db(): DatabaseSync {
  const dir = process.env.OTTO_DATA_DIR ?? path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const handle = getDb();
  if (!schemaReady) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS adk_sessions (
        id               TEXT PRIMARY KEY,
        app_name         TEXT NOT NULL,
        user_id          TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT '{}',
        last_update_time INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adk_events (
        session_id    TEXT NOT NULL,
        id            TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        invocation_id TEXT NOT NULL DEFAULT '',
        author        TEXT NOT NULL DEFAULT 'agent',
        payload       TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        PRIMARY KEY (session_id, id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_adk_events_session ON adk_events(session_id, seq);
      CREATE TABLE IF NOT EXISTS adk_memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        session_id TEXT NOT NULL,
        author     TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_adk_memories_scope ON adk_memories(app_name, user_id, timestamp);
    `);
    schemaReady = true;
  }
  return handle;
}

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readEvents(sessionId: string, limit?: number, afterTimestamp?: number): AdkEvent[] {
  const where = ["session_id = ?"];
  const params: Array<string | number> = [sessionId];
  if (typeof afterTimestamp === "number") {
    where.push("timestamp >= ?");
    params.push(afterTimestamp);
  }
  const sql =
    typeof limit === "number" && limit > 0
      ? `SELECT payload FROM (
           SELECT payload, seq FROM adk_events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`
      : `SELECT payload FROM adk_events WHERE ${where.join(" AND ")} ORDER BY seq ASC`;
  if (typeof limit === "number" && limit > 0) params.push(limit);
  const rows = db().prepare(sql).all(...params) as unknown as { payload: string }[];
  return rows.map((r) => parse<AdkEvent>(r.payload, {} as AdkEvent));
}

/** ADK BaseSessionService */
export class OttoSessionService {
  async createSession(request: {
    appName: string;
    userId: string;
    state?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<AdkSession> {
    const id = request.sessionId ?? randomUUID();
    db()
      .prepare(
        `INSERT INTO adk_sessions (id, app_name, user_id, state, last_update_time) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_update_time = excluded.last_update_time`,
      )
      .run(id, request.appName, request.userId, JSON.stringify(request.state ?? {}), Date.now());
    const found = await this.getSession({ appName: request.appName, userId: request.userId, sessionId: id });
    return (
      found ?? {
        id,
        appName: request.appName,
        userId: request.userId,
        state: request.state ?? {},
        events: [],
        lastUpdateTime: Date.now(),
      }
    );
  }

  async getSession(request: {
    appName: string;
    userId: string;
    sessionId: string;
    config?: { numRecentEvents?: number; afterTimestamp?: number };
  }): Promise<AdkSession | undefined> {
    const row = db()
      .prepare("SELECT * FROM adk_sessions WHERE id = ? AND app_name = ? AND user_id = ?")
      .get(request.sessionId, request.appName, request.userId) as unknown as
      | { id: string; app_name: string; user_id: string; state: string; last_update_time: number }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      appName: row.app_name,
      userId: row.user_id,
      state: parse<Record<string, unknown>>(row.state, {}),
      events: readEvents(request.sessionId, request.config?.numRecentEvents, request.config?.afterTimestamp),
      lastUpdateTime: row.last_update_time,
    };
  }

  async getOrCreateSession(request: {
    appName: string;
    userId: string;
    state?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<AdkSession> {
    const found = await this.getSession({
      appName: request.appName,
      userId: request.userId,
      sessionId: request.sessionId ?? "",
    });
    return found ?? this.createSession(request);
  }

  async listSessions(request: {
    appName: string;
    userId?: string;
    limit?: number;
    offset?: number;
    page?: number;
    order?: "asc" | "desc";
  }): Promise<{ sessions: AdkSession[]; page: number; limit: number; totalItems: number; totalPages: number }> {
    const limit = request.limit ?? 50;
    const page = request.page ?? 1;
    const offset = request.offset ?? (page - 1) * limit;
    const where = request.userId ? "app_name = ? AND user_id = ?" : "app_name = ?";
    const params = request.userId ? [request.appName, request.userId] : [request.appName];
    const counted = db().prepare(`SELECT COUNT(*) AS n FROM adk_sessions WHERE ${where}`).get(...params) as unknown as {
      n: number;
    };
    const totalItems = Number(counted?.n ?? 0);
    const dir = request.order === "asc" ? "ASC" : "DESC";
    const ids = db()
      .prepare(`SELECT id FROM adk_sessions WHERE ${where} ORDER BY last_update_time ${dir} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as { id: string }[];
    const sessions: AdkSession[] = [];
    for (const row of ids) {
      const s = await this.getSession({ appName: request.appName, userId: request.userId ?? "", sessionId: row.id });
      if (s) sessions.push(s);
    }
    return { sessions, page, limit, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / limit)) };
  }

  async deleteSession(request: { appName: string; userId: string; sessionId: string }): Promise<void> {
    db().prepare("DELETE FROM adk_events WHERE session_id = ?").run(request.sessionId);
    db()
      .prepare("DELETE FROM adk_sessions WHERE id = ? AND app_name = ? AND user_id = ?")
      .run(request.sessionId, request.appName, request.userId);
  }

  /**
   * Persisting every event is what lets Otto remember context after a restart.
   *
   * The in-memory mirror matters as much as the row. ADK's ContentRequestProcessor
   * builds LlmRequest.contents from invocationContext.session.events, so if we do
   * not push onto that array the model is called with an empty conversation and
   * answers its own system instruction instead of the user's question. The
   * built-in DatabaseSessionService gets this for free (it re-reads events on
   * every append); we have to do it by hand.
   */
  async appendEvent({ session, event }: { session: AdkSession; event: AdkEvent }): Promise<AdkEvent> {
    // Partial streaming chunks are superseded by the final event; persisting them
    // would duplicate every reply. Matches BaseSessionService.appendEvent.
    if (event.partial) return event;

    // Monotonic per session: Date.now() alone collides when two events land in the
    // same millisecond, and seq is the ordering key for readEvents.
    const handle = db();
    const max = handle
      .prepare("SELECT MAX(seq) AS n FROM adk_events WHERE session_id = ?")
      .get(session.id) as unknown as { n: number | null };
    const seq = Number(max?.n ?? 0) + 1;
    const at = Number(event.timestamp ?? seq);

    handle
      .prepare(
        `INSERT INTO adk_events (session_id, id, seq, invocation_id, author, payload, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, id, seq) DO UPDATE SET payload = excluded.payload`,
      )
      .run(
        session.id,
        String(event.id ?? ""),
        seq,
        String(event.invocationId ?? ""),
        String(event.author ?? "agent"),
        JSON.stringify(event),
        at,
      );
    handle.prepare("UPDATE adk_sessions SET last_update_time = ? WHERE id = ?").run(at, session.id);

    // Mirror into the live session: replace a re-emitted event by id, else append.
    if (!Array.isArray(session.events)) session.events = [];
    const index = session.events.findIndex((e) => e.id === event.id);
    if (index >= 0) session.events[index] = event;
    else session.events.push(event);
    session.lastUpdateTime = Math.max(session.lastUpdateTime ?? 0, at);

    return event;
  }

  /** Danger-zone "Erase all memory". */
  purgeAll(): void {
    const handle = db();
    handle.exec("DELETE FROM adk_events");
    handle.exec("DELETE FROM adk_sessions");
    handle.exec("DELETE FROM adk_memories");
    // The operator asked for a clean slate, so drop any remembered rate-limit
    // state too - otherwise a multi-hour quota block outlives the erase and
    // Otto keeps refusing requests the user thinks they just cleared.
    resetAdmission();
  }
}

/** ADK BaseMemoryService - lexical recall, so no paid embedding API is needed. */
export class OttoMemoryService {
  async addSessionToMemory(session: AdkSession): Promise<void> {
    const handle = db();
    const insert = handle.prepare(
      `INSERT INTO adk_memories (app_name, user_id, session_id, author, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // This runs at the end of every turn over the whole session, so without a
    // dedupe pass each earlier exchange would be re-inserted once per turn and
    // recall would return the same memory N times.
    const seen = new Set(
      (handle.prepare("SELECT content FROM adk_memories WHERE session_id = ?").all(session.id) as unknown as {
        content: string;
      }[]).map((row) => row.content),
    );

    for (const event of session.events ?? []) {
      if (!event.content?.parts?.length) continue;
      const content = JSON.stringify(event.content);
      if (seen.has(content)) continue;
      seen.add(content);
      insert.run(
        session.appName,
        session.userId,
        session.id,
        String(event.author ?? "agent"),
        content,
        Number(event.timestamp ?? Date.now()),
      );
    }
  }

  async searchMemory(request: { appName: string; userId: string; query: string }): Promise<{ memories: AdkMemoryEntry[] }> {
    const terms = request.query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
      .slice(0, 8);
    const rows = db()
      .prepare(
        `SELECT id, author, content, timestamp FROM adk_memories
         WHERE app_name = ? AND user_id = ? ORDER BY timestamp DESC LIMIT 400`,
      )
      .all(request.appName, request.userId) as unknown as {
      id: number;
      author: string;
      content: string;
      timestamp: number;
    }[];

    const scored = rows
      .map((row) => {
        const content = parse<AdkContent>(row.content, { role: row.author, parts: [] });
        const text = (content.parts ?? [])
          .map((p) => String((p as { text?: unknown }).text ?? ""))
          .join(" ")
          .toLowerCase();
        return { row, content, hits: terms.filter((t) => text.includes(t)).length };
      })
      .filter((e) => (terms.length === 0 ? true : e.hits > 0))
      .sort((a, b) => b.hits - a.hits || b.row.timestamp - a.row.timestamp)
      .slice(0, 12);

    return {
      memories: scored.map(({ row, content }) => ({
        id: String(row.id),
        content,
        author: row.author,
        timestamp: new Date(row.timestamp).toISOString(),
      })),
    };
  }
}

export function userContent(text: string): AdkContent {
  return { role: "user", parts: [{ text }] };
}

export function contentText(content: AdkContent | undefined): string {
  if (!content?.parts) return "";
  return content.parts
    .map((part) => {
      const t = (part as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    })
    .join("");
}