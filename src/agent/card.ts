/**
 * A2A agent card.
 *
 * Otto is structured so it can be published as an A2A (agent-to-agent) agent
 * later: the card below is the standard discovery document, and the loop is
 * exposed through `POST /a2a` (JSON-RPC `message/send` + `message/stream`),
 * backed by the same Otto agent the Chat tab uses.
 *
 * @google/adk ships the A2A server toolkit (`@google/adk/a2a`, backed by
 * @a2a-js/sdk) - see README for how to mount Otto's card on a real A2A route.
 */
export const AGENT_CARD = {
  name: "otto",
  version: "0.1.0",
  description:
    "Otto - a free-tier (Google Gemini) assistant that can chat, and - when explicitly enabled in Settings - control a Windows desktop, read/write files on its host, run approved shell commands, and call MCP servers.",
  url: "http://localhost:3456/a2a",
  protocolVersion: "0.3.0",
  preferredTransport: "JSONRPC",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "chat",
      name: "Chat",
      description: "Answer questions using free-tier Google models (gemini-flash-latest by default).",
      tags: ["chat", "free-tier"],
      examples: ["Explain quantum tunneling simply", "Summarise this text"],
    },
    {
      id: "computer-control",
      name: "Computer control (Windows)",
      description:
        "Observe the primary display with screenshots and act on it: move the mouse, click, type, press keys, open apps. Gated by the Mouse / Keyboard / Screen / Open apps toggles.",
      tags: ["windows", "gui", "gated"],
      examples: ["Open Chrome and go to example.com", "Click the button at 640,480"],
    },
    {
      id: "server-tools",
      name: "Server tools",
      description:
        "Read, write and list files inside Otto's workspace, and run shell commands - shell always requires per-command confirmation.",
      tags: ["files", "shell", "gated"],
      examples: ["List the files in data/", "Run `git status`"],
    },
    {
      id: "mcp",
      name: "MCP servers",
      description: "Call tools exposed by any MCP server configured in mcp.json and enabled in Settings.",
      tags: ["mcp", "gated"],
      examples: ["List my GitHub issues"],
    },
  ],
  securitySchemes: {
    // Otto is intended for a trusted LAN/Tailscale network; the Google key is
    // only ever read from the environment, never from a request.
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "x-otto-token",
      description: "Optional shared token if you expose Otto beyond your LAN.",
    },
  },
} as const;

export type OttoAgentCard = typeof AGENT_CARD;