// SQLite through Node's built-in driver. Every query uses prepared statements with
// bound parameters, so user input is never concatenated into SQL.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  phone_hash  TEXT NOT NULL UNIQUE,          -- HMAC(pepper, phone): lookup without storing the number in clear
  phone_enc   TEXT NOT NULL,                 -- AES-256-GCM, for showing the number to staff
  name_enc    TEXT,
  role        TEXT NOT NULL CHECK (role IN ('parent','escort','admin')),
  home_enc    TEXT,                          -- parent's home address + coordinates, encrypted JSON
  perms       TEXT,                          -- extra staff permissions, e.g. "vetting" (separation of duties)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id          TEXT PRIMARY KEY,
  phone_hash  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otp_phone ON otp_challenges(phone_hash, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,          -- only the SHA-256 of the token is stored
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  app         TEXT                           -- the app the session was issued to: parent | guardian | control
);

CREATE TABLE IF NOT EXISTS children (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_enc    TEXT NOT NULL,
  dob_enc     TEXT,
  medical_enc TEXT,
  notes_enc   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  escort_id    TEXT REFERENCES users(id),
  status       TEXT NOT NULL CHECK (status IN ('requested','assigned','in_progress','completed','cancelled')),
  service      TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  group_id     TEXT,                         -- links the way there and the way back of one booking
  leg          TEXT NOT NULL DEFAULT 'go' CHECK (leg IN ('go','back')),
  plan_id      TEXT,                         -- set when the trip was generated from a regular plan
  plan_date    TEXT,
  price        REAL,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_day ON trips(plan_id, plan_date, leg) WHERE plan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trip_children (
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  PRIMARY KEY (trip_id, child_id)
);

CREATE TABLE IF NOT EXISTS stops (
  id                  TEXT PRIMARY KEY,
  trip_id             TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,      -- 0 = pick-up (A), 1.. = drop-offs (B, C...)
  address_enc         TEXT NOT NULL,
  geo_enc             TEXT,                  -- "lat,lng", encrypted: a child's home location is sensitive
  receiver_type       TEXT CHECK (receiver_type IN ('parent','trusted')),
  receiver_name_enc   TEXT,
  receiver_phone_enc  TEXT,
  code_hash           TEXT,                  -- HMAC(pepper, stopId:code); the code itself is never stored
  code_expires_at     INTEGER,
  code_attempts       INTEGER NOT NULL DEFAULT 0,
  code_locked         INTEGER NOT NULL DEFAULT 0,
  handed_over_at      INTEGER,
  parent_confirmed_at INTEGER,
  UNIQUE (trip_id, seq)
);

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  stop_id    TEXT NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS loc_trip ON locations(trip_id, at);

CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  escort_id   TEXT REFERENCES users(id),     -- the regular escort, set by an admin
  status      TEXT NOT NULL CHECK (status IN ('active','paused','ended')),
  service     TEXT NOT NULL,
  dir         TEXT NOT NULL CHECK (dir IN ('one','round')),
  days        TEXT NOT NULL,                 -- e.g. "mon,tue,wed"
  go_time     TEXT NOT NULL,                 -- "HH:MM", Malaysia time
  back_time   TEXT,
  start_date  TEXT NOT NULL,                 -- "YYYY-MM-DD"
  end_date    TEXT,
  price_week  REAL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_children (
  plan_id  TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, child_id)
);
CREATE TABLE IF NOT EXISTS plan_stops (
  id                 TEXT PRIMARY KEY,
  plan_id            TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  leg                TEXT NOT NULL CHECK (leg IN ('go','back')),
  seq                INTEGER NOT NULL,
  address_enc        TEXT NOT NULL,
  geo_enc            TEXT,
  receiver_type      TEXT,
  receiver_name_enc  TEXT,
  receiver_phone_enc TEXT,
  UNIQUE (plan_id, leg, seq)
);
CREATE TABLE IF NOT EXISTS plan_overrides (
  plan_id   TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,                   -- mon..sun
  data_enc  TEXT NOT NULL,                   -- JSON: other times or addresses for this weekday, encrypted
  PRIMARY KEY (plan_id, day)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- Hiring: KidsWay Guardian applicants and their security vetting ----------
CREATE TABLE IF NOT EXISTS applicants (
  id            TEXT PRIMARY KEY,
  phone_hash    TEXT NOT NULL,               -- the phone verified by SMS when applying
  phone_enc     TEXT NOT NULL,
  ic_hash       TEXT NOT NULL,               -- HMAC of the MyKad number: finds duplicates without storing it in clear
  ic_enc        TEXT NOT NULL,
  data_enc      TEXT NOT NULL,               -- name, email, area, experience, references... as encrypted JSON
  birth_year    INTEGER NOT NULL,            -- only what the age rule needs
  status        TEXT NOT NULL CHECK (status IN ('submitted','in_review','approved','rejected')),
  flags         TEXT NOT NULL DEFAULT '',    -- automatic risk signals, e.g. duplicate_ic,doc_reused
  consent_at    INTEGER NOT NULL,
  consent_ver   TEXT NOT NULL,
  user_id       TEXT REFERENCES users(id),   -- the escort account created on approval
  decided_at    INTEGER,
  retain_until  INTEGER,                     -- rejected applications are erased after this time (PDPA retention)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS applicant_phone ON applicants(phone_hash);
CREATE INDEX IF NOT EXISTS applicant_ic ON applicants(ic_hash);

CREATE TABLE IF NOT EXISTS applicant_sessions (
  id          TEXT PRIMARY KEY,
  phone_hash  TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS applicant_docs (
  id            TEXT PRIMARY KEY,
  applicant_id  TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  sha256        TEXT NOT NULL,               -- the same file used by two applicants is a fraud signal
  size          INTEGER NOT NULL,
  data_enc      TEXT NOT NULL,               -- the file itself, AES-256-GCM encrypted
  uploaded_by   TEXT NOT NULL CHECK (uploaded_by IN ('applicant','officer')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applicant_checks (
  applicant_id  TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  check_name    TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('pass','fail')),
  note_enc      TEXT,
  officer_id    TEXT NOT NULL,
  checked_at    INTEGER NOT NULL,
  valid_until   INTEGER,                     -- e-DKK and police checks must be repeated every year
  PRIMARY KEY (applicant_id, check_name)
);

-- AI identity check results: scores and booleans only, never face images or face data.
CREATE TABLE IF NOT EXISTS applicant_ai (
  applicant_id  TEXT PRIMARY KEY REFERENCES applicants(id) ON DELETE CASCADE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  live_doc_id   TEXT,                        -- the selfie taken during the liveness check
  live_ok       INTEGER,                     -- 1 passed, 0 failed, NULL not checked
  live_enc      TEXT,                        -- liveness score and reasons, encrypted JSON
  verdict       TEXT,                        -- pass | retake_ic | retake_selfie | review
  result_enc    TEXT,                        -- the last identity report, encrypted JSON
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applicant_approvals (
  applicant_id  TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  officer_id    TEXT NOT NULL,
  at            INTEGER NOT NULL,
  PRIMARY KEY (applicant_id, officer_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor_id    TEXT,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  ip          TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed')),
  detail      TEXT
);
-- The audit log is append-only: the application never updates or deletes rows.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

export type DB = DatabaseSync;

// Columns added after the first release. Older database files get them on start-up.
const MIGRATIONS: Array<[string, string, string]> = [
  ["users", "home_enc", "TEXT"],
  ["users", "perms", "TEXT"],
  ["trips", "group_id", "TEXT"],
  ["trips", "leg", "TEXT NOT NULL DEFAULT 'go'"],
  ["trips", "plan_id", "TEXT"],
  ["trips", "plan_date", "TEXT"],
  ["trips", "price", "REAL"],
  ["stops", "geo_enc", "TEXT"],
  ["sessions", "app", "TEXT"]
];

export const DEFAULT_SETTINGS: Record<string, number | string> = {
  currency: "RM", base: 25, extraChild: 10, extraStop: 8, regDiscount: 10
};

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  for (const [table, col, type] of MIGRATIONS) {
    const exists = db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (tableExists && !exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  db.exec(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(k, String(v));
  return db;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
