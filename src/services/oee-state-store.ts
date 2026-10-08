import type { RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "../db/pool.js";
import { restoreStates, snapshotStates } from "./oee-engine.js";

// Saves the OEE engine's per-machine run states in `oee_run_states` and restores them at startup.

export const oeeStateStore = {
  /** Loads the saved states into the engine; returns how many were restored. */
  async restore() {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT machine_id, state FROM oee_run_states");
    const entries: [string, unknown][] = [];
    for (const r of rows) {
      try {
        entries.push([r.machine_id, JSON.parse(r.state)]);
      } catch {
        // An unreadable state starts over.
      }
    }
    return restoreStates(entries);
  },

  /** Replaces the saved states with the engine's current ones. */
  async save() {
    const entries = snapshotStates();
    const now = new Date();
    await withTransaction(async (conn) => {
      await conn.query("DELETE FROM oee_run_states");
      if (entries.length) {
        await conn.query("INSERT INTO oee_run_states (machine_id, state, updated_at) VALUES ?", [
          entries.map(([id, state]) => [id, JSON.stringify(state), now]),
        ]);
      }
    });
  },
};
