import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { env } from "../config/env.js";
import type { SystemResources } from "../types/system.js";

// CPU, memory and storage of the server, for the gauges at the bottom of the sidebar. CPU use is the busy share
// of all cores between two samples; storage is the disk holding the uploads (the data volume in Docker).

const SAMPLE_MS = 5000;

let cpuPercent: number | null = null;
let last = snapshot();

function snapshot() {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

setInterval(() => {
  const now = snapshot();
  const total = now.total - last.total;
  const idle = now.idle - last.idle;
  if (total > 0) cpuPercent = Math.round(Math.min(Math.max((1 - idle / total) * 100, 0), 100) * 10) / 10;
  last = now;
}, SAMPLE_MS).unref();

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);

function disk() {
  try {
    const s = statfsSync(env.uploadDir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { usedBytes: total - free, totalBytes: total, percent: pct(total - free, total) };
  } catch {
    try {
      const s = statfsSync(".");
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      return { usedBytes: total - free, totalBytes: total, percent: pct(total - free, total) };
    } catch {
      return null;
    }
  }
}

export function systemResources(): SystemResources {
  const memTotal = totalmem();
  const memUsed = memTotal - freemem();
  return {
    cpu: { percent: cpuPercent, cores: cpus().length },
    memory: { usedBytes: memUsed, totalBytes: memTotal, percent: pct(memUsed, memTotal) },
    disk: disk(),
    at: new Date().toISOString(),
  };
}
