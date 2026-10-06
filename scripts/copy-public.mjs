// Copies the static frontend into dist/public so `node dist/index.js` can serve it.
// Cross-platform (works on Linux + Windows, no shell-specific commands).
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "public");
const dest = path.join(root, "dist", "public");

if (!existsSync(src)) {
  console.error("[copy-public] public/ not found - skipping");
  process.exit(0);
}
await mkdir(path.dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
console.log("[copy-public] public/ -> dist/public");