/**
 * Shared tool result + types for the Windows control layer.
 *
 * Library choice (justified in README): @nut-tree/nut-js for mouse/keyboard.
 * It is actively maintained, has a pure-JS API over the native libnut driver,
 * prebuilt Windows binaries, and exposes the exact primitives Otto needs
 * (mouse.setPosition, mouse.leftClick, keyboard.type, keyboard.pressKey).
 * Screenshots use PowerShell + System.Drawing as the dependency-free primary
 * path (works on any Windows 10/11) with screenshot-desktop as an optional
 * faster fallback when installed.
 */

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** PNG bytes of the primary display, only from screenshot(). */
  png?: Buffer;
}

/** Names of the Settings toggles that gate each Windows tool. */
export type WinToggle = 'mouse' | 'keyboard' | 'screen' | 'openApps';

export interface RegisteredTool {
  name: string;
  fn: (...args: unknown[]) => Promise<ToolResult>;
  /** Settings toggle that must be ON before this tool may run. */
  requiresToggle: WinToggle;
  description: string;
}