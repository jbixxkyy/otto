/**
 * Public surface of the Windows control layer.
 *
 * Every tool is registered with the Settings toggle that gates it, so the agent
 * loop can refuse a tool before it is ever executed:
 *   screenshot -> screen, mouse_move/click -> mouse,
 *   type_text/press_key -> keyboard, open_app -> openApps
 */
import type { RegisteredTool, ToolResult, WinToggle } from './types.js';
import { screenshot } from './screenshot.js';
import { click, mouse_move, parseCombo, press_key, type_text } from './input.js';
import { open_app } from './apps.js';

export { isWindows } from './platform.js';
export { screenshot } from './screenshot.js';
export { mouse_move, click, type_text, press_key, parseCombo } from './input.js';
export { open_app } from './apps.js';
export type { ToolResult, WinToggle, RegisteredTool } from './types.js';

export const winTools: RegisteredTool[] = [
  { name: 'screenshot', fn: (...a: unknown[]) => screenshot(), requiresToggle: 'screen', description: 'Capture the primary display as a PNG.' },
  { name: 'mouse_move', fn: (...a: unknown[]) => mouse_move(a[0], a[1]), requiresToggle: 'mouse', description: 'Move the mouse to absolute x,y on the primary display.' },
  { name: 'click', fn: (...a: unknown[]) => click(a[0]), requiresToggle: 'mouse', description: 'Click the mouse (left|right|middle).' },
  { name: 'type_text', fn: (...a: unknown[]) => type_text(a[0]), requiresToggle: 'keyboard', description: 'Type text into the focused window.' },
  { name: 'press_key', fn: (...a: unknown[]) => press_key(a[0]), requiresToggle: 'keyboard', description: 'Press a key combo, e.g. "ctrl+c".' },
  { name: 'open_app', fn: (...a: unknown[]) => open_app(a[0]), requiresToggle: 'openApps', description: 'Launch an installed application by name.' },
];

/** Description block handed to the agent so it knows what the tools can do. */
export const winToolDocs = winTools
  .map((t) => `- ${t.name}: ${t.description}`)
  .join('\n');

/** Convenience for the agent loop: run a tool by name, never throwing. */
export async function runWinTool(name: string, args: unknown[]): Promise<ToolResult> {
  const tool = winTools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `unknown Windows tool: ${name}` };
  try {
    return await tool.fn(...args);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}