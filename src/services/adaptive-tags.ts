import type { AdaptiveTagValue } from "../types/oee.js";

/**
 * Adaptive realtime tags: for a machine in adaptive mode, every tag in a gateway message on the machine's
 * MQTT topic that is not one of its production tags (status, output, reject, product). Same message format
 * as always ({ "values": { "<tag>": value } }); a unit may follow a comma in the tag name, e.g.
 * "12Temp Limit,C". Kept in memory only (never in the database). A tag appears on its first message and is
 * dropped when it has not been published for the machine's `adaptiveTtlMinutes`. Lost on a backend
 * restart; the next messages fill the list again.
 */

interface Stored {
  /** Tag name as sent, without the unit part. */
  tagName: string;
  /** Shown name: the tag name without the machine No prefix ("12Run Time" → "Run Time"). */
  name: string;
  unit: string;
  value: number | string;
  at: number;
}

const MAX_TAGS_PER_MACHINE = 300;
const MAX_UNIT = 20;

/** By machine id, then by lower-cased tag name. */
const cache = new Map<string, Map<string, Stored>>();

/** Numbers stay numbers; other text is shown as sent. */
const valueOf = (text: string): number | string => {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? n : text;
};

/** "12Temp Limit,C" → name and unit; the unit is the part after the last comma (when short enough). */
export function splitUnit(key: string): { tagName: string; unit: string } {
  const i = key.lastIndexOf(",");
  if (i <= 0) return { tagName: key.trim(), unit: "" };
  const unit = key.slice(i + 1).trim();
  if (unit.length > MAX_UNIT) return { tagName: key.trim(), unit: "" };
  return { tagName: key.slice(0, i).trim(), unit };
}

/**
 * Drops a leading machine No ("12Run Time" → "Run Time" for machine 12), but not when it only looks like
 * one ("12Run" for machine "1": the next character is a digit).
 */
function withoutMachineNo(tagName: string, machineNo: string) {
  if (!tagName.toLowerCase().startsWith(machineNo.toLowerCase())) return tagName;
  const rest = tagName.slice(machineNo.length);
  if (!rest || /^\d/.test(rest)) return tagName;
  // "1A" + "Bag" is ambiguous with machine "1" + "ABag"; accept a separator or a capital letter.
  if (!/^[\s._:-]|^[A-Z]/.test(rest)) return tagName;
  return rest.replace(/^[\s._:-]+/, "") || tagName;
}

export const adaptiveTags = {
  /** Adds or updates a machine's tags from gateway readings (tag name may carry ",unit"); returns how many were kept. */
  put(machineId: string, machineNo: string, readings: { tagName: string; value: string }[], at = Date.now()) {
    let tags = cache.get(machineId);
    if (!tags) cache.set(machineId, (tags = new Map()));
    let stored = 0;
    for (const r of readings) {
      const { tagName, unit } = splitUnit(r.tagName);
      if (!tagName) continue;
      const key = tagName.toLowerCase();
      if (!tags.has(key) && tags.size >= MAX_TAGS_PER_MACHINE) continue;
      tags.set(key, { tagName, name: withoutMachineNo(tagName, machineNo), unit, value: valueOf(r.value), at });
      stored += 1;
    }
    return stored;
  },

  /** Current tags of a machine, by name. */
  values(machineId: string): AdaptiveTagValue[] {
    const tags = cache.get(machineId);
    if (!tags) return [];
    return [...tags.values()]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((t) => ({
        id: `adaptive:${t.tagName.toLowerCase()}`,
        name: t.name,
        tagName: t.tagName,
        unit: t.unit,
        value: t.value,
        updatedAt: new Date(t.at).toISOString(),
      }));
  },

  /** Drops tags not published within the machine's expiry. */
  prune(ttlMinutesByMachine: Map<string, number>, now = Date.now()) {
    for (const [machineId, tags] of cache) {
      const ttl = ttlMinutesByMachine.get(machineId);
      if (ttl === undefined) {
        cache.delete(machineId); // machine deleted
        continue;
      }
      for (const [key, t] of tags) if (now - t.at > ttl * 60_000) tags.delete(key);
      if (!tags.size) cache.delete(machineId);
    }
  },

  stats() {
    let tags = 0;
    for (const t of cache.values()) tags += t.size;
    return { machines: cache.size, tags };
  },

  clear(machineId?: string) {
    if (machineId) cache.delete(machineId);
    else cache.clear();
  },
};
