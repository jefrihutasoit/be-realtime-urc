import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import type { TagReading } from "../types/tag.js";

// Access to `tag_values`, the table the gateway pushes readings into.

interface TagValueRow extends RowDataPacket {
  id: number;
  tag_name: string;
  tag_value: string;
  recorded_at: Date;
}

const toReading = (r: TagValueRow): TagReading => ({
  id: Number(r.id),
  tagName: r.tag_name,
  value: r.tag_value,
  timestamp: r.recorded_at.toISOString(),
});

export const tagValueStore = {
  async insert(tagName: string, value: string, recordedAt: Date): Promise<TagReading> {
    const [result] = await pool.query<ResultSetHeader>(
      "INSERT INTO tag_values (tag_name, tag_value, recorded_at) VALUES (?, ?, ?)",
      [tagName, value, recordedAt]
    );
    return { id: result.insertId, tagName, value, timestamp: recordedAt.toISOString() };
  },

  /** Newest reading of each tag (by insert order). Tags without readings are left out. */
  async latest(tags: string[]): Promise<TagReading[]> {
    if (tags.length === 0) return [];
    const [rows] = await pool.query<TagValueRow[]>(
      `SELECT tv.id, tv.tag_name, tv.tag_value, tv.recorded_at FROM tag_values tv
        JOIN (SELECT MAX(id) AS id FROM tag_values WHERE tag_name IN (?) GROUP BY tag_name) last ON last.id = tv.id`,
      [tags]
    );
    return rows.map(toReading);
  },

  /** Newest reading of each tag recorded before `before` (e.g. the counter value at shift start). */
  async latestBefore(tags: string[], before: Date): Promise<TagReading[]> {
    if (tags.length === 0) return [];
    const [rows] = await pool.query<TagValueRow[]>(
      `SELECT tv.id, tv.tag_name, tv.tag_value, tv.recorded_at FROM tag_values tv
        JOIN (SELECT MAX(id) AS id FROM tag_values WHERE tag_name IN (?) AND recorded_at < ? GROUP BY tag_name) last
          ON last.id = tv.id`,
      [tags, before]
    );
    return rows.map(toReading);
  },

  /** Newest readings of one tag, newest first. */
  async history(tagName: string, limit: number): Promise<TagReading[]> {
    const [rows] = await pool.query<TagValueRow[]>(
      "SELECT id, tag_name, tag_value, recorded_at FROM tag_values WHERE tag_name = ? ORDER BY id DESC LIMIT ?",
      [tagName, limit]
    );
    return rows.map(toReading);
  },

  /** Readings of one tag recorded in [from, to), oldest first. */
  async between(tagName: string, from: Date, to: Date): Promise<TagReading[]> {
    const [rows] = await pool.query<TagValueRow[]>(
      `SELECT id, tag_name, tag_value, recorded_at FROM tag_values
        WHERE tag_name = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at, id`,
      [tagName, from, to]
    );
    return rows.map(toReading);
  },

  async recent(limit: number): Promise<TagReading[]> {
    const [rows] = await pool.query<TagValueRow[]>(
      "SELECT id, tag_name, tag_value, recorded_at FROM tag_values ORDER BY id DESC LIMIT ?",
      [limit]
    );
    return rows.map(toReading);
  },

  async distinctTags(): Promise<string[]> {
    const [rows] = await pool.query<TagValueRow[]>("SELECT DISTINCT tag_name FROM tag_values");
    return rows.map((r) => r.tag_name);
  },
};
