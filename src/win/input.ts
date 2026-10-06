/**
 * Windows mouse + keyboard control.
 *
 * Primary backend : @nut-tree/nut-js (see types.ts for the justification)
 * Fallback backend: PowerShell SendKeys / user32 P/Invoke for key combos
 *
 * Every function is platform-guarded and never throws - on Linux they return a
 * clear "Windows only" stub so `npm start` works on this box.
 */
import { isWindows } from './platform.js';
import { execFile } from 'node:child_process';
import { loadOptional, pickFunction, errText } from './screenshot.js';
import type { ToolResult } from './types.js';

const MAX_TEXT = 5000;

const windowsOnly = (tool: string): ToolResult => ({
  ok: false,
  error: `Windows only: ${tool} requires process.platform === "win32" (current: ${process.platform})`,
});

type AnyFn = (...args: unknown[]) => Promise<unknown>;

async function nutModule(): Promise<Record<string, unknown> | null> {
  const mod = loadOptional('@nut-tree/nut-js');
  return mod && typeof mod === 'object' ? (mod as Record<string, unknown>) : null;
}

async function member<T>(name: string): Promise<T | null> {
  const mod = await nutModule();
  if (!mod) return null;
  const v = mod[name];
  return (v ?? null) as T | null;
}

// ---------------------------------------------------------------- mouse_move
export async function mouse_move(x: unknown, y: unknown): Promise<ToolResult> {
  if (!isWindows) return windowsOnly('mouse_move');
  const px = toFinite(x);
  const py = toFinite(y);
  if (px === null || py === null) return { ok: false, error: 'mouse_move requires finite numeric x and y' };
  if (px < 0 || py < 0) return { ok: false, error: 'mouse_move coordinates must be >= 0' };

  try {
    const mouse = (await member<Record<string, unknown>>('mouse')) as Record<string, AnyFn> | null;
    const setPosition = pickFunction(mouse, ['setPosition']);
    if (!setPosition) return { ok: false, error: 'mouse_move: nut-js mouse backend unavailable' };
    await setPosition(px, py);
    return { ok: true, data: { x: px, y: py } };
  } catch (err) {
    return { ok: false, error: `mouse_move failed: ${errText(err)}` };
  }
}

// ---------------------------------------------------------------- click
export async function click(button: unknown = 'left'): Promise<ToolResult> {
  if (!isWindows) return windowsOnly('click');
  const btn = typeof button === 'string' ? button.toLowerCase() : 'left';
  const methodName = btn === 'right' ? 'rightClick' : btn === 'middle' ? 'middleClick' : 'leftClick';
  if (!['left', 'right', 'middle'].includes(btn)) {
    return { ok: false, error: `click: unsupported button "${String(button)}" (use left|right|middle)` };
  }
  try {
    const mouse = (await member<Record<string, unknown>>('mouse')) as Record<string, AnyFn> | null;
    const fn = pickFunction(mouse, [methodName]);
    if (!fn) return { ok: false, error: `click: nut-js mouse.${methodName} unavailable` };
    await fn();
    return { ok: true, data: { button: btn } };
  } catch (err) {
    return { ok: false, error: `click failed: ${errText(err)}` };
  }
}

// ---------------------------------------------------------------- type_text
export async function type_text(text: unknown): Promise<ToolResult> {
  if (!isWindows) return windowsOnly('type_text');
  if (typeof text !== 'string') return { ok: false, error: 'type_text requires a string' };
  if (text.length > MAX_TEXT) return { ok: false, error: `type_text: text too long (max ${MAX_TEXT} chars)` };

  try {
    const keyboard = (await member<Record<string, unknown>>('keyboard')) as Record<string, AnyFn> | null;
    const fn = pickFunction(keyboard, ['type', 'typeString']);
    if (fn) {
      await fn(text);
      return { ok: true, data: { chars: text.length } };
    }
    return { ok: false, error: 'type_text: nut-js keyboard backend unavailable' };
  } catch (err) {
    return { ok: false, error: `type_text failed: ${errText(err)}` };
  }
}

// ---------------------------------------------------------------- press_key
export interface ParsedCombo {
  modifiers: string[];
  key: string;
}

const MODIFIER_MAP: Record<string, string> = {
  ctrl: 'LEFT_CONTROL',
  control: 'LEFT_CONTROL',
  alt: 'LEFT_ALT',
  shift: 'LEFT_SHIFT',
  win: 'LEFT_META',
  meta: 'LEFT_META',
  cmd: 'LEFT_META',
  super: 'LEFT_META',
};

const SENDKEYS_MAP: Record<string, string> = {
  LEFT_CONTROL: '^',
  LEFT_ALT: '%',
  LEFT_SHIFT: '+',
  LEFT_META: '#',
};

const NAMED_KEYS: Record<string, string> = {
  enter: 'ENTER',
  return: 'ENTER',
  esc: 'ESCAPE',
  escape: 'ESCAPE',
  tab: 'TAB',
  space: 'SPACE',
  backspace: 'BACKSPACE',
  delete: 'DELETE',
  del: 'DELETE',
  insert: 'INSERT',
  home: 'HOME',
  end: 'END',
  pageup: 'PAGE_UP',
  pagedown: 'PAGE_DOWN',
  up: 'UP',
  down: 'DOWN',
  left: 'LEFT',
  right: 'RIGHT',
};

/** "ctrl+c" | "ctrl+shift+t" | "enter" -> modifiers + key */
export function parseCombo(combo: unknown): ParsedCombo | null {
  if (typeof combo !== 'string') return null;
  const cleaned = combo.trim().toLowerCase();
  if (!cleaned) return null;
  const parts = cleaned.split(/[+\-]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers: string[] = [];
  let key = '';
  for (const part of parts) {
    const mod = MODIFIER_MAP[part];
    if (mod) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
    } else if (!key) {
      key = part;
    } else {
      return null; // two non-modifier keys is not a combo
    }
  }
  if (!key) return null;

  const named = NAMED_KEYS[key];
  const resolvedKey = named ?? (/^f([1-9]|1[0-2])$/.test(key) ? key.toUpperCase() : key.length === 1 ? key : key.toUpperCase());
  return { modifiers, key: resolvedKey };
}

export async function press_key(combo: unknown): Promise<ToolResult> {
  if (!isWindows) return windowsOnly('press_key');
  const parsed = parseCombo(combo);
  if (!parsed) return { ok: false, error: `press_key: cannot parse combo "${String(combo)}" (try "ctrl+c")` };

  try {
    const keyboard = (await member<Record<string, unknown>>('keyboard')) as Record<string, AnyFn> | null;
    const pressKeyFn = pickFunction(keyboard, ['pressKey']);
    if (pressKeyFn) {
      const keys = [...parsed.modifiers, parsed.key];
      await pressKeyFn(...keys);
      return { ok: true, data: { combo: String(combo), keys } };
    }
  } catch {
    // fall through to SendKeys
  }

  // Fallback: PowerShell SendKeys (^ = ctrl, % = alt, + = shift, # = win)
  try {
    const sendKeys =
      parsed.key.length === 1 ? parsed.key : `{${parsed.key.toUpperCase()}}`;
    const prefix = parsed.modifiers.map((m) => SENDKEYS_MAP[m] ?? '').join('');
    await runPowerShell(
      `$w=New-Object -ComObject WScript.Shell;` +
        `Start-Sleep -Milliseconds 60;` +
        `$w.SendKeys('${prefix}${sendKeys}');`,
    );
    return { ok: true, data: { combo: String(combo), backend: 'sendkeys' } };
  } catch (err) {
    return { ok: false, error: `press_key failed: ${errText(err)}` };
  }
}

// ---------------------------------------------------------------- helpers
function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

function toFinite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}