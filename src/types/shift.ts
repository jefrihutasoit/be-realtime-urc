// Keep in sync with oee-realtime-urc/src/types/shift.ts

/** A shift definition. Times are "HH:mm" in plant (server) local time; end before start crosses midnight. */
export interface Shift {
  id: string;
  name: string;
  start: string;
  end: string;
  durationMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export type ShiftInput = Pick<Shift, "name" | "start" | "end">;

/**
 * A concrete shift occurrence on the timeline. Time not covered by any shift is a gap period
 * with `shiftId` null and name "No shift". OEE and the operation timeline reset at each boundary.
 */
export interface ShiftPeriod {
  shiftId: string | null;
  name: string;
  /** ISO timestamps. */
  start: string;
  end: string;
  /** "HH:mm" labels of the definition, e.g. "22:00" – "06:00". */
  startLabel: string;
  endLabel: string;
}
