/**
 * Wraps Otto's own tool registries into ADK `FunctionTool`s.
 *
 * Every tool is gated twice:
 *   1. its Settings toggle must be ON (mouse / keyboard / screen / openApps /
 *      fileAccess / shell / mcp:<server>) - all default OFF;
 *   2. sensitive tools (run_command, file writes) require an explicit
 *      per-call confirmation over the WebSocket before they execute.
 *
 * Toggle state is read at call time, so flipping a switch in Settings takes
 * effect on the very next tool call without restarting the agent.
 */
import { FunctionTool } from "@google/adk";
import type { Schema } from "@google/genai";
import { winTools, runWinTool, isWindows } from "../win/index.js";
import { getActiveServerTools, runServerTool } from "../server/index.js";
import { getBoolSetting } from "../db.js";
import { askConfirmation, isStopped } from "./control.js";
import type { RegisteredTool } from "../win/types.js";
import type { RegisteredServerTool } from "../server/index.js";

/** Every toggle the agent may consult, with the human label Settings shows. */
export const TOGGLE_LABELS: Record<string, string> = {
  mouse: 'Computer control > Mouse',
  keyboard: 'Computer control > Keyboard',
  screen: 'Computer control > Screen viewing',
  openApps: 'Computer control > Open apps',
  fileAccess: 'Server tools > File access',
  shell: 'Server tools > Shell',
};

export function toggleEnabled(key: string): boolean {
  return getBoolSetting(key, false);
}

const obj = (properties: Schema['properties'], required: string[] = []): Schema =>
  ({ type: 'object' as never, properties, required }) as unknown as Schema;

// --- JSON schemas ------------------------------------------------------------
const winSchemas: Record<string, Schema> = {
  screenshot: obj({}, []),
  mouse_move: obj(
    {
      x: { type: 'integer' as never, description: 'Absolute X pixel on the primary display' },
      y: { type: 'integer' as never, description: 'Absolute Y pixel on the primary display' },
    },
    ['x', 'y'],
  ),
  click: obj({
    button: { type: 'string' as never, enum: ['left', 'right', 'middle'], description: 'Which mouse button to click' },
  }),
  type_text: obj({ text: { type: 'string' as never, description: 'Text to type into the focused window' } }, ['text']),
  press_key: obj({
    combo: { type: 'string' as never, description: 'Key combo, e.g. "ctrl+c", "enter", "alt+tab"' },
  }, ['combo']),
  open_app: obj({ name: { type: 'string' as never, description: 'Application name, e.g. "notepad"' } }, ['name']),
};

const serverSchemas: Record<string, Schema> = {
  read_file: obj({ path: { type: 'string' as never, description: 'File path relative to the Otto workspace' } }, ['path']),
  write_file: obj(
    {
      path: { type: 'string' as never, description: 'File path relative to the Otto workspace' },
      content: { type: 'string' as never, description: 'Full file content to write' },
    },
    ['path', 'content'],
  ),
  list_dir: obj({ path: { type: 'string' as never, description: 'Directory path (default ".")' } }),
  run_command: obj(
    { command: { type: 'string' as never, description: 'Shell command to run on the Otto host' } },
    ['command'],
  ),
};

function args(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function refusal(tool: string, toggle: string): string {
  return (
    `${tool} is disabled. The operator has to turn on "${TOGGLE_LABELS[toggle] ?? toggle}" in Otto's Settings > ` +
    `tool toggles before Otto may use it. Tell the user it is switched off, and do not try again.`
  );
}

/** FunctionTool for one Windows GUI tool. */
function winFunctionTool(tool: RegisteredTool): FunctionTool {
  return new FunctionTool({
    name: tool.name,
    description: `${tool.description} Requires the "${TOGGLE_LABELS[tool.requiresToggle] ?? tool.requiresToggle}" toggle to be ON.`,
    parameters: winSchemas[tool.name] ?? obj({}),
    execute: async (input: unknown) => {
      if (isStopped()) return { ok: false, error: 'The agent was stopped before this tool ran.' };
      if (!toggleEnabled(tool.requiresToggle)) {
        return { ok: false, error: refusal(tool.name, tool.requiresToggle) };
      }
      const a = args(input);
      switch (tool.name) {
        case 'screenshot':
          return runWinTool('screenshot', []);
        case 'mouse_move':
          return runWinTool('mouse_move', [a.x, a.y]);
        case 'click':
          return runWinTool('click', [a.button ?? 'left']);
        case 'type_text':
          return runWinTool('type_text', [a.text]);
        case 'press_key':
          return runWinTool('press_key', [a.combo]);
        case 'open_app':
          return runWinTool('open_app', [a.name]);
        default:
          return { ok: false, error: `unhandled tool ${tool.name}` };
      }
    },
  });
}

/** FunctionTool for one server/MCP tool, including confirmation handling. */
function serverFunctionTool(tool: RegisteredServerTool): FunctionTool {
  const schema =
    tool.source === 'mcp'
      ? obj({ arguments: { type: 'object' as never, description: 'Arguments object forwarded to the MCP tool' } })
      : serverSchemas[tool.name] ?? obj({});

  return new FunctionTool({
    name: tool.name,
    description: `${tool.description} Requires the "${tool.requiresToggle}" toggle to be ON.${
      tool.alwaysConfirm ? ' Requires explicit confirmation before it runs.' : ''
    }`,
    parameters: schema,
    execute: async (input: unknown) => {
      if (isStopped()) return { ok: false, error: 'The agent was stopped before this tool ran.' };
      if (!toggleEnabled(tool.requiresToggle)) {
        return {
          ok: false,
          error: tool.source === 'mcp'
            ? `The MCP server "${tool.server}" is disabled. Ask the user to enable it in Settings > MCP servers.`
            : refusal(tool.name, tool.requiresToggle),
        };
      }

      const a = args(input);

      // run_command: NEVER silent. Confirmation is mandatory.
      if (tool.name === 'run_command') {
        const command = String(a.command ?? '');
        const approved = await askConfirmation({ tool: 'run_command', detail: command });
        if (!approved) return { ok: false, error: 'The user declined to run that command. Do not retry it.' };
        return runServerTool('run_command', [command, { confirmed: true }]);
      }

      // write_file: confirm unless the operator allowed unconfirmed writes.
      if (tool.name === 'write_file') {
        const allowWrite = getBoolSetting('allowWrites', false);
        const confirmed = allowWrite
          ? true
          : await askConfirmation({ tool: 'write_file', detail: `${String(a.path)} (${String(a.content ?? '').length} bytes)` });
        if (!confirmed) return { ok: false, error: 'The user declined that file write. Do not retry it.' };
        return runServerTool('write_file', [a.path, a.content, { confirmed: true }]);
      }

      if (tool.source === 'mcp') {
        return runServerTool(tool.name, [a.arguments ?? a]);
      }
      if (tool.name === 'read_file') return runServerTool('read_file', [a.path]);
      if (tool.name === 'list_dir') return runServerTool('list_dir', [a.path ?? '.']);
      return { ok: false, error: `unhandled tool ${tool.name}` };
    },
  });
}

/**
 * Every tool the agent may call right now: Windows GUI tools + server tools +
 * tools from the MCP servers that are enabled in Settings.
 */
export async function buildAgentTools(): Promise<FunctionTool[]> {
  const tools: FunctionTool[] = winTools.map(winFunctionTool);
  for (const tool of await getActiveServerTools()) {
    tools.push(serverFunctionTool(tool));
  }
  return tools;
}

export function toolInventoryDoc(): string {
  const win = winTools.map((t) => `- ${t.name} (needs ${t.requiresToggle})`).join(', ');
  const srv = ['read_file', 'write_file', 'list_dir', 'run_command']
    .map((n) => `- ${n} (needs ${n === 'run_command' ? 'shell' : 'fileAccess'})`)
    .join(', ');
  return `Windows tools: ${win}\nServer tools: ${srv}\nMCP tools are added when a server is enabled in Settings.`;
}

export { isWindows };