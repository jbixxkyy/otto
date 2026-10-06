// Produces otto-windows.zip containing everything needed to run Otto on Windows:
// source, package.json, tsconfig, frontend, MCP config and docs.
// Deliberately EXCLUDES node_modules (Windows runs its own npm install so that
// native modules such as @nut-tree/nut-js compile for the Windows CPU/OS).
//
// Pure Node (zlib + hand-written ZIP central directory) so no `zip` binary is needed.
import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "otto-windows.zip");

const SKIP_DIRS = new Set(["node_modules", "dist", "data", ".git", ".omo", "reference", ".cache"]);
const SKIP_FILES = new Set([
  ".DS_Store",
  ".env",
  ".env.local",
  "otto-windows.zip",
  // internal audit scratch files - not part of a distributable build
  ".fix-prompt.txt",
]);

function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, base, acc);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      acc.push({ abs, rel });
    }
  }
  return acc;
}

// ---- minimal ZIP writer (deflate) -----------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime();

  for (const f of files) {
    const nameBuf = Buffer.from(f.rel, "utf8");
    const data = f.data;
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

const entries = walk(root)
  .filter((f) => statSync(f.abs).size < 8 * 1024 * 1024)
  .map((f) => ({ rel: f.rel, data: readFileSync(f.abs) }));

if (!existsSync(path.join(root, "package.json"))) {
  console.error("[package] package.json missing - run from the project root");
  process.exit(1);
}

writeFileSync(OUT, buildZip(entries));
console.log(`[package] wrote ${path.basename(OUT)} (${entries.length} files, ${(statSync(OUT).size / 1024).toFixed(0)} KB)`);
console.log("[package] excluded: node_modules, dist, data, .git, reference (Windows runs npm install itself)");