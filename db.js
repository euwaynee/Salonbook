const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'salonbook.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS salons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Guyana',
  -- MMG payment details shown to clients
  mmg_number TEXT DEFAULT '',
  mmg_name TEXT DEFAULT '',
  deposit_type TEXT NOT NULL DEFAULT 'percent',   -- 'percent' | 'fixed'
  deposit_value REAL NOT NULL DEFAULT 50,          -- % of price, or fixed GYD amount
  hold_minutes INTEGER NOT NULL DEFAULT 60,        -- how long a slot is held awaiting payment
  slot_step_min INTEGER NOT NULL DEFAULT 30,
  capacity INTEGER NOT NULL DEFAULT 1,             -- stylists/chairs that can serve at the same time
  -- weekly hours JSON: {"0":null,"1":["09:00","17:00"],...} (0 = Sunday)
  hours TEXT NOT NULL DEFAULT '{"0":null,"1":["09:00","17:00"],"2":["09:00","17:00"],"3":["09:00","17:00"],"4":["09:00","17:00"],"5":["09:00","17:00"],"6":["09:00","14:00"]}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  google_refresh_token TEXT,
  google_email TEXT,
  google_calendar_id TEXT DEFAULT 'primary',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  service_name TEXT NOT NULL,
  price REAL NOT NULL,
  deposit REAL NOT NULL,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  client_email TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  -- local wall-clock time in the salon's timezone, 'YYYY-MM-DDTHH:MM'
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  -- pending_payment -> payment_submitted -> confirmed | cancelled | expired
  status TEXT NOT NULL DEFAULT 'pending_payment',
  payment_ref TEXT DEFAULT '',
  payment_submitted_at TEXT,
  google_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_salon_start ON appointments(salon_id, start_local);
`);

// Lightweight migrations for databases created before these columns existed.
const salonCols = db.prepare('PRAGMA table_info(salons)').all().map((c) => c.name);
if (!salonCols.includes('brand_color')) db.exec("ALTER TABLE salons ADD COLUMN brand_color TEXT NOT NULL DEFAULT '#6b2d57'");
if (!salonCols.includes('logo')) db.exec("ALTER TABLE salons ADD COLUMN logo TEXT NOT NULL DEFAULT ''");

module.exports = db;
