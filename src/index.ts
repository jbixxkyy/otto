/**
 * Otto entrypoint: static frontend + /api + the Desktop WebSocket.
 *
 * Windows-only code is never imported eagerly on other platforms - src/win is
 * platform-guarded internally, so this file boots identically on Linux and
 * Windows.
 */
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachDesktopSocket, createApi, shutdownGracefully, startDesktopStream } from "./api/routes.js";
import { getDb } from "./db.js";
import { refreshModels, resolveModel } from "./agent/models.js";
import { getApiKeySource, initializeApiKey } from "./agent/apiKey.js";
import { getProvider, getProviderReadiness, providerModel } from "./agent/provider.js";
import { isWindows } from "./win/index.js";
import { AGENT_CARD } from "./agent/card.js";

const PORT = Number(process.env.PORT ?? 3456);
const HOST = process.env.HOST ?? "0.0.0.0"; // 0.0.0.0 so a phone on the same Wi-Fi can reach it
const here = path.dirname(fileURLToPath(import.meta.url));

// dist/index.js -> dist/public
const publicDir = path.join(here, "public");

const app = express();
app.disable("x-powered-by");

app.use("/api", createApi());
app.get("/api/a2a/agent-card.json", (_req, res) => res.json(AGENT_CARD));

// no-store on the shell so a phone never runs a cached app.js after a deploy.
app.use(
  express.static(publicDir, {
    extensions: ["html"],
    setHeaders: (res, filePath) => {
      if (/\.(js|html)$/.test(filePath)) res.setHeader("Cache-Control", "no-store");
    },
  }),
);

// SPA fallback for the four screens (no wildcard routes - Express 5 path syntax).
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/ws")) {
    next();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) next();
  });
});

const server = createServer(app);
attachDesktopSocket(server);

getDb();
initializeApiKey();
startDesktopStream();

try {
  await refreshModels();
} catch {
  /* curated fallback stands */
}

server.listen(PORT, HOST, () => {
  const provider = getProvider();
  const keySource = provider === "google" ? getApiKeySource() : (getProviderReadiness().apiKeySet ? "settings" : "missing");
  const keySet = getProviderReadiness().ready;
  console.log(`\n  Otto  ->  http://localhost:${PORT}`);
  console.log(`  host   ${HOST}:${PORT}  (open this on your phone on the same Wi-Fi)`);
  console.log(`  model  ${providerModel()}${provider === "google" ? " (Google free tier)" : " (OpenAI-compatible)"}`);
  console.log(`  provider ${provider}`);
  console.log(`  key    ${keySet ? `configured (${keySource})` : "NOT SET - configure it in Settings"}`);
  console.log(`  hostOS ${process.platform}${isWindows ? "" : " (computer control is Windows-only)"}`);
  console.log(`  data   ${path.join(process.cwd(), "data")}\n`);
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await shutdownGracefully().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());