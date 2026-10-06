Build "Otto" — a complete, ChatGPT-style web app + AI agent that controls a Windows PC and a Linux server. You are building on a Linux server (joshserver), but the app MUST also run on Windows 10/11. TypeScript throughout, Node 20+.

STEP ZERO — STUDY THE REFERENCES: open and study every image in ~/otto/reference/ before writing any UI code (chatgpt-desktop2.webp = main chat UI, chatgpt-mobile.jpg + chatgpt-iphone.jpg = mobile look, chatgpt-settings.png = settings screen, chatgpt-apps.png, chatgpt-connector.webp). Match their layout, spacing, and feel closely.

THE APP — every screen must feel like the ChatGPT app:
- App name "Otto", shown in the header with a dropdown.
- Left sidebar: New chat, Search chats, chat history grouped Today / Previous 7 Days / Previous 30 Days, user profile at bottom.
- Centered chat column. Big rounded composer ("Ask anything", + button, mic icon, send button). Footer: "Otto can make mistakes. Check important info."
- Light AND dark mode. Fully responsive — it will be used from a phone browser.
- Four screens: 1) Chat (default, streaming replies, per-chat history in SQLite). 2) Desktop: LIVE view of the controlled machine's screen (streamed screenshots), "LIVE — agent is controlling your computer" banner, current-action readout (e.g. "Clicking the Chrome icon..."), step log, Pause / Stop / Take control buttons. 3) Activity: past tasks — title, time, step count, kind (computer/chat), status (Done/Paused), expandable detail. 4) Settings: General (theme, language); Model (provider locked to Google, model gemini-flash-latest, FREE TIER badge, note "Only free Google models. No card attached."); Computer control toggles (Mouse, Keyboard, Screen viewing, Open apps); Server tools toggles (File access, Shell); API key (masked + Rotate); MCP servers list (enable/disable per server); Data & privacy note (free tier: Google may use prompts to improve models); Danger zone (Stop agent, Erase all memory).

AGENT — USE THE FULL LOCAL ADK SURFACE (@google/adk):
- Root LlmAgent "otto" with sub-agents (computer-control sub-agent, chat sub-agent, server sub-agent) via ADK multi-agent composition.
- Model from MODEL env var, default "gemini-flash-latest". Free-tier Google models ONLY — never default to a paid model anywhere.
- GOOGLE_API_KEY from env only. Missing key = UI shows "API key not set" state, endpoints return a clear error. NEVER hardcode, log, or commit any key.
- Persistent sessions + memory service (SQLite-backed) so Otto remembers context across restarts.
- Artifacts for files the agent produces.
- Callbacks + guardrails: input/output guardrails; tool-use confirmation for sensitive tools — wired to the Settings toggles and a global STOP that halts the agent loop immediately.
- A2A-ready structure for talking to other agents later.
- Document how to run ADK's evaluation tooling against Otto.

TOOLS — UNIVERSAL ACCESS:
- Built-in ADK tools where the free tier allows (Google Search grounding, code execution).
- Windows GUI tools in src/win/ — REAL implementations: screenshot (primary display → PNG), mouse_move(x, y), click(button), type_text(text), press_key(combo like "ctrl+c"), open_app(name). Use a well-maintained Node library for Windows input (e.g. @nut-tree/nut-js — your call, justify it in the README).
- Server tools in src/server/ — REAL implementations: read_file, write_file, list_dir, run_command. run_command ALWAYS requires explicit per-command confirmation — no silent shell execution, ever. File writes also confirm unless the user toggled them off in Settings.
- MCP client via ADK's MCP toolset: Otto loads MCP servers listed in mcp.json (command + args + env). Ship 2–3 documented example entries (filesystem, sqlite, github) and README instructions for adding any MCP server from the ecosystem. Settings shows each configured MCP server with an enable/disable toggle.
- Agent loop: user command → agent observes (screenshot or tool results) → decides next tool call → acts → repeats until done or user pauses/stops. Every step → Activity log (SQLite) + WebSocket broadcast so the Desktop tab updates live.

ARCHITECTURE:
- Backend: Express (or Fastify) + WebSocket (ws). REST: POST /api/chat (streaming), /api/desktop/stream, /api/activity, /api/settings. Serves the built frontend.
- Frontend: keep it light (plain TS or minimal framework — your judgment; the ChatGPT look is non-negotiable).
- SQLite (better-sqlite3 or node:sqlite): conversations, messages, activity_log, settings.
- Port: PORT env var, default 3456.

WINDOWS COMPATIBILITY — CRITICAL, YOU ARE ON LINUX:
- ALL Windows-only code in src/win/, guarded by process.platform === 'win32'. `npm run build` and `npm start` MUST succeed on this Linux box: on non-Windows, win tools return a clear "Windows only" stub and the Desktop tab shows a placeholder instead of crashing.
- Write TESTING.md: exact steps to verify computer control on a real Windows PC.

USE SUBAGENTS: this is a large build — split it across parallel subagent workstreams (frontend UI / backend+agent / windows-control layer / server-tools+MCP / packaging+docs), then integrate. You are the coordinator: keep the ChatGPT look and the architecture consistent across everything.

CONSTRAINTS:
- Free-tier models only, always.
- Don't touch anything outside ~/otto.
- Minimal, documented dependencies.

ACCEPTANCE CRITERIA (verified on this Linux box):
- npm install && npm run build && npm start succeeds; http://localhost:3456 loads.
- Chat tab is ChatGPT-style (sidebar, centered chat, composer, footer), light + dark mode, usable at phone width.
- Desktop / Activity / Settings tabs render with the contents specified above.
- With GOOGLE_API_KEY set, POST /api/chat streams a real Gemini reply and persists the conversation.
- With no key, the "API key not set" state shows; nothing crashes.
- src/win/* exists, is platform-guarded, app starts cleanly on Linux.
- Settings toggles exist for every tool group (Windows GUI, server files, server shell, each MCP server) — all default OFF except chat; the agent refuses gated tools until enabled.
- README.md: what Otto is, env vars, architecture overview, Windows run steps (install Node 20+, npm install, set GOOGLE_API_KEY, npm start), phone access (same WiFi as the PC, or Tailscale), MCP setup with a concrete example.
- TESTING.md: Windows smoke test steps.
- `npm run package` produces otto-windows.zip with everything needed (source + package.json, NO node_modules — Windows does its own npm install for native modules).
