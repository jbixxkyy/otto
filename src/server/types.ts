/** Shared result shape for the server-side tool layer. */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}