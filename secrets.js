// Encryption for secrets stored in the database (MMG keys, PayPal secret, Google refresh tokens).
// A copied or leaked salonbook.db is then useless without the key, which lives outside the database:
// DATA_KEY in the environment (64 hex characters), or else the .data_key file next to this one,
// created on first run. Lose that key and the stored secrets are gone, so the backup script copies it.
//
// Sealed values look like "enc:v1:<iv>:<tag>:<ciphertext>" (AES-256-GCM, base64url).
// open() passes anything without that prefix straight through, so older plain values keep working
// until migrate() seals them.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, '.data_key');
const PREFIX = 'enc:v1:';

function loadKey() {
  let hex = process.env.DATA_KEY || '';
  if (!hex) {
    if (fs.existsSync(KEY_FILE)) hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    else { hex = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(KEY_FILE, hex + '\n', { mode: 0o600 }); }
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('DATA_KEY / .data_key must be 64 hex characters');
  return Buffer.from(hex, 'hex');
}
const KEY = loadKey();

const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

function seal(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  if (isSealed(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
}

function open(v) {
  if (!isSealed(v)) return v;
  const [iv, tag, ct] = v.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// Columns that hold secrets. Seal any value still stored in plain text (runs once per start; cheap when done).
const SECRET_COLUMNS = {
  salons: ['mmg_secret_key', 'mmg_private_key', 'paypal_secret'],
  owners: ['google_refresh_token'],
};
function migrate(db) {
  let n = 0;
  for (const [table, cols] of Object.entries(SECRET_COLUMNS)) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const col of cols.filter((c) => have.includes(c))) {
      const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} NOT LIKE '${PREFIX}%'`).all();
      const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
      db.transaction(() => { for (const r of rows) { upd.run(seal(r.v), r.id); n++; } })();
    }
  }
  return n;
}

module.exports = { seal, open, isSealed, migrate };
