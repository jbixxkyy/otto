/**
 * Tiny in-process pub/sub used to push agent steps, desktop frames and status
 * changes to every connected WebSocket client (Desktop tab + Activity tab).
 */
import type { WebSocket } from "ws";

export type BusMessage =
  | { type: "status"; state: "idle" | "running" | "paused" | "stopped"; detail?: string }
  | { type: "step"; activityId: number; text: string; tool?: string; ok?: boolean; at: number }
  | { type: "frame"; png: string; at: number }
  | { type: "placeholder"; reason: string }
  | { type: "confirm"; id: string; tool: string; detail: string }
  | { type: "confirm_result"; id: string; approved: boolean; reason?: string }
  | { type: "activity"; id: number; status: string };

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
}

export function removeClient(ws: WebSocket): void {
  clients.delete(ws);
}

export function clientCount(): number {
  return clients.size;
}

export function broadcast(msg: BusMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try {
        ws.send(payload);
      } catch {
        /* a dead socket must never break the agent loop */
      }
    }
  }
}