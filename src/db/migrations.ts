// Schema migrations, applied in order and recorded in `schema_migrations`.
// Never edit a migration that has been applied; add a new one instead.

export const migrations: { id: string; sql: string[] }[] = [
  {
    id: "001_machines",
    sql: [
      `CREATE TABLE machines (
        id CHAR(36) NOT NULL PRIMARY KEY,
        machine_no VARCHAR(20) NOT NULL,
        machine_name VARCHAR(100) NOT NULL,
        tag_status VARCHAR(200) NOT NULL,
        tag_output VARCHAR(200) NOT NULL,
        tag_reject VARCHAR(200) NOT NULL,
        tag_product VARCHAR(200) NOT NULL,
        photo MEDIUMTEXT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        oee_enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_machines_no (machine_no),
        UNIQUE KEY uq_machines_tag_status (tag_status),
        UNIQUE KEY uq_machines_tag_output (tag_output),
        UNIQUE KEY uq_machines_tag_reject (tag_reject),
        UNIQUE KEY uq_machines_tag_product (tag_product)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      `CREATE TABLE machine_monitoring_tags (
        id CHAR(36) NOT NULL PRIMARY KEY,
        machine_id CHAR(36) NOT NULL,
        name VARCHAR(100) NOT NULL,
        tag_name VARCHAR(200) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_mmt_name (machine_id, name),
        UNIQUE KEY uq_mmt_tag (machine_id, tag_name),
        CONSTRAINT fk_mmt_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
  {
    id: "002_skus",
    sql: [
      // photo_file holds only the file name; the image itself lives in UPLOAD_DIR/skus.
      `CREATE TABLE skus (
        id CHAR(36) NOT NULL PRIMARY KEY,
        sku_id VARCHAR(30) NOT NULL,
        product_name VARCHAR(150) NOT NULL,
        sku VARCHAR(100) NOT NULL,
        output_per_minute DECIMAL(8,2) NOT NULL,
        photo_file VARCHAR(100) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_skus_sku_id (sku_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
  {
    id: "003_app_settings",
    sql: [
      // Global key/value settings; values are JSON. Missing keys fall back to defaults in code.
      `CREATE TABLE app_settings (
        setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
  {
    id: "004_tag_values",
    sql: [
      // Raw tag readings pushed by the gateway (or the simulator). The newest row per tag is its current value.
      `CREATE TABLE tag_values (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tag_name VARCHAR(200) NOT NULL,
        tag_value VARCHAR(255) NOT NULL,
        recorded_at DATETIME(3) NOT NULL,
        KEY ix_tag_values_tag_id (tag_name, id),
        KEY ix_tag_values_tag_time (tag_name, recorded_at),
        KEY ix_tag_values_time (recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
  {
    id: "005_shifts",
    sql: [
      // Times are minutes after midnight in server local time; end < start means the shift crosses midnight.
      `CREATE TABLE shifts (
        id CHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        start_minute SMALLINT NOT NULL,
        end_minute SMALLINT NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_shifts_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      // The shifts that were hard-coded before (06:00 / 14:00 / 22:00).
      `INSERT INTO shifts (id, name, start_minute, end_minute, created_at, updated_at) VALUES
        ('shift-1', 'Shift 1', 360, 840, NOW(3), NOW(3)),
        ('shift-2', 'Shift 2', 840, 1320, NOW(3), NOW(3)),
        ('shift-3', 'Shift 3', 1320, 360, NOW(3), NOW(3))`,
    ],
  },
  {
    id: "006_machine_oee_config",
    sql: [
      // Per-machine OEE rules (see OeeConfig in types/machine.ts).
      `ALTER TABLE machines
        ADD COLUMN oee_start_mode VARCHAR(10) NOT NULL DEFAULT 'sku',
        ADD COLUMN reset_on_sku_change TINYINT(1) NOT NULL DEFAULT 1,
        ADD COLUMN pause_when_off TINYINT(1) NOT NULL DEFAULT 1,
        ADD COLUMN counter_mode VARCHAR(12) NOT NULL DEFAULT 'cumulative'`,
    ],
  },
];
