// Keep in sync with oee-realtime-urc/src/types/settings.ts
import type { MachineStatus } from "./oee.js";

/**
 * Global mapping from the raw value of a machine's status tag to RUN / STOP / OFF.
 * A tag that cannot be read is always OFF; a value in none of the lists gets `unmatched`.
 */
export interface StatusDefinition {
  run: number[];
  stop: number[];
  off: number[];
  unmatched: MachineStatus;
}
