import { migrate } from "../migrate.js";
import { pool } from "../pool.js";

try {
  await migrate();
  console.log("[db] migrations up to date");
} finally {
  await pool.end();
}
