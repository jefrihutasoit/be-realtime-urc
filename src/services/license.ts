import { createHash, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { HttpError } from "../lib/http-error.js";
import type { LicenseInfo, LicenseStatus } from "../types/license.js";
import { systemLog } from "./system-log.js";

/**
 * Licensing. The backend runs only on the hardware a license was issued for: until a valid license file
 * is installed, every connection is blocked (HTTP API, Socket.IO, MQTT broker / client, gateway polling)
 * except signing in and installing the license (Engineering only).
 *
 * A license is made with the "License Generator" (C#) from this hardware's ID and signed with its RSA
 * private key; only the matching public key is here, so a license cannot be made or changed without it.
 *
 * File (JSON): { "format": "oee-urc-license/1", "payload": base64(JSON), "signature": base64 }
 * Payload: { product, licenseId, hardwareId, licensee, issuedAt, expiresAt: "YYYY-MM-DD" | null }
 * Signature: RSA PKCS#1 v1.5 with SHA-256 over the payload bytes.
 */

const PRODUCT = "OEE-URC";
const FORMAT = "oee-urc-license/1";
const FILE = resolve(process.env.LICENSE_FILE ?? "config/license.lic");
const CHECK_MS = 60_000;

/** Public key of the License Generator (license-generator-urc/keys/private-key.pem). */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAzLWVTjModGOL20RQe82v
biYlMkLPEcd5mQbupMH4l8PB0zMHwDfRkadG+GeXthyk3ngDVxecB/HBQyFcNWJG
3sDM1TnBw8MUJ6PF+GHYInTCXwkbGbsi/GDTpFqbqqXQDXYXoOBymzyOVagJjzM0
dUmfPLzcWBuWp10Q2n7jrxD9zf56hlvG75ps81BlCJHHUnCJzHVSUrqEfBMfqj7H
CCnVPDrvy3buEFHMtqVOSjMQ1oGntIFugAbMir/ZggV22xWu/ZkRD+9m9yzXdznc
0IC0OcWCSrYtyJL2KDT7lR3/09/LulFtIgI5scvDR2cfjWmzkBANP2etNYNMi02G
pkj978KlPVXccgFCPv/PoDpsWl0Vuz8/vfBGGzvQqGSbQcQO8iuL2VG8JvK6tpf8
i86BAjbA/iXaSdLKbOqnV/2s6A7CqwnOUq+rvoo+mcJHqPczzpWzUBI5Utzxb9KY
wPD6PoyQwfUYcOO55YwFrZdNL2ENJHotzPTEo5i51bu1AgMBAAE=
-----END PUBLIC KEY-----`;

// ---------------------------------------------------------------- hardware ID

const readText = (path: string) => {
  try {
    // Device-tree strings end with a NUL.
    return readFileSync(path, "utf8").replace(/\0/g, "").trim();
  } catch {
    return "";
  }
};

/** Placeholder values some boards / images report instead of a real ID. */
const usable = (v: string) =>
  !!v && !/^[0\s:-]*$/.test(v) && !/^(not specified|none|default string|to be filled.*|unknown)$/i.test(v);

/**
 * Stable identifiers of this machine, best first. Inside Docker the CPU / board serials and the DMI UUID
 * are still the host's; /etc/machine-id is the host's when mounted (-v /etc/machine-id:/etc/machine-id:ro).
 * The MAC address is a last resort: in a Docker bridge network it changes when the container is re-created.
 */
function hardwareSource(): { source: string; value: string } {
  const candidates: [string, () => string][] = [
    ["cpu-serial", () => /^Serial\s*:\s*(\S+)/m.exec(readText("/proc/cpuinfo"))?.[1] ?? ""],
    ["board-serial", () => readText("/sys/firmware/devicetree/base/serial-number") || readText("/proc/device-tree/serial-number")],
    // ARM SoCs (NXP i.MX, Qualcomm, Rockchip …) without a serial in /proc/cpuinfo.
    ["soc-serial", () => readText("/sys/devices/soc0/serial_number")],
    ["dmi-uuid", () => readText("/sys/class/dmi/id/product_uuid")],
    // Soldered eMMC of embedded boards (ARM64 / ARM32): its CID is unique and survives re-installs.
    [
      "emmc-cid",
      () => {
        try {
          const disks = readdirSync("/sys/block").filter((d) => /^mmcblk\d+$/.test(d)).sort();
          for (const d of disks) {
            const cid = readText(`/sys/block/${d}/device/cid`);
            if (cid) return cid;
          }
        } catch {
          // No /sys/block (Windows, macOS).
        }
        return "";
      },
    ],
    ["machine-id", () => readText("/etc/machine-id") || readText("/var/lib/dbus/machine-id")],
    [
      "windows-guid",
      () => {
        if (process.platform !== "win32") return "";
        try {
          const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
            encoding: "utf8",
            windowsHide: true,
          });
          return /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? "";
        } catch {
          return "";
        }
      },
    ],
    [
      "mac",
      () =>
        Object.values(networkInterfaces())
          .flat()
          .filter((n) => n && !n.internal && usable(n.mac))
          .map((n) => n!.mac)
          .sort()[0] ?? "",
    ],
  ];
  for (const [source, read] of candidates) {
    const value = read();
    if (usable(value)) return { source, value: value.toLowerCase() };
  }
  return { source: "none", value: "unknown" };
}

const hw = hardwareSource();
/** "XXXXX-XXXXX-XXXXX-XXXXX": hash of the identifier, so the raw serial is never shown. */
const HARDWARE_ID = createHash("sha256")
  .update(`${PRODUCT}|${hw.source}|${hw.value}`)
  .digest("hex")
  .slice(0, 20)
  .toUpperCase()
  .match(/.{5}/g)!
  .join("-");

// ---------------------------------------------------------------- verification

/** Checks a license file's text; throws HttpError 400 with the reason when it is not valid for this machine. */
function parseLicense(text: string): LicenseInfo {
  let file: { format?: unknown; payload?: unknown; signature?: unknown };
  try {
    file = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new HttpError(400, "This is not a license file");
  }
  if (file?.format !== FORMAT || typeof file.payload !== "string" || typeof file.signature !== "string") {
    throw new HttpError(400, "This is not a license file");
  }
  const payload = Buffer.from(file.payload, "base64");
  let signed = false;
  try {
    signed = verify("sha256", payload, PUBLIC_KEY, Buffer.from(file.signature, "base64"));
  } catch {
    signed = false;
  }
  if (!signed) throw new HttpError(400, "The license file is not valid");

  let p: Record<string, unknown>;
  try {
    p = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new HttpError(400, "The license content is damaged");
  }
  if (p.product !== PRODUCT) throw new HttpError(400, "The license file is not valid");
  const info: LicenseInfo = {
    licenseId: String(p.licenseId ?? ""),
    hardwareId: String(p.hardwareId ?? "").toUpperCase(),
    licensee: String(p.licensee ?? ""),
    issuedAt: String(p.issuedAt ?? ""),
    expiresAt: typeof p.expiresAt === "string" && p.expiresAt ? p.expiresAt : null,
  };
  if (info.hardwareId !== HARDWARE_ID) {
    throw new HttpError(400, "This license is not valid for this hardware");
  }
  if (expired(info)) throw new HttpError(400, `This license expired on ${info.expiresAt}`);
  return info;
}

/** A license is valid through the whole expiry date (server local time). */
function expired(info: LicenseInfo, now = Date.now()) {
  if (!info.expiresAt) return false;
  const [y, m, d] = info.expiresAt.split("-").map(Number);
  return now >= new Date(y, m - 1, d + 1).getTime();
}

// ---------------------------------------------------------------- state

let current: LicenseInfo | null = null;
let error: string | null = null;
const listeners = new Set<(licensed: boolean) => void>();

function setCurrent(info: LicenseInfo | null, reason: string | null) {
  const was = current !== null;
  current = info;
  error = reason;
  if (was !== (info !== null)) listeners.forEach((l) => l(info !== null));
}

function loadFile() {
  if (!existsSync(FILE)) return setCurrent(null, "No license installed");
  try {
    setCurrent(parseLicense(readFileSync(FILE, "utf8")), null);
  } catch (err) {
    setCurrent(null, err instanceof Error ? err.message : String(err));
  }
}

loadFile();
const loaded = current as LicenseInfo | null;
console.log(
  loaded
    ? `[license] licensed to ${loaded.licensee || "-"} (hardware ${HARDWARE_ID}${loaded.expiresAt ? `, until ${loaded.expiresAt}` : ""})`
    : `[license] NOT LICENSED (${error}). Hardware ID: ${HARDWARE_ID} (${hw.source}). Everything is blocked until a license is installed.`
);

export const license = {
  hardwareId: HARDWARE_ID,
  isLicensed: () => current !== null,

  status(): LicenseStatus {
    return { licensed: current !== null, hardwareId: HARDWARE_ID, hardwareSource: hw.source, error, license: current };
  },

  /** Verifies and installs a license file's text; throws HttpError 400 when it is not valid here. */
  install(text: string, actor: string): LicenseStatus {
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Choose a license file");
    if (text.length > 20_000) throw new HttpError(400, "This is not a license file");
    const info = parseLicense(text);
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, text);
    setCurrent(info, null);
    systemLog.add(
      "LICENSE_INSTALLED",
      `License ${info.licenseId} for ${info.licensee || "-"} installed by ${actor}${info.expiresAt ? ` (valid until ${info.expiresAt})` : " (permanent)"}`
    );
    return this.status();
  },

  /** `listener(licensed)` runs when the system becomes licensed or stops being licensed. */
  onChange(listener: (licensed: boolean) => void) {
    listeners.add(listener);
  },

  /** Notices an expiring license while running. */
  startWatch() {
    setInterval(() => {
      if (current && expired(current)) {
        systemLog.add("LICENSE_INVALID", `License ${current.licenseId} expired on ${current.expiresAt}`);
        setCurrent(null, `The license expired on ${current.expiresAt}`);
      }
    }, CHECK_MS).unref();
  },
};
