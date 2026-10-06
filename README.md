# Otto

A ChatGPT-style web app plus an AI agent. Otto can answer questions, and — with
your permission — control a Windows PC and a Linux server through the same
interface. It runs on the free tier of Google's Gemini API.

Your chats, history, settings, and (if you add one) Google API key live in a
SQLite file inside this folder. Chat prompts and the API key are sent to Google
for inference; protect the Otto folder and device.

---

## Quick start

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3456>.

If no key is configured, Otto still boots. Open **Settings → API key**, paste a
Google AI Studio key, and save it; Otto stores it in the local SQLite database and
loads it again on future starts. You can also continue to provide `GOOGLE_API_KEY`
in the environment; a saved Settings key takes precedence.

The key is never returned to the browser or written to logs. It is stored **in
plain text** in Otto's SQLite database, so protect the data folder and device. Key
changes are accepted only from a browser running on the Otto machine (loopback); a
remote browser on the LAN cannot set or remove the credential.

### Development mode

```bash
npm run dev
```

`tsx watch` restarts on file changes. No frontend build step exists — the files in
`public/` are served as-is.

---

## The four screens

| Screen | What it does |
| --- | --- |
| **Chat** | Streaming answers, conversation history, and inline approval cards for sensitive actions. |
| **Desktop** | Live screen, current action, a step-by-step log, and pause / stop / take-over controls. |
| **Activity** | Every past task with its steps and final status. Click a row to expand the steps. |
| **Settings** | Theme, language, model, per-tool permission toggles, MCP servers, and the danger zone. |

The layout is a two-column desktop layout that collapses into a slide-in drawer on
phones. Light, dark, and system themes are all supported and the choice persists.

---

## What Otto can actually do

Otto is built on the [Google Agent Development Kit](https://google.github.io/adk-docs/)
(`@google/adk` 2.2). One root agent named `otto` has three sub-agents:

- **`chatAgent`** — plain conversation, plus Google Search when it needs current facts.
- **`computerControl`** — mouse, keyboard, screenshot, open-app, and window control.
- **`serverAgent`** — file read/write/list and shell commands.

### Free tier only

`src/agent/agent.ts` validates `MODEL` against a regex for models available on the
free tier and defaults to `gemini-flash-latest`. Set `MODEL` to override it. If you
set a model that requires a paid plan, Otto warns at startup instead of failing on
the first request.

### Guardrails

The JS ADK (2.2) has no dedicated guardrail API, so all three checks are built on its
model-callback surface in `src/agent/guardrails.ts`, and are attached to every agent so
a sub-agent cannot bypass them:

- An **input guardrail** (`beforeModelCallback`) rejects prompt-injection attempts that
  try to make Otto ignore its instructions or impersonate a system message. Returning a
  response from that callback skips the model call entirely, so an injection attempt
  costs nothing and is never laundered through the model.
- An **output guardrail** (`afterModelCallback`) redacts API keys, tokens and private-key
  blocks out of Otto's replies, so leaked key material cannot reach the browser even if
  the prompt was ignored. Tool calls and metadata are left untouched.
- A **before-tool-callback** blocks every tool while Otto is stopped, so a stopped
  agent cannot keep acting.

### Approvals

Nothing destructive happens silently. Shell commands, file writes, and clipboard or
keystroke actions call `askConfirmation`, which pushes a card into the Chat screen
and pauses that tool call until you approve or deny. There is a 120-second timeout:
no answer means deny. `POST /api/desktop/stop` denies everything pending.

---

## Windows and Linux

Otto runs on both, but it is honest about what it can do.

- **On Windows**, computer control is live. Mouse and keyboard use
  [`@nut-tree/nut-js`](https://github.com/nut-tree/nut-js) when it is installed, and
  fall back to PowerShell (`SendKeys`, `user32` P/Invoke) when it is not. Screenshots
  use a dependency-free PowerShell + `System.Drawing` capture, with
  `screenshot-desktop` as a fallback.
- **On Linux**, the Windows tools return a clear "Windows only" error and the
  Desktop screen shows a placeholder explaining why there is no live screen. Server
  tools work normally.

Both `@nut-tree/nut-js` and `screenshot-desktop` are **optional** dependencies, so
`npm install` never fails on a platform where they cannot compile.

---

## Permissions, honestly

Settings has independent switches for mouse, keyboard, screen viewing, open apps,
file access, shell, and "allow writes without asking".

Two rules hold no matter what the switches say:

1. **Writes ask by default.** `allowWrites` is off on a fresh install, so every file
   write goes through an approval card.
2. **File access is scoped.** The server tools resolve paths and refuse anything that
   escapes the Otto folder.

The server also strips any `GOOGLE_API_KEY`-shaped string out of error messages
before they can reach a client.

---

## MCP servers

`mcp.json` lists Model Context Protocol servers that extend Otto with extra tools.
Each one gets a switch in Settings and is connected only when enabled.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./data"],
      "description": "File access scoped to Otto's data directory"
    }
  }
}
```

Paths are resolved against the Otto folder, so the same file works on Windows and
Linux. Set `OTTO_MCP_CONFIG` to read the config from somewhere else.

The bundled `github` server needs `GITHUB_PERSONAL_ACCESS_TOKEN` in its `env` block.
It stays off until you fill that in.

---

## API

Everything the UI does is a plain HTTP call, so you can script Otto.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, key presence, platform, model, agent status. |
| `POST` | `/api/chat` | SSE stream: `start`, `delta`, `done`, `error`. `503` with `code: "KEY_MISSING"` when no key. |
| `GET`/`POST` | `/api/conversations` | List or create. |
| `GET` | `/api/conversations/:id/messages` | Full transcript. |
| `DELETE` | `/api/conversations/:id` | Remove one conversation. |
| `GET` | `/api/activity` | Past tasks with steps. |
| `GET`/`PUT` | `/api/settings` | Read everything; write one allow-listed key. |
| `POST` | `/api/desktop/confirm` | Approve or deny a pending confirmation. |
| `POST` | `/api/desktop/stop\|pause\|resume\|takeover` | Agent control. |
| `POST` | `/api/memory/erase` | Danger zone. Deletes everything. |
| `WS` | `/ws/desktop` | Live frames, steps, status, confirmations. |

Example:

```bash
curl -N localhost:3456/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"say hi in five words"}'
```

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_API_KEY` | — | Optional fallback for inference. A key saved in Settings takes precedence. |
| `MODEL` | `gemini-flash-latest` | Free-tier Gemini model. |
| `PORT` | `3456` | HTTP port. |
| `OTTO_MCP_CONFIG` | `./mcp.json` | Alternate MCP config path. |

---

## Running it on Windows

```bash
npm run package
```

That writes `otto-windows.zip` with the source, frontend, config, and docs —
deliberately without `node_modules`, so Windows runs its own `npm install` and
compiles native modules for the right CPU. Unzip, `npm install`, `npm run build`,
`npm start`, then open `http://localhost:3456` and add your key in Settings (or set `GOOGLE_API_KEY`).

---

## Testing

See [TESTING.md](./TESTING.md) for the full checklist and how to run it.

---

## Layout

```
src/
  agent/     ADK wiring: agent tree, tool definitions, control state, run loop
  api/       Express routes, SSE, WebSocket
  server/    File and shell tools (Linux)
  win/       Mouse, keyboard, screenshot, windows (Windows)
  mcp/       MCP config loader and tool bridge
public/      index.html, styles.css, app.js — no build step
scripts/     build helper and the Windows packager
data/        SQLite database (created on first run)
```
#   o t t o  
 