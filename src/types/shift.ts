// Keep in sync with oee-realtime-urc/src/types/shift.ts

/** A shift definition. Times are "HH:mm" in plant (server) local time; end before start crosses midnight. */
export interface Shift {
  id: string;
  name: string;
  start: string;
  end: string;
  durationMinutes: number;
  /**
   * Weekdays the shift runs on, by the day its start falls on (0 = Sunday ... 6 = Saturday); all seven by
   * default. A shift starting Friday 22:00 and ending Saturday 06:00 belongs to Friday.
   */
  days: number[];
  /** Other times on some of those days (same shift, e.g. a shorter Saturday); other days use start / end. */
  dayTimes: ShiftDayTime[];
  createdAt: string;
  updatedAt: string;
}

/** The times of a shift on one weekday, when they differ from its default start / end. */
export interface ShiftDayTime {
  day: number;
  start: string;
  end: string;
  durationMinutes: number;
}

export type ShiftInput = Pick<Shift, "name" | "start" | "end"> & {
  days?: number[];
  dayTimes?: Pick<ShiftDayTime, "day" | "start" | "end">[];
};

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
