/**
 * REST + WebSocket API for Otto.
 *
 *   POST   /api/chat                  SSE stream of the answer (503 when no key)
 *   GET    /api/conversations         sidebar history
 *   POST   /api/conversations         start a new chat
 *   GET    /api/conversations/:id/messages
 *   DELETE /api/conversations/:id
 *   GET    /api/activity              past tasks for the Activity tab
 *   GET    /api/settings              theme/language/model/toggles/mcp/key state
 *   PUT    /api/settings              update one allow-listed setting
 *   POST   /api/desktop/confirm       approve or deny a pending confirmation
 *   POST   /api/desktop/stop|pause|resume|takeover|release
 *   POST   /api/memory/erase          Danger zone: erase all memory
 *   GET    /api/health
 *   WS     /ws/desktop                live frames, steps, status, confirmations
 */
import express from "express";
import type { Request, Response } from "express";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Server } from "node:http";
import {
  addMessage,
  createConversation,
  deleteConversation,
  eraseAllMemory,
  finishActivity,
  getBoolSetting,
  getConversation,
  getMessages,
  getSetting,
  listActivity,
  listConversations,
  setSetting,
} from "../db.js";
import { addClient, broadcast, removeClient } from "../bus.js";
import { isWindows, screenshot } from "../win/index.js";
import { closeAllMcpClients, listMcpServers } from "../mcp/loader.js";
import { hasApiKey, isKeyMissing, runOtto, shutdown } from "../agent/loop.js";
import { availableModels, isFreeTierModel, modelIds, modelSource, resolveModel, refreshModels } from "../agent/models.js";
import { getApiKeySource, saveApiKey } from "../agent/apiKey.js";
import {
  getOpenAICompatibleConfig,
  getProvider,
  getProviderReadiness,
  providerModel,
  saveOpenAICompatibleApiKey,
  saveOpenAICompatibleBaseUrl,
  saveOpenAICompatibleModel,
  setProvider,
} from "../agent/provider.js";
import {
  allModelsBlocked,
  blockedModels,
  cooldownSeconds,
  dailyBudgetWarning,
  dailyQuotaState,
  describePacing,
  fallbackCandidates,
  quotaExhaustedSeconds,
  queueDepth,
  setModelOrder,
} from "../agent/admission.js";
import {
  listPendingConfirmations,
  pauseAgent,
  stopAgent,
  requestTakeOver,
  resolveConfirmation,
  resumeAgent,
  statusSnapshot,
} from "../agent/control.js";

/** Only these keys may be written through PUT /api/settings. */
const SETTINGS_ALLOWLIST = new Set([
  "theme",
  "language",
  "model",
  "mouse",
  "keyboard",
  "screen",
  "openApps",
  "fileAccess",
  "shell",
  "allowWrites",
  "screenFps",
  "googleApiKey",
  "provider",
  "openaiBaseUrl",
  "openaiModel",
  "openaiApiKey",
]);

const TOGGLES = ["mouse", "keyboard", "screen", "openApps", "fileAccess", "shell", "allowWrites"] as const;

/** conversationId -> ADK session id, so follow-ups in one chat keep their context. */
const adkSessions = new Map<string, string>();

const redacted = (text: string): string => text.replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]").replace(/\\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]");

function param(req: Request, name: string): string {
  const raw = (req.params as Record<string, unknown>)[name];
  return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
}

function sseInit(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A transcript write must never take the SSE stream down with it. */
function persistMessage(conversationId: string, role: "user" | "assistant", content: string): void {
  if (!content.trim()) return;
  try {
    addMessage(conversationId, role, content);
  } catch (err) {
    console.warn(`[chat] could not persist ${role} message: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createApi(): express.Router {
  const api = express.Router();
  api.use(express.json({ limit: "2mb" }));

  // Let quota fallback follow Google's own best-first model ranking. Done here
  // rather than in admission.ts to keep that module free of a models.ts import.
  setModelOrder(modelIds);

  api.get("/health", (_req, res) => {
    const provider = getProvider();
    const model = providerModel();
    const providerReady = getProviderReadiness().ready;
    res.json({
      ok: true,
      keySet: providerReady,
      provider,
      platform: process.platform,
      windows: isWindows,
      model,
      agent: statusSnapshot(),
      rateLimit: {
        ...describePacing(),
        queued: queueDepth(),
        quotaBlocked: provider === "google" ? blockedModels() : [],
        quotaResetsInSeconds: provider === "google" ? Math.round(quotaExhaustedSeconds(model)) : 0,
        cooldownSeconds: provider === "google" ? Math.round(cooldownSeconds()) : 0,
        daily: provider === "google" ? dailyQuotaState() : null,
        dailyWarning: provider === "google" ? dailyBudgetWarning() : null,
        allExhausted: provider === "google" ? allModelsBlocked(model) : false,
        nextUsableModel: provider === "google" && quotaExhaustedSeconds(model) > 0 ? (fallbackCandidates(model)[0] ?? null) : model,
        healthyModels: provider === "google" ? modelIds().filter((id) => quotaExhaustedSeconds(id) === 0) : [model],
      },
    });
  });

  api.post("/chat", async (req: Request, res: Response) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (!getProviderReadiness().ready) {
      res.status(503).json({ error: "Selected AI provider is not configured", code: "KEY_MISSING" });
      return;
    }

    const requested = typeof req.body?.conversationId === "string" ? req.body.conversationId : "";
    const conversationId = requested || createConversation(message.slice(0, 60)).id;

    sseInit(res);
    sseSend(res, "start", { conversationId });

    // Written before the run so a failed or abandoned turn still shows in the transcript.
    persistMessage(conversationId, "user", message);

    const adkSessionId = adkSessions.get(conversationId);
    let streamed = "";
    try {
      const result = await runOtto(message, {
        kind: "chat",
        adkSessionId,
        onDelta: (chunk: string) => {
          streamed += chunk;
          sseSend(res, "delta", { text: chunk });
        },
      });
      adkSessions.set(conversationId, result.adkSessionId);

      const reply = result.text || streamed;
      persistMessage(conversationId, "assistant", reply);
      sseSend(res, "done", { conversationId, text: reply, status: result.status });
    } catch (err) {
      if (isKeyMissing(err)) sseSend(res, "error", { error: "Selected AI provider is not configured", code: "KEY_MISSING" });
      else sseSend(res, "error", { error: redacted(err instanceof Error ? err.message : String(err)) });
    } finally {
      res.end();
    }
  });

  api.get("/conversations", (_req, res) => {
    res.json(listConversations());
  });

  api.post("/conversations", (req: Request, res: Response) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "New chat";
    res.json(createConversation(title.slice(0, 80)));
  });

  api.get("/conversations/:id/messages", (req: Request, res: Response) => {
    const id = param(req, "id");
    if (!getConversation(id)) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.json(getMessages(id));
  });

  api.delete("/conversations/:id", (req: Request, res: Response) => {
    deleteConversation(param(req, "id"));
    res.json({ ok: true });
  });

  api.get("/activity", (_req, res) => {
    res.json(listActivity());
  });

  api.get("/settings", async (_req, res: Response) => {
    // Never cacheable: the key banner and model picker must reflect live state.
    res.setHeader("Cache-Control", "no-store");
    let mcpServers: unknown[] = [];
    try {
      mcpServers = await listMcpServers();
    } catch {
      mcpServers = [];
    }
    const toggles: Record<string, boolean> = {};
    for (const key of TOGGLES) toggles[key] = getBoolSetting(key, false);

    res.json({
      theme: getSetting("theme", "system"),
      language: getSetting("language", "en"),
      model: providerModel(),
      provider: getProvider(),
      providerReady: getProviderReadiness().ready,
      openAICompatible: {
        baseUrl: getOpenAICompatibleConfig().baseUrl,
        model: getOpenAICompatibleConfig().model,
        apiKeySet: Boolean(getOpenAICompatibleConfig().apiKey),
      },
      googleModel: resolveModel(),
      availableModels: getProvider() === "google" ? availableModels() : (getOpenAICompatibleConfig().model ? [{ id: getOpenAICompatibleConfig().model, label: getOpenAICompatibleConfig().model }] : []),
      modelSource: modelSource(),
      freeTier: getProvider() === "google",
      toggles,
      apiKeySet: getProviderReadiness().apiKeySet,
      apiKeySource: getProvider() === "google" ? getApiKeySource() : (getProviderReadiness().apiKeySet ? "settings" : "missing"),
      platform: process.platform,
      windows: isWindows,
      mcpServers,
      agent: statusSnapshot(),
      pendingConfirmations: listPendingConfirmations().length,
    });
  });

  api.put("/settings", (req: Request, res: Response) => {
    const { key, value } = (req.body ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== "string") {
      res.status(400).json({ error: "key is required" });
      return;
    }
    if (!SETTINGS_ALLOWLIST.has(key) && !/^mcp:[A-Za-z0-9_.-]+$/.test(key)) {
      res.status(400).json({ error: `setting "${key}" is not editable` });
      return;
    }
    if (["googleApiKey", "openaiApiKey", "openaiBaseUrl", "openaiModel", "provider"].includes(key)) {
      // Otto binds to the LAN for the UI, but provider credentials/configuration must be changed locally.
      const address = req.socket.remoteAddress ?? "";
      const isLoopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
      if (!isLoopback) {
        res.status(403).json({ error: "Provider credentials and configuration can only be changed from the Otto machine." });
        return;
      }
      try {
        if (key === "provider") {
          if (typeof value !== "string") throw new Error("Provider must be a string.");
          setProvider(value);
        } else if (key === "googleApiKey" || key === "openaiApiKey") {
          if (typeof value !== "string" || value.length > 4096) throw new Error("API key must be a string no longer than 4096 characters.");
          if (key === "googleApiKey") saveApiKey(value);
          else saveOpenAICompatibleApiKey(value);
        } else if (key === "openaiBaseUrl") {
          if (typeof value !== "string" || value.length > 2048) throw new Error("Base URL is required and must be at most 2048 characters.");
          saveOpenAICompatibleBaseUrl(value);
        } else {
          if (typeof value !== "string") throw new Error("Model name must be a string.");
          saveOpenAICompatibleModel(value);
        }
        void refreshModels();
        res.setHeader("Cache-Control", "no-store");
        const ready = getProviderReadiness();
        res.json({ ok: true, provider: getProvider(), model: providerModel(), apiKeySet: ready.apiKeySet, apiKeySource: key === "googleApiKey" ? getApiKeySource() : (ready.apiKeySet ? "settings" : "missing") });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid provider setting." });
      }
      return;
    }
    if (key === "model") {
      const id = String(value ?? "").trim().toLowerCase();
      if (!isFreeTierModel(id)) {
        res.status(400).json({
          error: `model "${value}" is not on the free tier`,
          availableModels: availableModels().map((m) => m.id),
        });
        return;
      }
      setSetting(key, id);
      res.json({ ok: true, key, value: id });
      return;
    }
    const stored = typeof value === "boolean" ? (value ? "true" : "false") : String(value ?? "");
    setSetting(key, stored);
    res.json({ ok: true, key, value: stored });
  });

  api.post("/desktop/confirm", (req: Request, res: Response) => {
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const approved = req.body?.approved === true || req.body?.approved === "true";
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const resolved = resolveConfirmation(id, approved);
    res.status(resolved ? 200 : 404).json({ ok: resolved, resolved, approved });
  });

  api.post("/desktop/stop", (_req, res) => {
    stopAgent();
    res.json({ ok: true, stopped: true });
  });

  api.post("/desktop/pause", (_req, res) => {
    pauseAgent();
    res.json({ ok: true, paused: true });
  });

  api.post("/desktop/resume", (_req, res) => {
    resumeAgent();
    res.json({ ok: true, state: statusSnapshot().state });
  });

  api.post("/desktop/release", (_req, res) => {
    resumeAgent();
    res.json({ ok: true, released: true, state: statusSnapshot().state });
  });

  api.post("/desktop/takeover", (_req, res) => {
    requestTakeOver();
    res.json({ ok: true, takeover: true });
  });

  api.post("/memory/erase", (_req, res: Response) => {
    eraseAllMemory();
    res.json({ ok: true });
  });

  return api;
}

/**
 * Why there is no live screen right now, or null when frames are flowing.
 * Derived on demand so a browser that connects after startup gets the same
 * explanation one that connected at boot did.
 */
export function screenUnavailableReason(): string | null {
  if (!isWindows) {
    return "Otto is running on Linux, so there is no Windows screen to stream. Start Otto on the Windows PC to watch the live desktop here.";
  }
  if (!getBoolSetting("screen", false)) {
    return "Screen viewing is off. Turn it on in Settings > Computer control to stream the desktop.";
  }
  return null;
}

/** WebSocket for the Desktop tab: live frames + agent events. */
export function attachDesktopSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/desktop" });

  wss.on("connection", (ws: WebSocket) => {
    addClient(ws);
    ws.send(
      JSON.stringify({
        type: "status",
        state: statusSnapshot().state,
        detail: isWindows
          ? "Connected - Otto can drive this machine"
          : "Connected - running on Linux, so computer control is unavailable here",
      }),
    );

    const unavailable = screenUnavailableReason();
    if (unavailable) ws.send(JSON.stringify({ type: "placeholder", reason: unavailable }));

    ws.on("close", () => removeClient(ws));
    ws.on("error", () => removeClient(ws));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; id?: string; approved?: boolean };
        if (msg.type === "confirm" && typeof msg.id === "string") {
          resolveConfirmation(msg.id, msg.approved === true);
        }
      } catch {
        /* ignore malformed client frames */
      }
    });
  });

  return wss;
}

/**
 * Streams screenshots of the controlled machine to the Desktop tab. Runs only
 * when Screen viewing is enabled AND we are on Windows; everywhere else it
 * broadcasts a placeholder so the tab explains itself instead of showing a
 * broken image.
 */
export function startDesktopStream(): NodeJS.Timeout | null {
  const unavailable = screenUnavailableReason();
  if (unavailable) {
    broadcast({ type: "placeholder", reason: unavailable });
    return null;
  }

  const fps = Math.min(Math.max(Number(getSetting("screenFps", "1")) || 1, 0.2), 5);
  let busy = false;

  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void screenshot()
      .then((shot) => {
        if (shot.ok && shot.png) broadcast({ type: "frame", png: shot.png.toString("base64"), at: Date.now() });
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, Math.round(1000 / fps));

  return timer;
}

/** SIGINT/SIGTERM cleanup. */
export async function shutdownGracefully(): Promise<void> {
  stopAgent();
  for (const row of listActivity()) {
    if (row.status === "running") finishActivity(row.id, "stopped");
  }
  await closeAllMcpClients().catch(() => undefined);
  shutdown();
}