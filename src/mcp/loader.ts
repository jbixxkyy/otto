/**
 * MCP client loader.
 *
 * Reads mcp.json -> { mcpServers: { <name>: { command, args, env, description } } }
 * and connects to each server that is ENABLED in Settings (settings key
 * `mcp:<name>`, default OFF). Tools are exposed to the agent as
 * `mcp__<server>__<tool>`.
 *
 * Transport is stdio, spawned directly (no shell), so nothing in mcp.json can
 * be interpreted by a shell.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getBoolSetting } from '../db.js';
import type { RegisteredServerTool } from '../server/index.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
}

export interface McpServerInfo {
  name: string;
  description: string;
  command: string;
  args: string[];
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpClient {
  connect(transport: unknown): Promise<void>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: McpToolDef[] }>;
  close(): Promise<void>;
}

const clients = new Map<string, McpClient>();
const toolCache = new Map<string, RegisteredServerTool[]>();

export function mcpConfigPath(): string {
  return process.env.OTTO_MCP_CONFIG
    ? path.resolve(process.env.OTTO_MCP_CONFIG)
    : path.join(process.cwd(), 'mcp.json');
}

export async function readMcpConfig(): Promise<Record<string, McpServerConfig>> {
  const file = mcpConfigPath();
  if (!existsSync(file)) return {};
  try {
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'mcpServers' in parsed) {
      const servers = (parsed as { mcpServers: unknown }).mcpServers;
      if (servers && typeof servers === 'object') return servers as Record<string, McpServerConfig>;
    }
  } catch {
    /* invalid mcp.json -> treated as "no servers" */
  }
  return {};
}

/** For the Settings screen: every configured server with its enable state. */
export async function listMcpServers(): Promise<McpServerInfo[]> {
  const config = await readMcpConfig();
  const out: McpServerInfo[] = [];
  for (const [name, cfg] of Object.entries(config)) {
    const cached = toolCache.get(name);
    out.push({
      name,
      description: cfg.description ?? '',
      command: cfg.command,
      args: cfg.args ?? [],
      enabled: getBoolSetting(`mcp:${name}`, false),
      connected: clients.has(name),
      toolCount: cached?.length ?? 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function connect(server: string, cfg: McpServerConfig): Promise<McpClient | null> {
  const existing = clients.get(server);
  if (existing) return existing;
  if (!cfg.command) return null;

  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    const transport = new StdioClientTransport({
      // npm ships npx as a .cmd shim on Windows; spawning the bare name fails there.
      command: process.platform === 'win32' && /^npx(\.cmd)?$/i.test(cfg.command) ? 'npx.cmd' : cfg.command,
      args: cfg.args ?? [],
      env: { ...(cfg.env ?? {}) } as Record<string, string>,
      cwd: process.cwd(),
      stderr: 'ignore',
    });
    const client = new Client({ name: 'otto', version: '0.1.0' }, { capabilities: {} }) as unknown as McpClient;
    await client.connect(transport as never);
    clients.set(server, client);
    return client;
  } catch (err) {
    console.warn(`[mcp] could not start server "${server}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Connect to every ENABLED server and wrap its tools for the agent. */
export async function loadMcpTools(): Promise<RegisteredServerTool[]> {
  const config = await readMcpConfig();
  const all: RegisteredServerTool[] = [];

  for (const [server, cfg] of Object.entries(config)) {
    if (!getBoolSetting(`mcp:${server}`, false)) continue;

    const client = await connect(server, cfg);
    if (!client) continue;

    let defs: McpToolDef[] = [];
    try {
      defs = (await client.listTools()).tools ?? [];
    } catch {
      defs = [];
    }

    const wrapped: RegisteredServerTool[] = defs.map((def) => ({
      name: `mcp__${server}__${def.name}`,
      requiresToggle: `mcp:${server}`,
      alwaysConfirm: false,
      description: `[MCP:${server}] ${def.description ?? def.name}`,
      source: 'mcp' as const,
      server,
      fn: async (...args: unknown[]) => {
        const payload = normaliseArgs(def, args);
        try {
          const res = await client.callTool({ name: def.name, arguments: payload });
          return { ok: true, data: res };
        } catch (err) {
          return { ok: false, error: `MCP ${server}/${def.name} failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    }));

    toolCache.set(server, wrapped);
    all.push(...wrapped);
  }

  return all;
}

/**
 * MCP servers are called with an object of arguments. Otto's agent passes a
 * single JSON object when it provides one, otherwise positional values are
 * matched onto the tool's declared input properties.
 */
function normaliseArgs(def: McpToolDef, args: unknown[]): Record<string, unknown> {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return args[0] as Record<string, unknown>;
  }
  const schema = def.inputSchema as { properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties ? Object.keys(schema.properties) : [];
  const out: Record<string, unknown> = {};
  args.forEach((value, i) => {
    const key = props[i];
    if (key) out[key] = value;
  });
  if (out.path === undefined && typeof args[0] === 'string') out.path = args[0];
  return out;
}

export async function closeAllMcpClients(): Promise<void> {
  for (const [name, client] of clients) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    clients.delete(name);
  }
  toolCache.clear();
}