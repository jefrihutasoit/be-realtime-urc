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
      // Per-machine OEE rules (moved to the global OeeSettings by 011).
      `ALTER TABLE machines
        ADD COLUMN oee_start_mode VARCHAR(10) NOT NULL DEFAULT 'sku',
        ADD COLUMN reset_on_sku_change TINYINT(1) NOT NULL DEFAULT 1,
        ADD COLUMN pause_when_off TINYINT(1) NOT NULL DEFAULT 1,
        ADD COLUMN counter_mode VARCHAR(12) NOT NULL DEFAULT 'cumulative'`,
    ],
  },
  {
    id: "007_rejects",
    sql: [
      // Reject categories (the "Data Reject" columns of the shift sheet); uploads add new ones.
      `CREATE TABLE reject_types (
        id CHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_reject_types_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      // One row per machine per shift. Machine, shift and SKU are copied so history survives master changes.
      `CREATE TABLE reject_records (
        id CHAR(36) NOT NULL PRIMARY KEY,
        production_date DATE NOT NULL,
        shift_id VARCHAR(36) NOT NULL,
        shift_name VARCHAR(50) NOT NULL,
        machine_id CHAR(36) NOT NULL,
        machine_no VARCHAR(20) NOT NULL,
        operator VARCHAR(100) NOT NULL,
        sku_master_id CHAR(36) NULL,
        sku_id VARCHAR(30) NOT NULL,
        product_name VARCHAR(150) NOT NULL,
        sku VARCHAR(100) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_reject_records_slot (production_date, shift_id, machine_id),
        KEY ix_reject_records_machine (machine_id, production_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      `CREATE TABLE reject_record_items (
        record_id CHAR(36) NOT NULL,
        reject_type_id CHAR(36) NOT NULL,
        quantity INT UNSIGNED NOT NULL,
        PRIMARY KEY (record_id, reject_type_id),
        CONSTRAINT fk_rri_record FOREIGN KEY (record_id) REFERENCES reject_records (id) ON DELETE CASCADE,
        CONSTRAINT fk_rri_type FOREIGN KEY (reject_type_id) REFERENCES reject_types (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
  {
    id: "008_reject_records_per_sku",
    sql: [
      // A machine can run more than one SKU in a shift; manual input keeps one record per SKU.
      `ALTER TABLE reject_records
        DROP INDEX uq_reject_records_slot,
        ADD UNIQUE KEY uq_reject_records_slot (production_date, shift_id, machine_id, sku_id)`,
    ],
  },
  {
    id: "009_machine_run_rules",
    sql: [
      // Breakdown on Off during a run, and the conditions that finish a run (JSON list of FinishRule).
      `ALTER TABLE machines
        ADD COLUMN breakdown_when_off TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN finish_rules TEXT NULL`,
    ],
  },
  {
    id: "010_global_run_rules",
    sql: [
      // Breakdown and finish rules became one global setting (app_settings "oee_run_rules").
      `ALTER TABLE machines DROP COLUMN breakdown_when_off, DROP COLUMN finish_rules`,
    ],
  },
  {
    id: "011_global_oee_settings",
    sql: [
      // All OEE calculation settings became one global setting (app_settings "oee_settings"), which
      // also takes over "oee_run_rules". The per-machine values are carried over from the most
      // common combination among the machines. Booleans land as 0/1; the settings reader accepts both.
      `INSERT INTO app_settings (setting_key, setting_value, updated_at)
        SELECT 'oee_settings', setting_value, NOW(3) FROM app_settings WHERE setting_key = 'oee_run_rules'`,
      `INSERT INTO app_settings (setting_key, setting_value, updated_at)
        SELECT 'oee_settings', '{"breakdownWhenOff":false,"finishRules":[]}', NOW(3) FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE setting_key = 'oee_settings')`,
      `UPDATE app_settings s
        JOIN (SELECT oee_start_mode, counter_mode, reset_on_sku_change, pause_when_off FROM machines
          GROUP BY oee_start_mode, counter_mode, reset_on_sku_change, pause_when_off
          ORDER BY COUNT(*) DESC LIMIT 1) m
        SET s.setting_value = JSON_SET(s.setting_value, '$.startMode', m.oee_start_mode, '$.counterMode', m.counter_mode,
          '$.resetOnSkuChange', m.reset_on_sku_change, '$.pauseWhenOff', m.pause_when_off), s.updated_at = NOW(3)
        WHERE s.setting_key = 'oee_settings'`,
      `DELETE FROM app_settings WHERE setting_key = 'oee_run_rules'`,
      `ALTER TABLE machines
        DROP COLUMN oee_start_mode,
        DROP COLUMN reset_on_sku_change,
        DROP COLUMN pause_when_off,
        DROP COLUMN counter_mode`,
    ],
  },
  {
    id: "012_oee_run_states",
    sql: [
      // Live OEE run state per machine (engine MachineState as JSON), saved regularly so a restart keeps
      // the open runs of the current shift.
      `CREATE TABLE oee_run_states (
        machine_id CHAR(36) NOT NULL PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
  {
    id: "013_oee_hourly_and_downtime",
    sql: [
      // What the OEE engine counted per machine per clock hour (hour_start in UTC), for the daily summary.
      // st_*_ms: time per status of the status tag, whether or not OEE was counting.
      `CREATE TABLE oee_hourly (
        machine_id CHAR(36) NOT NULL,
        hour_start DATETIME NOT NULL,
        counted_ms BIGINT NOT NULL DEFAULT 0,
        run_ms BIGINT NOT NULL DEFAULT 0,
        stop_ms BIGINT NOT NULL DEFAULT 0,
        ideal_output DOUBLE NOT NULL DEFAULT 0,
        output DOUBLE NOT NULL DEFAULT 0,
        reject_tag DOUBLE NOT NULL DEFAULT 0,
        st_run_ms BIGINT NOT NULL DEFAULT 0,
        st_stop_ms BIGINT NOT NULL DEFAULT 0,
        st_off_ms BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (machine_id, hour_start),
        KEY ix_oee_hourly_hour (hour_start)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      // Uploaded downtime sheet, one row per sheet row. A row can name several machines.
      `CREATE TABLE downtime_records (
        id CHAR(36) NOT NULL PRIMARY KEY,
        production_date DATE NOT NULL,
        machine_text VARCHAR(100) NOT NULL,
        bagger VARCHAR(20) NOT NULL DEFAULT '',
        line VARCHAR(50) NOT NULL DEFAULT '',
        sku VARCHAR(100) NOT NULL DEFAULT '',
        start_time VARCHAR(5) NOT NULL DEFAULT '',
        end_time VARCHAR(5) NOT NULL DEFAULT '',
        duration_seconds INT NULL,
        notification_no VARCHAR(50) NOT NULL DEFAULT '',
        detail TEXT NOT NULL,
        operator VARCHAR(100) NOT NULL DEFAULT '',
        downtime_type VARCHAR(50) NOT NULL DEFAULT '',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_downtime_row (production_date, machine_text, bagger, start_time),
        KEY ix_downtime_date (production_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      `CREATE TABLE downtime_record_machines (
        record_id CHAR(36) NOT NULL,
        machine_id CHAR(36) NOT NULL,
        machine_no VARCHAR(20) NOT NULL,
        PRIMARY KEY (record_id, machine_id),
        CONSTRAINT fk_drm_record FOREIGN KEY (record_id) REFERENCES downtime_records (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
  {
    id: "014_users",
    sql: [
      // role: ENGINEERING (hidden maintenance account), ADMIN, ENGINEER, OPERATOR.
      `CREATE TABLE users (
        id CHAR(36) NOT NULL PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        last_login_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_users_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      // Only a SHA-256 hash of each session token is stored.
      `CREATE TABLE user_sessions (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        KEY ix_user_sessions_user (user_id),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ],
  },
];
