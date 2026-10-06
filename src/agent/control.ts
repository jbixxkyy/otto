/**
 * Global agent control: STOP, PAUSE, TAKE CONTROL and per-call CONFIRMATION.
 *
 * - `stopAgent()` flips a process-wide flag *and* aborts the active
 *   AbortController, so the ADK run loop halts mid-turn instead of finishing.
 * - `askConfirmation()` is how Otto asks a human before a sensitive action
 *   (run_command, file writes). It broadcasts `confirm` on the WebSocket and
 *   blocks until the operator answers via POST /api/desktop/confirm. If nobody
 *   answers within CONFIRM_TIMEOUT_MS the answer is DENY - silence is never
 *   consent, so there is no path where a command runs unapproved.
 */
import { broadcast } from "../bus.js";
import { randomUUID } from "node:crypto";

export const CONFIRM_TIMEOUT_MS = 120_000;

let stopRequested = false;
let paused = false;
let tookOverFlag = false;
let activeController: AbortController | null = null;
let currentActivityId: number | null = null;

interface PendingConfirmation {
  id: string;
  tool: string;
  detail: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingConfirmation>();

export function isStopped(): boolean {
  return stopRequested;
}

export function isPaused(): boolean {
  return paused;
}

export function isTakenOver(): boolean {
  return tookOverFlag;
}

export function setCurrentActivityId(id: number | null): void {
  currentActivityId = id;
}

export function getCurrentActivityId(): number | null {
  return currentActivityId;
}

/** Halt the agent loop immediately. Safe to call when nothing is running. */
export function requestStop(): void {
  stopAgent();
}

/** Alias kept for readability at call sites that mirror the HTTP route. */
export function stopAgent(): void {
  stopRequested = true;
  paused = false;
  tookOverFlag = false;
  // Decline anything waiting on a human so the loop can unwind immediately.
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
  pending.clear();
  activeController?.abort();
  broadcast({ type: "status", state: "stopped", detail: "Stopped by operator" });
}

export function pauseAgent(): void {
  paused = true;
  tookOverFlag = false;
  broadcast({ type: "status", state: "paused", detail: "Paused by operator" });
}

/** Resume a paused loop where it left off. */
export function resumeAgent(): void {
  paused = false;
  tookOverFlag = false;
  broadcast({ type: "status", state: "running", detail: "Resumed" });
}

/** "Take control": the human drives, Otto waits until Resume. */
export function requestTakeOver(): void {
  tookOverFlag = true;
  paused = true;
  broadcast({ type: "status", state: "paused", detail: "You have control - Otto is waiting" });
}

/** Start a run with a fresh AbortController, clearing STOP from the last turn. */
export function beginRun(): AbortController {
  stopRequested = false;
  tookOverFlag = false;
  const controller = new AbortController();
  activeController = controller;
  return controller;
}

export function endRun(): void {
  activeController = null;
  paused = false;
  tookOverFlag = false;
}

export function statusSnapshot(): {
  state: "idle" | "running" | "paused" | "stopped";
  stopped: boolean;
  paused: boolean;
  pendingConfirmations: number;
} {
  return {
    state: stopRequested ? "stopped" : paused ? "paused" : activeController ? "running" : "idle",
    stopped: stopRequested,
    paused,
    pendingConfirmations: pending.size,
  };
}

/**
 * Ask the operator to approve one sensitive action.
 * Resolves true only on an explicit approval.
 */
export function askConfirmation(req: { tool: string; detail: string }): Promise<boolean> {
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      broadcast({
        type: "confirm_result",
        id,
        approved: false,
        reason: "No answer within 2 minutes - treated as denied.",
      });
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pending.set(id, { id, tool: req.tool, detail: req.detail, resolve, timer });
    broadcast({ type: "confirm", id, tool: req.tool, detail: req.detail });
  });
}

/** POST /api/desktop/confirm (or the same message over the WebSocket). */
export function resolveConfirmation(id: string, approved: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(approved);
  broadcast({ type: "confirm_result", id, approved });
  return true;
}

export function listPendingConfirmations(): Array<{ id: string; tool: string; detail: string }> {
  return [...pending.values()].map(({ id, tool, detail }) => ({ id, tool, detail }));
}

/** While paused/taken-over the loop parks here; STOP breaks out. */
export async function waitWhilePaused(): Promise<void> {
  while (paused && !stopRequested) {
    await new Promise((r) => setTimeout(r, 250));
  }
}