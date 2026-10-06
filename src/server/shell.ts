/**
 * run_command - the ONLY way Otto can touch the host shell.
 *
 * HARD RULE: it never executes without explicit per-command confirmation.
 * `opts.confirmed === true` is set exclusively by the confirmation flow in the
 * agent loop (after the user clicks Approve in the UI).
 */
import { exec } from 'node:child_process';
import path from 'node:path';
import type { ToolResult } from './types.js';

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 512 * 1024;
const MAX_CMD = 2000;

export interface RunOptions {
  confirmed?: boolean;
}

/** A deliberately small env: Otto's own secrets (e.g. GOOGLE_API_KEY) are NOT
 *  forwarded to spawned commands. */
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'PATHEXT'];

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.OTTO_SPAWNED = '1';
  return env;
}

export async function run_command(command: unknown, opts: RunOptions = {}): Promise<ToolResult> {
  if (opts.confirmed !== true) {
    return {
      ok: false,
      error: 'confirmation required: run_command always needs explicit approval before it executes anything',
    };
  }
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'run_command requires a command string' };
  }
  if (command.length > MAX_CMD) {
    return { ok: false, error: `command too long (${command.length} chars, max ${MAX_CMD})` };
  }

  return new Promise<ToolResult>((resolve) => {
    exec(
      command,
      { cwd: process.cwd(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: safeEnv(), windowsHide: true },
      (err, stdout, stderr) => {
        const exitCode = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({
          ok: exitCode === 0,
          data: {
            command,
            cwd: path.relative(process.cwd(), process.cwd()) || '.',
            exitCode,
            stdout: String(stdout).slice(0, MAX_BUFFER),
            stderr: String(stderr).slice(0, MAX_BUFFER),
          },
          error: err ? `command exited with code ${exitCode}` : undefined,
        });
      },
    );
  });
}