import { env } from "../config/env.js";
import type { GatewayTag } from "../types/machine.js";
import { tagValueStore } from "./tag-value-store.js";

/**
 * Abstraction over the PLC/IoT gateway. Values are returned as text because some tags
 * (e.g. the product code) are not numeric; callers parse numbers where they need them.
 *
 *   GATEWAY_MODE=database  the gateway pushes readings into `tag_values` (default; the Simulator page writes there too)
 *   GATEWAY_MODE=random    in-memory random generator, no database writes needed
 */
export interface GatewayDriver {
  listTags(): Promise<GatewayTag[]>;
  /** Current values. Unknown or never-pushed tags come back as null. */
  read(tags: string[]): Promise<Record<string, string | null>>;
  /**
   * Values recorded before `before`, used as counter baselines at shift start; null when a tag has no
   * earlier reading. Drivers without history leave this out and the first reading becomes the baseline.
   */
  readBefore?(tags: string[], before: Date): Promise<Record<string, string | null>>;
}

const MACHINE_NOS = ["1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B"];

const TAG_POINTS: [point: string, description: string][] = [
  ["STATUS", "run status"],
  ["OUTPUT", "output counter (pcs)"],
  ["REJECT", "reject counter (pcs)"],
  ["PRODUCT", "active product / SKU code"],
  ["SPEED", "machine speed (ppm)"],
  ["TEMP_SEAL_V", "vertical seal temperature (°C)"],
  ["TEMP_SEAL_H", "horizontal seal temperature (°C)"],
  ["FILM_TENSION", "film tension (N)"],
  ["AIR_PRESSURE", "air pressure (bar)"],
];

export const tagOf = (no: string, point: string) => `GW01.LINE${no[0]}.M${no}.${point}`;

/** Tag catalog offered when registering machines, until the real gateway exposes its tag list. */
const CATALOG: GatewayTag[] = MACHINE_NOS.flatMap((no) =>
  TAG_POINTS.map(([point, description]) => ({ tag: tagOf(no, point), description: `Machine ${no} – ${description}` }))
);

const toRecord = (tags: string[], readings: { tagName: string; value: string }[]) => {
  const out: Record<string, string | null> = Object.fromEntries(tags.map((t) => [t, null]));
  for (const r of readings) out[r.tagName] = r.value;
  return out;
};

/** Reads the newest pushed value of each tag from the `tag_values` table. */
class DatabaseDriver implements GatewayDriver {
  async listTags() {
    const pushed = await tagValueStore.distinctTags();
    const known = new Set(CATALOG.map((t) => t.tag));
    return [
      ...CATALOG,
      ...pushed.filter((t) => !known.has(t)).sort().map((tag) => ({ tag, description: "Pushed by gateway" })),
    ];
  }

  async read(tags: string[]) {
    return toRecord(tags, await tagValueStore.latest(tags));
  }

  async readBefore(tags: string[], before: Date) {
    return toRecord(tags, await tagValueStore.latestBefore(tags, before));
  }
}

const jitter = (base: number, spread: number) => +(base + (Math.random() - 0.5) * spread).toFixed(1);

interface RandomMachine {
  running: boolean;
  output: number;
  reject: number;
  product: number;
  lastTick: number;
}

/**
 * Fake gateway: STATUS 1=run / 0=stop, OUTPUT and REJECT are ever-increasing counters,
 * PRODUCT is a fixed numeric product code per machine.
 */
class RandomDriver implements GatewayDriver {
  private machines = new Map<string, RandomMachine>(
    MACHINE_NOS.map((no, i) => [
      no,
      { running: true, output: 0, reject: 0, product: 1001 + (i % 2), lastTick: Date.now() },
    ])
  );

  async listTags() {
    return CATALOG;
  }

  private tick() {
    const now = Date.now();
    for (const m of this.machines.values()) {
      const minutes = (now - m.lastTick) / 60_000;
      m.lastTick = now;
      // Occasionally flip between run and stop.
      if (Math.random() < (m.running ? 0.02 : 0.15)) m.running = !m.running;
      if (!m.running) continue;
      const made = Math.round(minutes * env.idealRatePpm * (0.85 + Math.random() * 0.15));
      m.output += made;
      m.reject += Math.round(made * Math.random() * 0.05);
    }
  }

  async read(tags: string[]) {
    this.tick();
    const out: Record<string, string | null> = {};
    for (const tag of tags) {
      const [, , m, point] = tag.split(".");
      const state = this.machines.get(m?.slice(1) ?? "");
      const value = state ? this.valueOf(state, point) : null;
      out[tag] = value === null ? null : String(value);
    }
    return out;
  }

  private valueOf(state: RandomMachine, point?: string) {
    switch (point) {
      case "STATUS": return state.running ? 1 : 0;
      case "OUTPUT": return state.output;
      case "REJECT": return state.reject;
      case "PRODUCT": return state.product;
      case "SPEED": return state.running ? jitter(env.idealRatePpm * 0.95, 6) : 0;
      case "TEMP_SEAL_V": return jitter(165, 4);
      case "TEMP_SEAL_H": return jitter(150, 4);
      case "FILM_TENSION": return jitter(42, 3);
      case "AIR_PRESSURE": return jitter(6, 0.3);
      default: return null;
    }
  }
}

function createDriver(): GatewayDriver {
  switch (env.gatewayMode) {
    case "database":
      return new DatabaseDriver();
    case "random":
      return new RandomDriver();
    default:
      throw new Error(`Unknown GATEWAY_MODE "${env.gatewayMode}" (use "database" or "random")`);
  }
}

export const gateway = createDriver();
