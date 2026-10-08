import type { RowDataPacket } from "mysql2/promise";
import { tagOf } from "../../services/gateway.js";
import { machineStore } from "../../services/machine-store.js";
import { migrate } from "../migrate.js";
import { pool } from "../pool.js";

// Inserts sample machines 1A and 1B, only when the machines table is empty.

const sample = (no: string) => ({
  machineNo: no,
  machineName: `Packing Machine ${no}`,
  tagStatus: tagOf(no, "STATUS"),
  tagOutput: tagOf(no, "OUTPUT"),
  tagReject: tagOf(no, "REJECT"),
  tagProduct: tagOf(no, "PRODUCT"),
  monitoringTags: [
    { name: "Speed", tagName: tagOf(no, "SPEED") },
    { name: "Vertical Seal Temp", tagName: tagOf(no, "TEMP_SEAL_V") },
    { name: "Horizontal Seal Temp", tagName: tagOf(no, "TEMP_SEAL_H") },
  ],
  photo: "/machines/packing-machine.svg",
  isActive: true,
  oeeEnabled: true,
});

try {
  await migrate();
  const [[{ count }]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM machines");
  if (count > 0) {
    console.log(`[seed] skipped: machines table already has ${count} row(s)`);
  } else {
    for (const no of ["1A", "1B"]) await machineStore.create(sample(no));
    console.log("[seed] inserted machines 1A and 1B");
  }
} finally {
  await pool.end();
}
