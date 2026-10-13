import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { migrate } from "../migrate.js";
import { pool, withTransaction } from "../pool.js";

// Demo history for presentations: this month, from the 1st up to yesterday's production date.
//
//   npm run db:demo              (re)creates the demo
//   npm run db:demo -- --remove  removes it again
//
// It writes what the machines and the uploads would have produced:
// - oee_hourly: hourly OEE figures per machine and SKU (replaces what was saved for those hours);
// - downtime_records: the downtime sheet, except for dates that already have a real upload
//   (their hours follow the uploaded downtime instead);
// - reject_records: the per-shift reject sheet.
// Products are PT URC snacks (Piattos and King Stick). SKUs missing from the master are added.
// What was created is noted in app_settings "demo_seed" so a later run or --remove can undo it.
// The live current production date is never touched.

const DEMO_KEY = "demo_seed";
const ID_PREFIX = "demo-";
const HOUR = 3_600_000;
const SEED = 20261001;

interface Product {
  /** Code as written on the downtime sheet. */
  code: string;
  name: string;
  size: string;
  /** Ideal output per minute, for SKUs the demo adds. */
  rate: number;
  /** Packs for the small Kawasima baggers (1–9) or the Zelda baggers (10+); weight = how often it runs. */
  small: boolean;
  weight: number;
}

const PRODUCTS: Product[] = [
  { code: "KSJB 15", name: "King stick Jagung Bakar", size: "15 gr", rate: 450, small: true, weight: 2 },
  { code: "PISG 13", name: "Sambal Geprek", size: "13 gr", rate: 300, small: true, weight: 3 },
  { code: "PIRB 7", name: "Sapi Panggang", size: "7 gr", rate: 450, small: true, weight: 2 },
  { code: "PIRB 13", name: "Sapi Panggang", size: "13 gr", rate: 350, small: true, weight: 6 },
  { code: "PISW 13", name: "Rumput Laut", size: "13 gr", rate: 350, small: true, weight: 3 },
  { code: "PIBQ 13", name: "Barbeque", size: "13 gr", rate: 350, small: true, weight: 2 },
  { code: "PIRB 35", name: "Sapi Panggang", size: "35 gr", rate: 250, small: false, weight: 2 },
  { code: "PIRB 65", name: "Sapi Panggang", size: "65 gr", rate: 180, small: false, weight: 4 },
  { code: "PIRB 115", name: "Sapi Panggang", size: "115 gr", rate: 120, small: false, weight: 3 },
  { code: "PISG 35", name: "Sambal Geprek", size: "35 gr", rate: 250, small: false, weight: 1 },
  { code: "PISG 65", name: "Sambal Geprek", size: "65 gr", rate: 180, small: false, weight: 2 },
  { code: "PISW 65", name: "Rumput Laut", size: "65 gr", rate: 180, small: false, weight: 3 },
  { code: "PISW 115", name: "Rumput Laut", size: "115 gr", rate: 120, small: false, weight: 1 },
  { code: "PIBQ 65", name: "Barbeque", size: "65 gr", rate: 180, small: false, weight: 2 },
];

const BREAKDOWNS: { detail: string; type: "EL" | "MS" }[] = [
  { detail: "Endseal oblak", type: "EL" },
  { detail: "Trouble pisau, ganti pisau baru", type: "EL" },
  { detail: "Bottom temp error", type: "EL" },
  { detail: "Semi cut tdk stabil", type: "MS" },
  { detail: "Tarikan belt tdk stabil", type: "MS" },
  { detail: "Trouble vacum belt tidak narik", type: "EL" },
  { detail: "Backseal macet", type: "EL" },
  { detail: "Dencer roll error", type: "EL" },
  { detail: "Repair e/s", type: "EL" },
  { detail: "Gagal pick up", type: "MS" },
  { detail: "Bocor di T-Seal, setting pressure", type: "MS" },
  { detail: "Motor vacuum tidak berfungsi - pully motor servo oblak", type: "EL" },
  { detail: 'Mesin LINX alarm: "actuator error"', type: "EL" },
  { detail: "Setting backseal dan endseal by operator", type: "MS" },
];
const OPERATORS = ["Irpan", "Kurniasari", "Dedi S", "Siti Aminah", "Rudi H", "Wulan", "Agus P", "Rina", "Fajar", "Lestari", "Hendra", "Yuni"];
const REJECT_TYPES: [name: string, share: number][] = [
  ["Pouch Bocor", 0.5],
  ["Pouch Trapping", 0.3],
  ["Pouch Kosong", 0.2],
];

// ---------- helpers ----------

/** Deterministic random numbers, so every run produces the same demo. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
const weighted = (list: Product[]) => {
  let r = rnd() * list.reduce((s, p) => s + p.weight, 0);
  for (const p of list) if ((r -= p.weight) < 0) return p;
  return list[list.length - 1];
};
const demoId = () => ID_PREFIX + randomUUID().slice(ID_PREFIX.length);
const pad = (n: number) => String(n).padStart(2, "0");
const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** "PIMK65" / "pirb 13" → "PIRB 13". */
const normalCode = (s: string) => {
  const m = /^([A-Za-z]+)\s*(\d+)/.exec(s.trim());
  return m ? `${m[1].toUpperCase()} ${m[2]}` : "";
};

interface ShiftRow {
  id: string;
  name: string;
  start: number;
  duration: number;
}

interface Machine {
  id: string;
  no: string;
  /** Machines sharing a number (5A / 5B) run the same SKU. */
  pair: number;
  side: string;
  line: string;
}

interface Sku extends Product {
  masterId: string;
  skuId: string;
  /** Ideal output per minute from the SKU master. */
  ppm: number;
}

/** A stop in minutes after the start of the production day. */
interface Stop {
  start: number;
  end: number;
  detail: string;
  type: string;
  pairWide: boolean;
  notification: string;
  operator: string;
}

interface DemoSeed {
  from: string;
  to: string;
  hourFrom: string;
  hourTo: string;
  skuIds: string[];
  rejectTypeIds: string[];
}

const lineOf = (n: number) => (n <= 4 ? "Pia 1" : n <= 9 ? "Pia 2" : n <= 16 ? "Pia 3" : "Pia 4");

// ---------- remove ----------

async function readSeed(conn: PoolConnection): Promise<DemoSeed | null> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT setting_value FROM app_settings WHERE setting_key = ?", [DEMO_KEY]);
  try {
    return rows[0] ? (JSON.parse(rows[0].setting_value) as DemoSeed) : null;
  } catch {
    return null;
  }
}

async function removeDemo(conn: PoolConnection) {
  const seed = await readSeed(conn);
  const [dt] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) n FROM downtime_records WHERE id LIKE ?", [`${ID_PREFIX}%`]);
  await conn.query("DELETE FROM downtime_records WHERE id LIKE ?", [`${ID_PREFIX}%`]);
  const [rj] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) n FROM reject_records WHERE id LIKE ?", [`${ID_PREFIX}%`]);
  await conn.query("DELETE FROM reject_records WHERE id LIKE ?", [`${ID_PREFIX}%`]);
  let hours = 0;
  if (seed) {
    const [res] = await conn.query("DELETE FROM oee_hourly WHERE hour_start >= ? AND hour_start < ?", [
      new Date(seed.hourFrom),
      new Date(seed.hourTo),
    ]);
    hours = (res as { affectedRows: number }).affectedRows;
    if (seed.skuIds.length) {
      // Only SKUs nothing else refers to any more.
      await conn.query(
        `DELETE FROM skus WHERE id IN (?) AND id NOT IN (SELECT sku_master_id FROM reject_records WHERE sku_master_id IS NOT NULL)`,
        [seed.skuIds]
      );
    }
    if (seed.rejectTypeIds.length) {
      await conn.query(
        "DELETE FROM reject_types WHERE id IN (?) AND id NOT IN (SELECT reject_type_id FROM reject_record_items)",
        [seed.rejectTypeIds]
      );
    }
    await conn.query("DELETE FROM app_settings WHERE setting_key = ?", [DEMO_KEY]);
  }
  return { downtime: Number(dt[0].n), rejects: Number(rj[0].n), hours, seed };
}

// ---------- create ----------

async function loadSkus(conn: PoolConnection, created: string[]): Promise<Map<string, Sku>> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT id, sku_id, product_name, sku, output_per_minute FROM skus");
  const key = (name: string, size: string) => `${name}|${size}`.toLowerCase().replace(/\s+/g, " ");
  const byName = new Map(rows.map((r) => [key(r.product_name, r.sku), r]));
  const taken = new Set(rows.map((r) => String(r.sku_id).toLowerCase()));
  let next = Math.max(0, ...rows.map((r) => Number(r.sku_id)).filter(Number.isFinite)) + 1;

  const skus = new Map<string, Sku>();
  const now = new Date();
  for (const p of PRODUCTS) {
    const existing = byName.get(key(p.name, p.size));
    if (existing) {
      skus.set(p.code, { ...p, masterId: existing.id, skuId: existing.sku_id, ppm: Number(existing.output_per_minute) });
      continue;
    }
    while (taken.has(String(next))) next++;
    const skuId = String(next++);
    taken.add(skuId);
    const id = randomUUID();
    await conn.query(
      `INSERT INTO skus (id, sku_id, product_name, sku, output_per_minute, photo_file, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, skuId, p.name, p.size, p.rate, now, now]
    );
    created.push(id);
    skus.set(p.code, { ...p, masterId: id, skuId, ppm: p.rate });
  }
  return skus;
}

async function loadRejectTypes(conn: PoolConnection, created: string[]) {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT id, name, sort_order FROM reject_types");
  const ids = new Map(rows.map((r) => [String(r.name).toLowerCase(), String(r.id)]));
  let order = Math.max(0, ...rows.map((r) => Number(r.sort_order)));
  for (const [name] of REJECT_TYPES) {
    if (ids.has(name.toLowerCase())) continue;
    const id = randomUUID();
    await conn.query("INSERT INTO reject_types (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)", [id, name, ++order, new Date()]);
    ids.set(name.toLowerCase(), id);
    created.push(id);
  }
  return (name: string) => ids.get(name.toLowerCase())!;
}

/** Puts stops in time order and drops any that overlap an earlier one. */
function settle(stops: Stop[]) {
  const out: Stop[] = [];
  for (const s of stops.sort((a, b) => a.start - b.start)) {
    if (s.end <= s.start) continue;
    if (out.length && s.start < out[out.length - 1].end + 5) continue;
    out.push(s);
  }
  return out;
}

async function createDemo(conn: PoolConnection) {
  const [shiftRows] = await conn.query<RowDataPacket[]>("SELECT id, name, start_minute, end_minute FROM shifts");
  if (!shiftRows.length) throw new Error("No shifts defined; add shifts in Settings first");
  const first = Math.min(...shiftRows.map((r) => Number(r.start_minute)));
  /** Shifts in production-day order, with their start as minutes after the start of the production day. */
  const shifts: (ShiftRow & { offset: number })[] = shiftRows
    .map((r) => {
      const start = Number(r.start_minute);
      const duration = (Number(r.end_minute) - start + 1440) % 1440 || 1440;
      return { id: String(r.id), name: String(r.name), start, duration, offset: (start - first + 1440) % 1440 };
    })
    .sort((a, b) => a.offset - b.offset);
  const shiftAt = (minute: number) => shifts.findIndex((s) => minute >= s.offset && minute < s.offset + s.duration);

  // Range: the 1st of this month up to yesterday's production date.
  const now = new Date();
  const today = ymdOf(new Date(now.getTime() - first * 60_000));
  const [ty, tm] = today.split("-").map(Number);
  const dayStartOf = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d, 0, first);
  };
  const dates: string[] = [];
  for (let d = new Date(ty, tm - 1, 1); ymdOf(d) < today; d.setDate(d.getDate() + 1)) dates.push(ymdOf(d));
  if (!dates.length) throw new Error(`Nothing to do: ${today} is the first production date of the month`);
  const hourFrom = dayStartOf(dates[0]);
  const hourTo = dayStartOf(today);

  const [machineRows] = await conn.query<RowDataPacket[]>(
    "SELECT id, machine_no FROM machines WHERE is_active = 1 AND oee_enabled = 1"
  );
  const machines: Machine[] = machineRows.map((r) => {
    const m = /^(\d+)\s*([A-Za-z]?)$/.exec(String(r.machine_no));
    const pair = m ? Number(m[1]) : 99;
    return { id: r.id, no: r.machine_no, pair, side: m?.[2]?.toUpperCase() ?? "", line: lineOf(pair) };
  });
  if (!machines.length) throw new Error("No active machines with OEE enabled");
  const pairs = new Map<number, Machine[]>();
  for (const m of machines) pairs.set(m.pair, [...(pairs.get(m.pair) ?? []), m]);
  const byNo = new Map(machines.map((m) => [m.no.toLowerCase(), m]));

  const skuIdsCreated: string[] = [];
  const typeIdsCreated: string[] = [];
  const skus = await loadSkus(conn, skuIdsCreated);
  const typeId = await loadRejectTypes(conn, typeIdsCreated);
  const choices = (small: boolean) => PRODUCTS.filter((p) => p.small === small);

  // Real downtime uploads in the range: those dates keep them, and their hours follow them.
  const [realRows] = await conn.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(r.production_date, '%Y-%m-%d') AS d, r.machine_text, r.sku, r.start_time, r.end_time,
        r.detail, r.downtime_type
      FROM downtime_records r WHERE r.production_date BETWEEN ? AND ? AND r.id NOT LIKE ?`,
    [dates[0], dates[dates.length - 1], `${ID_PREFIX}%`]
  );
  const realDates = new Set(realRows.map((r) => String(r.d)));
  const minuteOf = (time: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(time);
    return m ? (Number(m[1]) * 60 + Number(m[2]) - first + 1440) % 1440 : null;
  };

  // The SKU each pair runs, carried from day to day.
  /** 0 = troublesome machine, 1 = reliable one; sets its breakdowns and speed. */
  const health = new Map(machines.map((m) => [m.id, rnd()]));
  const current = new Map<number, Product>();
  for (const [n] of pairs) current.set(n, weighted(choices(n <= 9)));

  const hourly: unknown[][] = [];
  const downtime: { row: unknown[]; machine: Machine }[] = [];
  const rejects: { row: unknown[]; items: [string, number][] }[] = [];
  let notification = 10013000;

  await conn.query("DELETE FROM oee_hourly WHERE hour_start >= ? AND hour_start < ?", [hourFrom, hourTo]);

  for (const date of dates) {
    const dayStart = dayStartOf(date);
    const at = (minute: number) => new Date(dayStart.getTime() + minute * 60_000);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    /** Now and then a rough day: more breakdowns everywhere. */
    const rough = rnd() < 0.2 ? 0.25 : 0;
    const real = realDates.has(date);

    for (const [n, members] of pairs) {
      // Which shifts run, and the SKU of each.
      const running = shifts.map(() => true);
      if (weekday === 0) {
        const runs = rnd() < 0.4;
        running.fill(runs);
        if (runs && rnd() < 0.5) running[running.length - 1] = false;
      } else if (!real) {
        for (let i = 0; i < running.length; i++) if (rnd() < 0.04) running[i] = false;
      }
      const shiftSku: Product[] = [];
      const changed: boolean[] = [];
      for (let i = 0; i < shifts.length; i++) {
        const before = current.get(n)!;
        const p = rnd() < (i === 0 ? 0.25 : 0.06) ? weighted(choices(n <= 9)) : before;
        changed.push(running[i] && p.code !== before.code);
        if (running[i]) current.set(n, p);
        shiftSku.push(current.get(n)!);
      }

      // Stops shared by the pair (changeover, cleaning, no WIP).
      const pairStops: Stop[] = [];
      if (!real) {
        shifts.forEach((s, i) => {
          if (!running[i]) return;
          const base = { pairWide: true, notification: "", operator: rnd() < 0.4 ? pick(OPERATORS) : "", type: "OL" };
          if (changed[i]) {
            const prev = i > 0 ? shiftSku[i - 1] : null;
            const detail = pick([
              "Cleaning ganti rasa",
              `Ganti SKU - setting ${shiftSku[i].code}`,
              prev ? `Ganti rasa ${prev.code} ke ${shiftSku[i].code}` : "Cleaning ganti rasa",
            ]);
            pairStops.push({ ...base, start: s.offset, end: s.offset + int(40, 90), detail });
          } else if (i === 0 && rnd() < 0.35) {
            pairStops.push({ ...base, start: s.offset, end: s.offset + int(20, 40), detail: pick(["Dry cleaning", "Breafing, swabbing, setting mc"]) });
          }
          if (rnd() < 0.07) {
            const start = s.offset + int(90, s.duration - 150);
            pairStops.push({ ...base, start, end: start + int(30, 140), detail: pick(["No WIP", "Dry cleaning & No WIP", "Mesin stop issue palet habis + staging area full"]) });
          }
        });
      }

      for (const m of members) {
        let stops: Stop[];
        const skuOfShift = [...shiftSku];
        if (real) {
          // Follow the uploaded sheet for this machine.
          const mine = realRows.filter((r) => byNo.get(String(r.machine_text).toLowerCase())?.id === m.id);
          const code = mine.map((r) => normalCode(String(r.sku))).find((c) => skus.has(c));
          if (code) skuOfShift.fill(PRODUCTS.find((p) => p.code === code)!);
          stops = settle(
            mine.flatMap((r) => {
              const start = minuteOf(String(r.start_time));
              if (start === null) return [];
              let end = minuteOf(String(r.end_time)) ?? start;
              if (end <= start) end += 1440;
              return [{ start, end: Math.min(end, 1440), detail: "", type: "", pairWide: false, notification: "", operator: "" }];
            })
          );
        } else {
          const own: Stop[] = [];
          shifts.forEach((s, i) => {
            if (!running[i]) return;
            const calm = 0.2 + 0.4 * health.get(m.id)! - rough;
            const count = rnd() < calm ? 0 : rnd() < 0.6 ? 1 : rnd() < 0.7 ? 2 : 3;
            for (let k = 0; k < count; k++) {
              const b = pick(BREAKDOWNS);
              const start = s.offset + int(30, s.duration - 40);
              const length = Math.round(10 + Math.min(110, -Math.log(1 - rnd()) * 25));
              own.push({
                start,
                end: Math.min(start + length, s.offset + s.duration),
                detail: b.detail,
                type: b.type,
                pairWide: false,
                notification: b.type === "EL" && rnd() < 0.6 ? String(++notification) : "",
                operator: rnd() < 0.3 ? pick(OPERATORS) : "",
              });
            }
          });
          stops = settle([...pairStops.map((s) => ({ ...s })), ...own]);
          for (const s of stops) {
            const shift = shifts[shiftAt(s.start)];
            s.end = Math.min(s.end, shift.offset + shift.duration);
            const sku = skus.get(skuOfShift[shiftAt(s.start)].code)!;
            downtime.push({
              machine: m,
              row: [
                demoId(), date, m.no, s.pairWide && members.length > 1 ? "AB" : m.side, m.line, sku.code,
                clock(at(s.start)), clock(at(s.end)), (s.end - s.start) * 60, s.notification, s.detail, s.operator, s.type,
              ],
            });
          }
        }

        // Hourly figures; speed varies a little per shift.
        const shiftOutput = shifts.map(() => 0);
        const speed = shifts.map(() => between(0.8, 0.9) + 0.08 * health.get(m.id)!);
        for (let h = 0; h < 24; h++) {
          const hourStart = at(h * 60);
          const i = shiftAt(h * 60);
          if (i < 0 || !running[i]) {
            hourly.push([m.id, hourStart, "-", 0, 0, 0, 0, 0, 0, 0, 0, HOUR]);
            continue;
          }
          const sku = skus.get(skuOfShift[i].code)!;
          const stopMin = stops.reduce((sum, s) => sum + Math.max(0, Math.min(s.end, h * 60 + 60) - Math.max(s.start, h * 60)), 0);
          const microMin = between(1, 4);
          const runMin = Math.max(0, 60 - stopMin - microMin);
          const runMs = Math.round(runMin * 60_000);
          const output = Math.round(sku.ppm * runMin * speed[i] * between(0.97, 1.03));
          const rejectTag = Math.round(output * between(0.001, 0.004));
          shiftOutput[i] += output;
          hourly.push([m.id, hourStart, sku.skuId, HOUR, runMs, HOUR - runMs, sku.ppm * 60, output, rejectTag, runMs, HOUR - runMs, 0]);
        }

        // Reject sheet: one row per running shift.
        shifts.forEach((s, i) => {
          if (!running[i] || shiftOutput[i] <= 0) return;
          const sku = skus.get(skuOfShift[i].code)!;
          const total = shiftOutput[i] * between(0.002, 0.006);
          const items = REJECT_TYPES.map(([name, share]): [string, number] => [typeId(name), Math.round(total * share * between(0.7, 1.3))]).filter(
            ([, q]) => q > 0
          );
          rejects.push({
            row: [demoId(), date, s.id, s.name, m.id, m.no, pick(OPERATORS), sku.masterId, sku.skuId, sku.name, sku.size],
            items,
          });
        });
      }
    }
  }

  // Bulk inserts.
  const created = new Date();
  for (let i = 0; i < hourly.length; i += 1000) {
    await conn.query(
      `INSERT INTO oee_hourly (machine_id, hour_start, sku_code, counted_ms, run_ms, stop_ms, ideal_output, output, reject_tag,
        st_run_ms, st_stop_ms, st_off_ms) VALUES ?`,
      [hourly.slice(i, i + 1000)]
    );
  }
  for (let i = 0; i < downtime.length; i += 500) {
    const part = downtime.slice(i, i + 500);
    await conn.query(
      `INSERT INTO downtime_records (id, production_date, machine_text, bagger, line, sku, start_time, end_time,
        duration_seconds, notification_no, detail, operator, downtime_type, created_at, updated_at) VALUES ?`,
      [part.map((d) => [...d.row, created, created])]
    );
    await conn.query("INSERT INTO downtime_record_machines (record_id, machine_id, machine_no) VALUES ?", [
      part.map((d) => [d.row[0], d.machine.id, d.machine.no]),
    ]);
  }
  for (let i = 0; i < rejects.length; i += 500) {
    const part = rejects.slice(i, i + 500);
    await conn.query(
      `INSERT INTO reject_records (id, production_date, shift_id, shift_name, machine_id, machine_no, operator,
        sku_master_id, sku_id, product_name, sku, created_at, updated_at) VALUES ?`,
      [part.map((r) => [...r.row, created, created])]
    );
    const items = part.flatMap((r) => r.items.map(([type, q]) => [r.row[0], type, q]));
    if (items.length) await conn.query("INSERT INTO reject_record_items (record_id, reject_type_id, quantity) VALUES ?", [items]);
  }

  const seed: DemoSeed = {
    from: dates[0],
    to: dates[dates.length - 1],
    hourFrom: hourFrom.toISOString(),
    hourTo: hourTo.toISOString(),
    skuIds: skuIdsCreated,
    rejectTypeIds: typeIdsCreated,
  };
  await conn.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
    [DEMO_KEY, JSON.stringify(seed), created]
  );

  return {
    seed,
    machines: machines.length,
    hourly: hourly.length,
    downtime: downtime.length,
    rejects: rejects.length,
    realDates: [...realDates].sort(),
    newSkus: skuIdsCreated.length,
  };
}

// ---------- main ----------

try {
  await migrate();
  if (process.argv.includes("--remove")) {
    const r = await withTransaction(removeDemo);
    console.log(
      r.seed
        ? `[demo] removed ${r.seed.from} … ${r.seed.to}: ${r.hours} hourly rows, ${r.downtime} downtime rows, ${r.rejects} reject rows`
        : `[demo] no demo found (removed ${r.downtime} downtime and ${r.rejects} reject rows marked as demo)`
    );
  } else {
    const r = await withTransaction(async (conn) => {
      await removeDemo(conn);
      return createDemo(conn);
    });
    console.log(`[demo] ${r.seed.from} … ${r.seed.to}, ${r.machines} machines`);
    console.log(`[demo]   oee_hourly:  ${r.hourly} rows (hours before were replaced)`);
    console.log(`[demo]   downtime:    ${r.downtime} rows${r.realDates.length ? ` (kept the real upload of ${r.realDates.join(", ")})` : ""}`);
    console.log(`[demo]   rejects:     ${r.rejects} rows`);
    console.log(`[demo]   SKU master:  ${r.newSkus} PT URC SKUs added`);
    console.log("[demo] undo with: npm run db:demo -- --remove");
  }
} finally {
  await pool.end();
}
