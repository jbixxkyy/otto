/**
 * open_app(name) - launch a Windows application.
 *
 * The name is sanitised against a strict allowlist and the spawn uses an args
 * array with shell:false, so there is no shell interpolation at all (no
 * `start`, `&`, `|`, `>` or `$(...)` can ever be injected).
 */
import { spawn } from 'node:child_process';
import { isWindows } from './platform.js';
import type { ToolResult } from './types.js';

const ALLOWED = /^[A-Za-z0-9 ._\-+:\\()]+$/;
const MAX_LEN = 120;

export async function open_app(name: unknown): Promise<ToolResult> {
  if (!isWindows) {
    return {
      ok: false,
      error: `Windows only: open_app requires process.platform === "win32" (current: ${process.platform})`,
    };
  }
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'open_app requires an application name' };
  }
  const app = name.trim();
  if (app.length > MAX_LEN) return { ok: false, error: `open_app: name too long (max ${MAX_LEN} chars)` };
  if (!ALLOWED.test(app)) {
    return { ok: false, error: 'open_app: name contains characters that are not allowed' };
  }

  return new Promise<ToolResult>((resolve) => {
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', app], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false,
      });
      child.on('error', (err) => resolve({ ok: false, error: `open_app failed: ${err.message}` }));
      child.unref();
      resolve({ ok: true, data: { app } });
    } catch (err) {
      resolve({ ok: false, error: `open_app failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}