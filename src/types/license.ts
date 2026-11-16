// Keep in sync with oee-realtime-urc/src/types/license.ts

/** The installed license, as issued by the License Generator. */
export interface LicenseInfo {
  licenseId: string;
  hardwareId: string;
  licensee: string;
  issuedAt: string;
  /** "YYYY-MM-DD", valid through that day; null = permanent. */
  expiresAt: string | null;
}

/** GET /license: open to everyone, so the app can show the hardware ID and lock itself. */
export interface LicenseStatus {
  licensed: boolean;
  /** "XXXXX-XXXXX-XXXXX-XXXXX": enter this in the License Generator. */
  hardwareId: string;
  /** Where the hardware ID comes from (cpu-serial, board-serial, dmi-uuid, machine-id, windows-guid, mac). */
  hardwareSource: string;
  /** Why the system is not licensed; null when licensed. */
  error: string | null;
  license: LicenseInfo | null;
}
