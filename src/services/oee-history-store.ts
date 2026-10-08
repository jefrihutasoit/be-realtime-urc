import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { returnHourlyBuckets, takeHourlyBuckets } from "./oee-engine.js";

// Hourly OEE figures per machine (`oee_hourly`), added up from the engine's buckets. Used by the summary.

export interface HourlyRow {
  machineId: string;
  hourStart: number;
  countedMs: number;
  runMs: number;
  stopMs: number;
  idealOutput: number;
  output: number;
  rejectTag: number;
  statusMs: { RUN: number; STOP: number; OFF: number };
}

export const oeeHistoryStore = {
  /** Adds the engine's pending buckets to the table. */
  async flush() {
    const list = takeHourlyBuckets();
    if (!list.length) return;
    try {
      await pool.query(
        `INSERT INTO oee_hourly (machine_id, hour_start, counted_ms, run_ms, stop_ms, ideal_output, output, reject_tag,
          st_run_ms, st_stop_ms, st_off_ms) VALUES ?
          ON DUPLICATE KEY UPDATE counted_ms = counted_ms + VALUES(counted_ms), run_ms = run_ms + VALUES(run_ms),
            stop_ms = stop_ms + VALUES(stop_ms), ideal_output = ideal_output + VALUES(ideal_output),
            output = output + VALUES(output), reject_tag = reject_tag + VALUES(reject_tag),
            st_run_ms = st_run_ms + VALUES(st_run_ms), st_stop_ms = st_stop_ms + VALUES(st_stop_ms),
            st_off_ms = st_off_ms + VALUES(st_off_ms)`,
        [
          list.map((b) => [
            b.machineId,
            new Date(b.hourStart),
            Math.round(b.countedMs),
            Math.round(b.runMs),
            Math.round(b.stopMs),
            b.idealOutput,
            b.output,
            b.rejectTag,
            Math.round(b.statusMs.RUN),
            Math.round(b.statusMs.STOP),
            Math.round(b.statusMs.OFF),
          ]),
        ]
      );
    } catch (err) {
      returnHourlyBuckets(list);
      throw err;
    }
  },

  /** Rows with hour_start in [from, to). */
  async between(from: Date, to: Date): Promise<HourlyRow[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM oee_hourly WHERE hour_start >= ? AND hour_start < ?",
      [from, to]
    );
    return rows.map((r) => ({
      machineId: r.machine_id,
      hourStart: (r.hour_start as Date).getTime(),
      countedMs: Number(r.counted_ms),
      runMs: Number(r.run_ms),
      stopMs: Number(r.stop_ms),
      idealOutput: Number(r.ideal_output),
      output: Number(r.output),
      rejectTag: Number(r.reject_tag),
      statusMs: { RUN: Number(r.st_run_ms), STOP: Number(r.st_stop_ms), OFF: Number(r.st_off_ms) },
    }));
  },
};
