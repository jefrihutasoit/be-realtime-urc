// Keep in sync with oee-realtime-urc/src/config/yamato.ts
import type { MachineRegistration, MonitoringTag } from "../../types/machine.js";

/**
 * Fields of the Yamato Dataweigh Alpha Plus DS payload (324 ASCII characters), at fixed offsets as in the
 * Yamato manual (and YamatoTcpEmulator). Numbers are sent without a decimal point: `divisor` turns the raw
 * digits into the value (e.g. "000105" ÷ 10 = 10.5 g).
 */
export interface YamatoField {
  key: string;
  label: string;
  group: "Setting" | "Production" | "Weight" | "Histogram" | "Allowable down time" | "Down time";
  offset: number;
  length: number;
  divisor: number;
  unit: string;
  /** Text fields are shown as sent and not drawn in the trend. */
  text?: boolean;
}

const field = (
  key: string,
  label: string,
  group: YamatoField["group"],
  offset: number,
  length: number,
  divisor = 1,
  unit = ""
): YamatoField => ({ key, label, group, offset, length, divisor, unit });

export const YAMATO_FIELDS: YamatoField[] = [
  field("PROGRAM_NUMBER", "Program No", "Setting", 2, 4),
  { ...field("PRODUCT_NAME", "Product name", "Setting", 6, 20), text: true },
  field("TARGET_WEIGHT", "Target weight", "Setting", 26, 6, 10, "g"),
  field("HIGH_LIMIT", "High limit", "Setting", 32, 6, 10, "g"),
  field("LOW_LIMIT", "Low limit", "Setting", 38, 6, 10, "g"),
  field("NOMINAL_SPEED", "Nominal speed", "Setting", 44, 3, 1, "pack/min"),
  field("HISTOGRAM_DEGREE", "Histogram degree", "Setting", 99, 4, 10, "g"),
  field("ACCEPTABLE_COUNT", "Acceptable count", "Production", 47, 6, 1, "pcs"),
  field("OVERWEIGHT_COUNT", "Overweight count", "Production", 53, 6, 1, "pcs"),
  field("NO_COMBINATION", "No combination", "Production", 59, 6, 1, "pcs"),
  field("OPERATION_TIME", "Operation time", "Production", 163, 5, 1, "min"),
  field("EFFICIENCY", "Efficiency", "Production", 320, 4, 10, "%"),
  field("TOTAL_WEIGHT", "Total weight", "Weight", 65, 10, 10, "g"),
  field("AVERAGE_WEIGHT", "Average weight", "Weight", 75, 6, 10, "g"),
  field("STD_DEVIATION", "Std deviation", "Weight", 81, 6, 10, "g"),
  field("MAX_WEIGHT", "Max weight", "Weight", 87, 6, 10, "g"),
  field("MIN_WEIGHT", "Min weight", "Weight", 93, 6, 10, "g"),
  ...Array.from({ length: 12 }, (_, i) =>
    field(`HISTOGRAM_${i + 1}`, `Histogram ${i + 1}`, "Histogram", 103 + i * 5, 5, 1, "pcs")
  ),
  ...Array.from({ length: 18 }, (_, i) =>
    field(`ALLOWABLE_DOWN_TIME_${i + 1}`, `Allowable down time ${i + 1}`, "Allowable down time", 168 + i * 3, 3, 1, "min")
  ),
  ...Array.from({ length: 20 }, (_, i) =>
    field(`DOWN_TIME_${i + 1}`, `Down time ${i + 1}`, "Down time", 222 + i * 3, 3, 1, "min")
  ),
];

export const YAMATO_FIELD_BY_KEY = new Map(YAMATO_FIELDS.map((f) => [f.key, f]));

export const SCALE_TAG_PREFIX = "yamato:";

export const scaleTagName = (machineNo: string, key: string) => `${machineNo}.YAMATO.${key}`;

/** The scale's chosen fields as realtime tags of the machine; none when the scale is off. */
export function scaleTags(m: Pick<MachineRegistration, "machineNo" | "scale">): (MonitoringTag & { field: YamatoField })[] {
  if (!m.scale?.enabled) return [];
  return m.scale.fields.flatMap((key) => {
    const f = YAMATO_FIELD_BY_KEY.get(key);
    return f
      ? [{ id: `${SCALE_TAG_PREFIX}${key}`, name: `Scale · ${f.label}`, tagName: scaleTagName(m.machineNo, key), unit: f.unit, field: f }]
      : [];
  });
}

/** Registered monitoring tags plus the scale's tags. */
export const realtimeTags = (m: Pick<MachineRegistration, "machineNo" | "scale" | "monitoringTags">): MonitoringTag[] => [
  ...m.monitoringTags,
  ...scaleTags(m).map(({ field: _f, ...t }) => t),
];

/** A field's value from a DS payload: trimmed text, or the number after the divisor; null when unreadable. */
export function readField(payload: string, f: YamatoField): string | null {
  if (f.offset + f.length > payload.length) return null;
  const raw = payload.substring(f.offset, f.offset + f.length).trim();
  if (f.text) return raw || null;
  if (!/^-?\d+$/.test(raw)) return null;
  return String(Number(raw) / f.divisor);
}
