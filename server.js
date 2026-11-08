// Minimal .env loader (no extra dependency); real environment variables win.
try {
  for (const line of require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const express = require('express');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const google = require('./google');
const mmg = require('./mmg');
const { notify, emailEnabled } = require('./notify');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE_COOKIE = BASE_URL.startsWith('https://');
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || ''; // optional: restrict who can create a salon

// ---------- session secret (persisted so logins survive restarts) ----------
const SECRET_FILE = path.join(__dirname, '.session_secret');
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (fs.existsSync(SECRET_FILE)) SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  else { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
}

const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
};
const verify = (token) => {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > Date.now() ? p : null;
  } catch { return null; }
};
const parseCookies = (req) =>
  Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

// ---------- tiny in-memory rate limiter ----------
const hits = new Map();
const limit = (name, max, windowMs) => (req, res, next) => {
  const key = `${name}:${req.ip}`;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a bit and try again.' });
  arr.push(now); hits.set(key, arr); next();
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- helpers ----------
const app = express();
app.set('trust proxy', 'loopback'); // only honour X-Forwarded-For from a local reverse proxy
app.use(express.json({ limit: '300kb' }));

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function nowLocal(tz) {
  // 'YYYY-MM-DDTHH:MM' in the salon's timezone
  const s = new Date().toLocaleString('sv-SE', { timeZone: tz, hour12: false });
  return s.replace(' ', 'T').slice(0, 16);
}
const addMinutes = (local, mins) => {
  const d = new Date(local + ':00Z');
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 16);
};
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

function expireStaleHolds() {
  db.prepare(`
    UPDATE appointments SET status = 'expired'
    WHERE status = 'pending_payment'
      AND datetime(created_at, '+' || (SELECT hold_minutes FROM salons WHERE salons.id = appointments.salon_id) || ' minutes') < datetime('now')
  `).run();
}

const depositFor = (salon, price) => {
  const d = salon.deposit_type === 'fixed' ? Math.min(salon.deposit_value, price) : (price * salon.deposit_value) / 100;
  return Math.max(0, Math.round(d));
};

function slotsFor(salon, service, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const hours = JSON.parse(salon.hours)[dow];
  if (!hours) return [];
  const open = toMin(hours[0]), close = toMin(hours[1]);
  const now = nowLocal(salon.timezone);
  const booked = db.prepare(`
    SELECT start_local, end_local FROM appointments
    WHERE salon_id = ? AND status IN ('pending_payment','payment_submitted','confirmed')
      AND start_local < ? AND end_local > ?
  `).all(salon.id, date + 'T23:59', date + 'T00:00');
  const out = [];
  for (let t = open; t + service.duration_min <= close; t += salon.slot_step_min) {
    const start = `${date}T${fromMin(t)}`;
    if (start <= now) continue;
    const end = addMinutes(start, service.duration_min);
    const overlapping = booked.filter((b) => b.start_local < end && b.end_local > start).length;
    if (overlapping < salon.capacity) out.push(fromMin(t));
  }
  return out;
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'salon';
const publicSalon = (s) => ({
  slug: s.slug, name: s.name, phone: s.phone, address: s.address, timezone: s.timezone,
  brandColor: s.brand_color, logo: s.logo,
  hours: JSON.parse(s.hours), holdMinutes: s.hold_minutes,
  mmg: { number: s.mmg_number, name: s.mmg_name, checkout: mmg.configured(s) },
});
const apptOut = (a) => ({
  id: a.id, code: a.code, service: a.service_name, price: a.price, deposit: a.deposit,
  clientName: a.client_name, clientPhone: a.client_phone, clientEmail: a.client_email, notes: a.notes,
  start: a.start_local, end: a.end_local, status: a.status,
  paymentRef: a.payment_ref, paymentSubmittedAt: a.payment_submitted_at, createdAt: a.created_at,
  synced: Boolean(a.google_event_id), paidVia: a.paid_via,
});

// ---------- auth ----------
function requireOwner(req, res, next) {
  const p = verify(parseCookies(req).sb_session);
  if (!p) return bad(res, 'Please sign in.', 401);
  const owner = db.prepare('SELECT * FROM owners WHERE id = ?').get(p.oid);
  if (!owner) return bad(res, 'Please sign in.', 401);
  req.owner = owner;
  req.salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(owner.salon_id);
  next();
}
const setSession = (res, ownerId) =>
  res.cookie('sb_session', sign({ oid: ownerId, exp: Date.now() + 14 * 864e5 }), {
    httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, maxAge: 14 * 864e5,
  });

app.post('/api/auth/register', limit('register', 10, 3600e3), (req, res) => {
  const { salonName, name, email, password, code } = req.body || {};
  if (REGISTRATION_CODE && code !== REGISTRATION_CODE) return bad(res, 'Invalid registration code.', 403);
  if (!str(salonName) || !str(name) || !/^\S+@\S+\.\S+$/.test(str(email)) || String(password || '').length < 8)
    return bad(res, 'Salon name, your name, a valid email and a password of 8+ characters are required.');
  const em = str(email).toLowerCase();
  if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(em)) return bad(res, 'That email is already registered.', 409);
  let slug = slugify(salonName), n = 1;
  while (db.prepare('SELECT 1 FROM salons WHERE slug = ?').get(slug)) slug = `${slugify(salonName)}-${++n}`;
  const tx = db.transaction(() => {
    const sid = db.prepare('INSERT INTO salons (slug, name) VALUES (?, ?)').run(slug, str(salonName)).lastInsertRowid;
    return db.prepare('INSERT INTO owners (salon_id, email, name, password_hash) VALUES (?,?,?,?)')
      .run(sid, em, str(name), bcrypt.hashSync(String(password), 10)).lastInsertRowid;
  });
  const oid = tx();
  setSession(res, oid);
  res.json({ ok: true, slug });
});

app.post('/api/auth/login', limit('login', 10, 15 * 60e3), (req, res) => {
  const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(str(req.body?.email).toLowerCase());
  if (!owner || !bcrypt.compareSync(String(req.body?.password || ''), owner.password_hash))
    return bad(res, 'Incorrect email or password.', 401);
  setSession(res, owner.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('sb_session'); res.json({ ok: true }); });

// ---------- public booking API (no login) ----------
const getSalonBySlug = (slug) => db.prepare('SELECT * FROM salons WHERE slug = ?').get(str(slug, 60));

app.get('/api/public/:slug', (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return bad(res, 'Salon not found.', 404);
  const services = db.prepare('SELECT id, name, duration_min, price FROM services WHERE salon_id = ? AND active = 1 ORDER BY name').all(salon.id)
    .map((s) => ({ ...s, deposit: depositFor(salon, s.price) }));
  res.json({ salon: publicSalon(salon), services, today: nowLocal(salon.timezone).slice(0, 10) });
});

app.get('/api/public/:slug/slots', (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return bad(res, 'Salon not found.', 404);
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ? AND active = 1').get(Number(req.query.service), salon.id);
  if (!service) return bad(res, 'Service not found.', 404);
  expireStaleHolds();
  res.json({ slots: slotsFor(salon, service, str(req.query.date, 10)) });
});

app.post('/api/public/:slug/book', limit('book', 15, 3600e3), (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return bad(res, 'Salon not found.', 404);
  const b = req.body || {};
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ? AND active = 1').get(Number(b.serviceId), salon.id);
  if (!service) return bad(res, 'Please choose a service.');
  const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120);
  if (name.length < 2) return bad(res, 'Please enter your name.');
  if (phone.replace(/\D/g, '').length < 7) return bad(res, 'Please enter a valid phone number.');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'That email address looks wrong.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(b.date, 10)) || !/^\d{2}:\d{2}$/.test(str(b.time, 5))) return bad(res, 'Please pick a date and time.');

  expireStaleHolds();
  // better-sqlite3 is synchronous, so check + insert below cannot interleave with another request.
  if (!slotsFor(salon, service, b.date).includes(b.time)) return bad(res, 'Sorry, that time was just taken. Please pick another.', 409);

  const start = `${b.date}T${b.time}`;
  const code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  const deposit = depositFor(salon, service.price);
  const id = db.prepare(`INSERT INTO appointments
    (code, salon_id, service_id, service_name, price, deposit, client_name, client_phone, client_email, notes, start_local, end_local)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, salon.id, service.id, service.name, service.price, deposit, name, phone, email, str(b.notes, 300), start, addMinutes(start, service.duration_min)).lastInsertRowid;
  notify('booked', salon, db.prepare('SELECT * FROM appointments WHERE id = ?').get(id));
  res.json({ code, deposit, holdMinutes: salon.hold_minutes, mmg: { number: salon.mmg_number, name: salon.mmg_name } });
});

app.get('/api/public/:slug/appointments/:code', (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return bad(res, 'Salon not found.', 404);
  expireStaleHolds();
  const a = db.prepare('SELECT * FROM appointments WHERE code = ? AND salon_id = ?').get(str(req.params.code, 12).toUpperCase(), salon.id);
  if (!a) return bad(res, 'Booking not found.', 404);
  res.json({
    appointment: { code: a.code, service: a.service_name, start: a.start_local, end: a.end_local, deposit: a.deposit, price: a.price, status: a.status, clientName: a.client_name },
    salon: publicSalon(salon),
  });
});

// Client reports their MMG transaction so the owner can verify and confirm.
app.post('/api/public/:slug/appointments/:code/payment', limit('pay', 20, 3600e3), (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return bad(res, 'Salon not found.', 404);
  expireStaleHolds();
  const a = db.prepare('SELECT * FROM appointments WHERE code = ? AND salon_id = ?').get(str(req.params.code, 12).toUpperCase(), salon.id);
  if (!a) return bad(res, 'Booking not found.', 404);
  if (a.status === 'expired') return bad(res, 'This booking expired before payment was reported. Please book again.', 410);
  if (!['pending_payment', 'payment_submitted'].includes(a.status)) return bad(res, 'This booking can no longer accept payment details.', 409);
  const ref = str(req.body?.reference, 60);
  if (ref.length < 4) return bad(res, 'Please enter the MMG transaction ID from your receipt.');
  db.prepare(`UPDATE appointments SET status = 'payment_submitted', payment_ref = ?, payment_submitted_at = datetime('now') WHERE id = ?`).run(ref, a.id);
  notify('payment_reported', salon, { ...a, payment_ref: ref });
  res.json({ ok: true });
});

// ---------- MMG online checkout ----------
// Client taps "Pay with MMG": create a checkout attempt and hand back MMG's payment page URL.
app.post('/api/public/:slug/appointments/:code/mmg-checkout', limit('mmg', 20, 3600e3), (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return bad(res, 'Salon not found.', 404);
  if (!mmg.configured(salon)) return bad(res, 'This salon does not take MMG online payments yet.', 409);
  expireStaleHolds();
  const a = db.prepare('SELECT * FROM appointments WHERE code = ? AND salon_id = ?').get(str(req.params.code, 12).toUpperCase(), salon.id);
  if (!a) return bad(res, 'Booking not found.', 404);
  if (a.status === 'expired') return bad(res, 'This booking expired before payment. Please book again.', 410);
  if (a.status !== 'pending_payment') return bad(res, 'This booking is not waiting for payment.', 409);
  // Short but unique per attempt: the whole request has to fit in one RSA block.
  const txn = `${a.code}${Date.now().toString(36)}`.toUpperCase();
  try {
    const url = mmg.checkoutUrl(salon, { merchantTransactionId: txn, amount: a.deposit, description: `Deposit ${a.code}` });
    db.prepare('INSERT INTO mmg_attempts (merchant_txn_id, appointment_id, amount) VALUES (?,?,?)').run(txn, a.id, a.deposit);
    res.json({ url });
  } catch (e) {
    console.error('MMG checkout error', e.message);
    bad(res, 'MMG payment could not be started. Please use the manual MMG option below.', 502);
  }
});

// MMG sends the client back here (GET or POST) with an encrypted result token.
const mmgReturn = async (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return res.status(404).send('Salon not found.');
  const back = (code, flag) => res.redirect(`/s/${encodeURIComponent(salon.slug)}?${code ? `code=${encodeURIComponent(code)}&` : ''}mmg=${flag}`);
  const token = req.query.token || req.body?.token;
  if (!token || !mmg.configured(salon)) return back('', 'error');
  let r;
  try { r = mmg.decodeResponse(salon, String(token)); }
  catch (e) { console.error('MMG response decrypt failed', e.message); return back('', 'error'); }

  const attempt = db.prepare(`SELECT t.*, a.code FROM mmg_attempts t JOIN appointments a ON a.id = t.appointment_id
                              WHERE t.merchant_txn_id = ? AND a.salon_id = ?`).get(r.merchantTransactionId, salon.id);
  if (!attempt) { console.error('MMG response for unknown transaction', r.merchantTransactionId); return back('', 'error'); }
  if (attempt.result_code === '0') return back(attempt.code, 'paid'); // already processed (page refresh / repeat)

  if (!r.ok) {
    db.prepare('UPDATE mmg_attempts SET result_code = ? WHERE merchant_txn_id = ?').run(r.code, attempt.merchant_txn_id);
    return back(attempt.code, r.code === '6' ? 'cancelled' : 'failed');
  }
  if (!/^[A-Za-z0-9-]{1,64}$/.test(r.transactionId)) { console.error('MMG success without valid transactionId'); return back(attempt.code, 'error'); }
  if (db.prepare('SELECT 1 FROM mmg_attempts WHERE mmg_txn_id = ?').get(r.transactionId)) return back(attempt.code, 'error');

  // Record the payment and decide the booking's fate in one transaction.
  const outcome = db.transaction(() => {
    db.prepare('UPDATE mmg_attempts SET result_code = ?, mmg_txn_id = ? WHERE merchant_txn_id = ?').run('0', r.transactionId, attempt.merchant_txn_id);
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(attempt.appointment_id);
    let status = 'confirmed';
    if (a.status === 'cancelled' || a.status === 'confirmed') status = a.status; // owner already acted; just record payment
    else if (a.status === 'expired') {
      // Paid after the hold ran out: only confirm if the slot is still free.
      const clash = db.prepare(`SELECT COUNT(*) n FROM appointments WHERE salon_id = ? AND id != ?
        AND status IN ('pending_payment','payment_submitted','confirmed') AND start_local < ? AND end_local > ?`)
        .get(salon.id, a.id, a.end_local, a.start_local).n;
      if (clash >= salon.capacity) status = 'payment_submitted';
    }
    db.prepare(`UPDATE appointments SET status = ?, payment_ref = ?, payment_submitted_at = datetime('now'), paid_via = 'mmg' WHERE id = ?`)
      .run(status, r.transactionId, a.id);
    return { before: a.status, after: status, appt: { ...a, status, payment_ref: r.transactionId } };
  })();

  if (outcome.after === 'confirmed' && outcome.before !== 'confirmed') {
    notify('mmg_paid', salon, outcome.appt);
    google.syncConfirmed(salon, outcome.appt).catch((e) => console.error('Google sync error', e.message));
  } else if (outcome.after === 'payment_submitted' || outcome.after === 'cancelled') {
    notify('mmg_paid_conflict', salon, outcome.appt);
  }
  back(attempt.code, 'paid');
};
app.get('/api/mmg/return/:slug', mmgReturn);
app.post('/api/mmg/return/:slug', express.urlencoded({ extended: false, limit: '20kb' }), mmgReturn);

// ---------- owner API ----------
const admin = express.Router();
admin.use(requireOwner);

admin.get('/me', (req, res) => {
  const { salon, owner } = req;
  res.json({
    owner: { name: owner.name, email: owner.email },
    google: { available: google.enabled(), connected: Boolean(owner.google_refresh_token), email: owner.google_email },
    salon: {
      slug: salon.slug, name: salon.name, phone: salon.phone, address: salon.address, timezone: salon.timezone,
      mmgNumber: salon.mmg_number, mmgName: salon.mmg_name, depositType: salon.deposit_type, depositValue: salon.deposit_value,
      holdMinutes: salon.hold_minutes, slotStepMin: salon.slot_step_min, capacity: salon.capacity, hours: JSON.parse(salon.hours),
      brandColor: salon.brand_color, logo: salon.logo,
    },
    bookingUrl: `${BASE_URL}/s/${salon.slug}`,
    // Secrets are never sent back to the browser, only whether they are set.
    mmgApi: {
      enabled: Boolean(salon.mmg_api_enabled), ready: mmg.configured(salon), mode: salon.mmg_mode,
      merchantId: salon.mmg_merchant_id, clientId: salon.mmg_client_id,
      hasSecretKey: Boolean(salon.mmg_secret_key), hasPublicKey: Boolean(salon.mmg_public_key), hasPrivateKey: Boolean(salon.mmg_private_key),
      responseUrl: `${BASE_URL}/api/mmg/return/${salon.slug}`,
    },
    notify: { emailAvailable: emailEnabled(), email: Boolean(owner.notify_email) },
  });
});

// MMG Merchant Checkout credentials. Blank secret fields keep the stored value.
admin.put('/mmg', (req, res) => {
  const b = req.body || {}, s = req.salon;
  const pub = b.publicKey ? String(b.publicKey).trim().slice(0, 10000) : s.mmg_public_key;
  const priv = b.privateKey ? String(b.privateKey).trim().slice(0, 10000) : s.mmg_private_key;
  const keyErr = mmg.checkKey(pub, 'public') || mmg.checkKey(priv, 'private');
  if (keyErr) return bad(res, keyErr);
  const merchantId = str(b.merchantId ?? s.mmg_merchant_id, 30);
  if (merchantId && !/^\d{7,15}$/.test(merchantId)) return bad(res, 'Merchant ID should be the number on your MMG merchant account (digits only).');
  const next = {
    mmg_api_enabled: b.enabled ? 1 : 0, mmg_mode: b.mode === 'live' ? 'live' : 'sandbox', mmg_merchant_id: merchantId,
    mmg_client_id: str(b.clientId ?? s.mmg_client_id, 120), mmg_secret_key: b.secretKey ? str(b.secretKey, 200) : s.mmg_secret_key,
    mmg_public_key: pub, mmg_private_key: priv,
  };
  if (next.mmg_api_enabled && !mmg.configured({ ...s, ...next })) return bad(res, 'Fill in every MMG field before turning online payments on.');
  if (next.mmg_api_enabled) {
    try { mmg.checkoutUrl({ ...s, ...next }, { merchantTransactionId: 'X'.repeat(16), amount: 999999, description: 'Deposit XXXXXX' }); }
    catch (e) { return bad(res, e.message); }
  }
  db.prepare(`UPDATE salons SET mmg_api_enabled=?, mmg_mode=?, mmg_merchant_id=?, mmg_client_id=?, mmg_secret_key=?, mmg_public_key=?, mmg_private_key=? WHERE id=?`)
    .run(next.mmg_api_enabled, next.mmg_mode, next.mmg_merchant_id, next.mmg_client_id, next.mmg_secret_key, next.mmg_public_key, next.mmg_private_key, s.id);
  res.json({ ok: true });
});

// Each owner chooses whether they personally get notification emails.
admin.put('/notify', (req, res) => {
  db.prepare('UPDATE owners SET notify_email = ? WHERE id = ?').run(req.body?.email ? 1 : 0, req.owner.id);
  res.json({ ok: true });
});
admin.post('/notify/test', limit('notifytest', 5, 3600e3), async (req, res) => {
  if (!emailEnabled()) return bad(res, 'Email is not set up on this server yet (SMTP settings in .env).', 409);
  const [r] = await notify('test', req.salon, null, { to: req.owner.email });
  if (r?.status === 'rejected') return bad(res, `Sending failed: ${r.reason?.message || 'unknown error'}`, 502);
  res.json({ ok: true });
});

admin.put('/salon', (req, res) => {
  const b = req.body || {}, s = req.salon;
  const tz = str(b.timezone || s.timezone, 60);
  if (!validTz(tz)) return bad(res, 'Unknown timezone.');
  const depositType = b.depositType === 'fixed' ? 'fixed' : 'percent';
  const depositValue = Number(b.depositValue ?? s.deposit_value);
  if (!(depositValue >= 0) || (depositType === 'percent' && depositValue > 100)) return bad(res, 'Deposit value is invalid.');
  let brandColor = s.brand_color, logo = s.logo;
  if (b.brandColor !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(b.brandColor))) return bad(res, 'Brand colour is invalid.');
    brandColor = String(b.brandColor).toLowerCase();
  }
  if (b.logo !== undefined) {
    if (b.logo === '' || b.logo === null) logo = '';
    else if (typeof b.logo === 'string' && b.logo.length <= 250000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.logo)) logo = b.logo;
    else return bad(res, 'Logo must be a PNG, JPEG or WebP image of about 180 KB or less.');
  }
  let hours = s.hours;
  if (b.hours) {
    const h = {};
    for (let d = 0; d < 7; d++) {
      const v = b.hours[d];
      if (!v) { h[d] = null; continue; }
      if (!/^\d{2}:\d{2}$/.test(v[0]) || !/^\d{2}:\d{2}$/.test(v[1]) || toMin(v[0]) >= toMin(v[1])) return bad(res, 'Opening hours are invalid.');
      h[d] = [v[0], v[1]];
    }
    hours = JSON.stringify(h);
  }
  db.prepare(`UPDATE salons SET name=?, phone=?, address=?, timezone=?, mmg_number=?, mmg_name=?, deposit_type=?, deposit_value=?,
              hold_minutes=?, slot_step_min=?, capacity=?, hours=? WHERE id=?`).run(
    str(b.name || s.name, 80), str(b.phone ?? s.phone, 30), str(b.address ?? s.address, 200), tz,
    str(b.mmgNumber ?? s.mmg_number, 30), str(b.mmgName ?? s.mmg_name, 80), depositType, depositValue,
    Math.min(1440, Math.max(10, Number(b.holdMinutes ?? s.hold_minutes) || 60)),
    [15, 20, 30, 45, 60].includes(Number(b.slotStepMin)) ? Number(b.slotStepMin) : s.slot_step_min,
    Math.min(20, Math.max(1, Number(b.capacity ?? s.capacity) || 1)), hours, s.id);
  db.prepare('UPDATE salons SET brand_color = ?, logo = ? WHERE id = ?').run(brandColor, logo, s.id);
  res.json({ ok: true });
});

// QR code (SVG) pointing at this salon's booking link. ?download=1 forces a file download.
admin.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(`${BASE_URL}/s/${req.salon.slug}`, {
    type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#231b1f', light: '#ffffff' },
  });
  if (req.query.download) res.set('Content-Disposition', `attachment; filename="${req.salon.slug}-booking-qr.svg"`);
  res.type('image/svg+xml').send(svg);
});

admin.get('/services', (req, res) =>
  res.json(db.prepare('SELECT id, name, duration_min AS durationMin, price, active FROM services WHERE salon_id = ? ORDER BY name').all(req.salon.id)));

admin.post('/services', (req, res) => {
  const name = str(req.body?.name, 80), dur = Number(req.body?.durationMin), price = Number(req.body?.price);
  if (!name || !(dur >= 10 && dur <= 600) || !(price >= 0)) return bad(res, 'Name, duration (10–600 min) and price are required.');
  const id = db.prepare('INSERT INTO services (salon_id, name, duration_min, price) VALUES (?,?,?,?)').run(req.salon.id, name, Math.round(dur), price).lastInsertRowid;
  res.json({ id });
});

admin.put('/services/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ?').get(Number(req.params.id), req.salon.id);
  if (!s) return bad(res, 'Service not found.', 404);
  const b = req.body || {};
  const dur = Number(b.durationMin ?? s.duration_min), price = Number(b.price ?? s.price);
  if (!(dur >= 10 && dur <= 600) || !(price >= 0)) return bad(res, 'Duration or price is invalid.');
  db.prepare('UPDATE services SET name=?, duration_min=?, price=?, active=? WHERE id=?')
    .run(str(b.name || s.name, 80), Math.round(dur), price, b.active === undefined ? s.active : b.active ? 1 : 0, s.id);
  res.json({ ok: true });
});

admin.delete('/services/:id', (req, res) => {
  // Soft-delete so past appointments keep their service reference.
  db.prepare('UPDATE services SET active = 0 WHERE id = ? AND salon_id = ?').run(Number(req.params.id), req.salon.id);
  res.json({ ok: true });
});

admin.get('/appointments', (req, res) => {
  expireStaleHolds();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : nowLocal(req.salon.timezone).slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '9999-12-31';
  const rows = db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND start_local >= ? AND start_local <= ? ORDER BY start_local`)
    .all(req.salon.id, from + 'T00:00', to + 'T23:59');
  res.json(rows.map(apptOut));
});

const ownAppt = (req) => db.prepare('SELECT * FROM appointments WHERE id = ? AND salon_id = ?').get(Number(req.params.id), req.salon.id);

admin.post('/appointments/:id/confirm', async (req, res) => {
  expireStaleHolds();
  const a = ownAppt(req);
  if (!a) return bad(res, 'Appointment not found.', 404);
  if (a.status === 'confirmed') return res.json({ ok: true });
  if (!['pending_payment', 'payment_submitted'].includes(a.status))
    return bad(res, `This appointment is ${a.status} and can't be confirmed.`, 409);
  db.prepare(`UPDATE appointments SET status = 'confirmed' WHERE id = ?`).run(a.id);
  await google.syncConfirmed(req.salon, { ...a, status: 'confirmed' });
  res.json({ ok: true });
});

admin.post('/appointments/:id/cancel', async (req, res) => {
  const a = ownAppt(req);
  if (!a) return bad(res, 'Appointment not found.', 404);
  if (['cancelled', 'expired'].includes(a.status)) return res.json({ ok: true });
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(a.id);
  await google.removeEvents(req.salon, a);
  res.json({ ok: true });
});

// Add another owner/manager to the same salon (each connects their own Google calendar).
admin.post('/owners', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!str(name) || !/^\S+@\S+\.\S+$/.test(str(email)) || String(password || '').length < 8) return bad(res, 'Name, valid email and 8+ character password required.');
  const em = str(email).toLowerCase();
  if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(em)) return bad(res, 'That email is already registered.', 409);
  db.prepare('INSERT INTO owners (salon_id, email, name, password_hash) VALUES (?,?,?,?)').run(req.salon.id, em, str(name), bcrypt.hashSync(String(password), 10));
  res.json({ ok: true });
});
admin.get('/owners', (req, res) =>
  res.json(db.prepare('SELECT id, name, email, google_email AS googleEmail, google_refresh_token IS NOT NULL AS googleConnected FROM owners WHERE salon_id = ?').all(req.salon.id)));

app.use('/api/admin', admin);

// ---------- Google Calendar OAuth ----------
app.get('/api/google/connect', requireOwner, (req, res) => {
  if (!google.enabled()) return res.redirect('/admin.html?google=unconfigured');
  res.redirect(google.authUrl(sign({ oid: req.owner.id, exp: Date.now() + 10 * 60e3, n: 'g' })));
});

app.get('/api/google/callback', async (req, res) => {
  const st = verify(String(req.query.state || ''));
  if (!st || st.n !== 'g' || req.query.error || !req.query.code) return res.redirect('/admin.html?google=error');
  try {
    const t = await google.exchangeCode(String(req.query.code));
    if (!t.refresh_token) return res.redirect('/admin.html?google=error');
    db.prepare('UPDATE owners SET google_refresh_token = ?, google_email = ? WHERE id = ?')
      .run(t.refresh_token, google.emailFromIdToken(t.id_token), st.oid);
    google.backfillOwner(st.oid).catch((e) => console.error('Backfill error', e.message));
    res.redirect('/admin.html?google=connected');
  } catch (e) {
    console.error('Google callback error', e.message);
    res.redirect('/admin.html?google=error');
  }
});

app.post('/api/google/disconnect', requireOwner, (req, res) => {
  db.prepare('UPDATE owners SET google_refresh_token = NULL, google_email = NULL WHERE id = ?').run(req.owner.id);
  res.json({ ok: true });
});

// ---------- pages ----------
app.get('/s/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => bad(res, 'Not found.', 404));

app.listen(PORT, () => console.log(`SalonBook running at ${BASE_URL} (Google sync ${google.enabled() ? 'ON' : 'OFF – set GOOGLE_CLIENT_ID/SECRET'}, email ${emailEnabled() ? 'ON' : 'OFF – set SMTP_*'})`));
