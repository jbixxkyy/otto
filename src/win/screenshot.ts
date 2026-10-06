import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { isWindows } from './platform.js';
import type { ToolResult } from './types.js';

/**
 * Capture the PRIMARY display as a PNG buffer.
 *
 * Strategy:
 *  1. PowerShell + System.Drawing (primary). Zero extra dependencies, present on
 *     every Windows 10/11 box, returns base64 PNG on stdout.
 *  2. screenshot-desktop (optional dependency) when it is installed - faster,
 *     used only as a fallback.
 *
 * Never throws: every failure is returned as { ok:false, error }.
 */
export async function screenshot(): Promise<ToolResult> {
  if (!isWindows) {
    return { ok: false, error: 'Windows only: screenshot requires process.platform === "win32"' };
  }

  // 1) Dependency-free PowerShell capture of the primary screen.
  try {
    const base64 = await captureViaPowerShell();
    if (base64.length > 0) {
      return { ok: true, png: Buffer.from(base64, 'base64') };
    }
  } catch (err) {
    // fall through to the optional dependency
  }

  // 2) Optional screenshot-desktop.
  try {
    const mod = loadOptional('screenshot-desktop');
    if (mod) {
      const buf = await invokeScreenshotDesktop(mod);
      if (buf && buf.length > 0) return { ok: true, png: buf };
    }
  } catch (err) {
    return { ok: false, error: `screenshot failed: ${errText(err)}` };
  }

  return { ok: false, error: 'screenshot failed: no capture backend available' };
}

function captureViaPowerShell(): Promise<string> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
    '$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height);',
    '$g=[System.Drawing.Graphics]::FromImage($b);',
    '$g.CopyFromScreen($s.Location,[System.Drawing.CopyPixelOperation]::SourceCopy,$s.Size);',
    '$ms=New-Object System.IO.MemoryStream;',
    '$b.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);',
    '[Convert]::ToBase64String($ms.ToArray())',
  ].join(' ');

  return new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout).trim());
      },
    );
  });
}

/** screenshot-desktop exposes either a default export or `.default`. */
async function invokeScreenshotDesktop(mod: unknown): Promise<Buffer | null> {
  const fn = pickFunction(mod, ['default', 'screenshot']);
  if (!fn) return null;
  const out = await fn({ format: 'png' });
  if (Buffer.isBuffer(out)) return out;
  if (typeof out === 'string') return Buffer.from(out, 'base64');
  if (out && typeof out === 'object') {
    const inner = (out as Record<string, unknown>).image;
    if (typeof inner === 'string') return Buffer.from(inner, 'base64');
  }
  return null;
}

const require_ = createRequire(import.meta.url);

export function loadOptional(specifier: string): unknown {
  try {
    return require_(specifier);
  } catch {
    return null;
  }
}

export function pickFunction(mod: unknown, names: string[]): ((...args: unknown[]) => Promise<unknown>) | null {
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
  const bag = mod as Record<string, unknown>;
  for (const name of names) {
    const candidate = bag[name];
    if (typeof candidate === 'function') {
      return (candidate as (...args: unknown[]) => Promise<unknown>).bind(mod);
    }
  }
  return null;
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}