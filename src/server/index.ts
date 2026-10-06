/**
 * Server tool registry. Each tool declares the Settings toggle that gates it.
 * All non-chat capabilities default to OFF; the agent refuses a gated tool
 * until the user enables it in Settings.
 */
import type { ToolResult } from './types.js';
import { list_dir, read_file, resolveInsideRoot, write_file, type WriteOpts } from './files.js';
import { run_command, type RunOptions } from './shell.js';
import { listMcpServers, loadMcpTools, closeAllMcpClients } from '../mcp/loader.js';

export type { ToolResult } from './types.js';
export { read_file, write_file, list_dir, run_command, resolveInsideRoot };

/** MCP tools are namespaced `mcp__<server>__<tool>` to avoid collisions. */
export interface RegisteredServerTool {
  name: string;
  fn: (...args: unknown[]) => Promise<ToolResult>;
  /** `fileAccess`, `shell`, or `mcp:<server>` for MCP tools. */
  requiresToggle: string;
  alwaysConfirm?: boolean;
  description: string;
  source: 'builtin' | 'mcp';
  server?: string;
}

export const serverTools: RegisteredServerTool[] = [
  {
    name: 'read_file',
    fn: (...a: unknown[]) => read_file(String(a[0] ?? '')),
    requiresToggle: 'fileAccess',
    description: 'Read a UTF-8 text file from the Otto workspace (max 1 MB).',
    source: 'builtin',
  },
  {
    name: 'write_file',
    fn: (...a: unknown[]) => write_file(String(a[0] ?? ''), String(a[1] ?? ''), (a[2] as WriteOpts) ?? {}),
    requiresToggle: 'fileAccess',
    description: 'Write a UTF-8 text file in the Otto workspace. Requires confirmation unless File access writes are allowed in Settings.',
    source: 'builtin',
  },
  {
    name: 'list_dir',
    fn: (...a: unknown[]) => list_dir(typeof a[0] === 'string' && a[0] ? a[0] : '.'),
    requiresToggle: 'fileAccess',
    description: 'List the contents of a directory in the Otto workspace.',
    source: 'builtin',
  },
  {
    name: 'run_command',
    fn: (...a: unknown[]) => run_command(typeof a[0] === 'string' ? a[0] : '', (a[1] as RunOptions) ?? {}),
    requiresToggle: 'shell',
    alwaysConfirm: true,
    description: 'Run a shell command on the Otto host. ALWAYS requires explicit per-command confirmation.',
    source: 'builtin',
  },
];

/** Built-in tools + every enabled MCP server's tools. */
export async function getActiveServerTools(): Promise<RegisteredServerTool[]> {
  const mcp = await loadMcpTools();
  return [...serverTools, ...mcp];
}

export { listMcpServers, closeAllMcpClients };

export async function runServerTool(name: string, args: unknown[]): Promise<ToolResult> {
  const all = await getActiveServerTools();
  const tool = all.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  try {
    return await tool.fn(...args);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}