// Shared result shape for every Otto tool. Tools NEVER throw - they return
// { ok:false, error } so the agent loop can report problems to the user.
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Standard message returned by every Windows-only tool when not on win32. */
export function windowsOnly(tool: string): ToolResult {
  return {
    ok: false,
    error: `"${tool}" is Windows only - this host is ${process.platform}. Run Otto on a Windows 10/11 machine to control the desktop.`,
  };
}