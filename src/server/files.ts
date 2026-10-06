/**
 * Server-side file tools. REAL implementations, always scoped to Otto's working
 * directory (process.cwd()) so the agent cannot wander into /etc or C:\Windows.
 *
 * Writes require explicit confirmation unless the user has turned the
 * "File access" toggle on with writes allowed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "../shared/tool-result.js";

const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_ENTRIES = 500;

export const SERVER_ROOT = process.cwd();

/** Resolve a user/agent path, refusing anything that escapes SERVER_ROOT. */
export function resolveInsideRoot(p: string): { ok: true; abs: string } | { ok: false; error: string } {
  if (typeof p !== "string" || !p.trim()) return { ok: false, error: "path is required" };
  if (p.includes("\0")) return { ok: false, error: "path contains a null byte" };
  const abs = path.resolve(SERVER_ROOT, p);
  const rel = path.relative(SERVER_ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `Path "${p}" is outside Otto's working directory (${SERVER_ROOT}). Access denied.` };
  }
  return { ok: true, abs };
}

export async function read_file(p: string): Promise<ToolResult<{ path: string; content: string; bytes: number }>> {
  const resolved = resolveInsideRoot(p);
  if (!resolved.ok) return resolved;
  try {
    const stat = await fs.stat(resolved.abs);
    if (stat.isDirectory()) return { ok: false, error: `"${p}" is a directory - use list_dir` };
    if (stat.size > MAX_BYTES) return { ok: false, error: `File is ${stat.size} bytes, over the ${MAX_BYTES} byte read limit` };
    const buf = await fs.readFile(resolved.abs);
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, error: `"${p}" looks binary - refusing to read as text` };
    return { ok: true, data: { path: p, content: buf.toString("utf8"), bytes: stat.size } };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

export interface WriteOpts {
  /** Set by the agent loop only after the user approved this exact write. */
  confirmed?: boolean;
  /** Set when the user disabled write confirmation in Settings. */
  allowWrite?: boolean;
}

export async function write_file(
  p: string,
  content: string,
  opts: WriteOpts = {},
): Promise<ToolResult<{ path: string; bytes: number }>> {
  if (!opts.confirmed && !opts.allowWrite) {
    return { ok: false, error: "confirmation required - file writes need explicit approval" };
  }
  if (typeof content !== "string") return { ok: false, error: "content must be a string" };
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return { ok: false, error: `content over the ${MAX_BYTES} byte write limit` };
  const resolved = resolveInsideRoot(p);
  if (!resolved.ok) return resolved;
  try {
    await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
    await fs.writeFile(resolved.abs, content, "utf8");
    return { ok: true, data: { path: p, bytes: Buffer.byteLength(content, "utf8") } };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

export async function list_dir(p = "."): Promise<ToolResult<{ path: string; entries: { name: string; type: string; size: number }[] }>> {
  const resolved = resolveInsideRoot(p);
  if (!resolved.ok) return resolved;
  try {
    const dirents = await fs.readdir(resolved.abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.slice(0, MAX_ENTRIES).map(async (d) => {
        let size = 0;
        if (d.isFile()) {
          try {
            size = (await fs.stat(path.join(resolved.abs, d.name))).size;
          } catch {
            size = 0;
          }
        }
        return { name: d.name, type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other", size };
      }),
    );
    return { ok: true, data: { path: p, entries } };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}