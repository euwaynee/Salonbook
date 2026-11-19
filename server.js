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
const paypal = require('./paypal');
const { seal, open, migrate: sealStoredSecrets } = require('./secrets');
const { notify, notifyClient, emailEnabled, sendMail } = require('./notify');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE_COOKIE = BASE_URL.startsWith('https://');
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || ''; // optional: restrict who can create a salon
// Owner emails that can also see the platform-wide stats page. Only settable on the server, never from the web.
const PLATFORM_ADMINS = new Set(String(process.env.PLATFORM_ADMINS || '').toLowerCase().split(',').map((e) => e.trim()).filter(Boolean));
const isPlatformAdmin = (owner) => PLATFORM_ADMINS.has(String(owner.email).toLowerCase());

// ---------- session secret (persisted so logins survive restarts) ----------
const SECRET_FILE = path.join(__dirname, '.session_secret');
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (fs.existsSync(SECRET_FILE)) SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  else { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
}

// Encrypt any secrets still stored in plain text (older rows). Logs only when something changed.
{ const n = sealStoredSecrets(db); if (n) console.log(`Encrypted ${n} stored secret(s) in the database.`); }

const CONTACT = String(process.env.CONTACT_EMAIL || '').trim();
const SUSPENDED_MSG = `This salon has been suspended. ${CONTACT ? `Contact ${CONTACT}` : 'Contact the SalonBook operator'} for help.`;

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
app.disable('x-powered-by');
// Security headers. Pages use inline <script>/<style>, Google Fonts, and data:/blob: images (logos).
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  // Visitors who arrive over plain http through the proxy are sent to https (sign-in cookies only work there).
  if (SECURE_COOKIE && req.headers['x-forwarded-proto'] === 'http' && ['GET', 'HEAD'].includes(req.method))
    return res.redirect(301, BASE_URL + req.originalUrl);
  res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
  if (SECURE_COOKIE) res.set('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
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

// The closure covering this date ('YYYY-MM-DD'), if the salon is closed that day.
const closureOn = (salonId, date) =>
  db.prepare('SELECT * FROM closures WHERE salon_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1').get(salonId, date, date);

function slotsFor(salon, service, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  if (closureOn(salon.id, date)) return [];
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
  cash: Boolean(s.pay_cash),
  clientEmails: Boolean(s.client_emails) && emailEnabled(), reminderHours: s.reminder_hours,
  paypal: { checkout: paypal.configured(s), me: s.usd_rate > 0 && s.paypal_me ? s.paypal_me : '' },
});
const apptOut = (a) => ({
  id: a.id, code: a.code, service: a.service_name, price: a.price, deposit: a.deposit,
  clientName: a.client_name, clientPhone: a.client_phone, clientEmail: a.client_email, notes: a.notes,
  start: a.start_local, end: a.end_local, status: a.status,
  paymentRef: a.payment_ref, paymentSubmittedAt: a.payment_submitted_at, createdAt: a.created_at,
  synced: Boolean(a.google_event_id), paidVia: a.paid_via, payMethod: a.pay_method,
});

// The client's own booking page (status, payment), used in their emails.
const clientLink = (salon, a) => `${BASE_URL}/s/${encodeURIComponent(salon.slug)}?code=${encodeURIComponent(a.code)}`;
// "You're booked" email to the client, at most once per booking however it got confirmed.
function sendClientConfirmation(salon, a) {
  if (!a.client_email) return;
  const claimed = db.prepare("UPDATE appointments SET client_confirm_sent_at = datetime('now') WHERE id = ? AND client_confirm_sent_at IS NULL").run(a.id).changes;
  if (claimed) notifyClient('confirmed', salon, { ...a, status: 'confirmed' }, { link: clientLink(salon, a) });
}

// ---------- auth ----------
function requireOwner(req, res, next) {
  const p = verify(parseCookies(req).sb_session);
  if (!p || p.n) return bad(res, 'Please sign in.', 401); // p.n marks single-purpose tokens (reset links, OAuth state), never sessions
  const owner = db.prepare('SELECT * FROM owners WHERE id = ?').get(p.oid);
  if (!owner) return bad(res, 'Please sign in.', 401);
  req.owner = owner;
  req.salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(owner.salon_id);
  if (req.salon.suspended_at && !isPlatformAdmin(owner)) return bad(res, SUSPENDED_MSG, 403);
  next();
}
const setSession = (res, ownerId) =>
  res.cookie('sb_session', sign({ oid: ownerId, exp: Date.now() + 14 * 864e5 }), {
    httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, maxAge: 14 * 864e5,
  });

// Lets the sign-up page show the registration code field only when one is required.
app.get('/api/auth/options', (req, res) => res.json({ codeRequired: Boolean(REGISTRATION_CODE) }));

app.post('/api/auth/register', limit('register', 10, 3600e3), (req, res) => {
  const { salonName, name, email, password, code } = req.body || {};
  if (REGISTRATION_CODE && code !== REGISTRATION_CODE) return bad(res, 'Invalid registration code.', 403);
  if (!str(salonName) || !str(name) || !/^\S+@\S+\.\S+$/.test(str(email)) || String(password || '').length < 8)
    return bad(res, 'Salon name, your name, a valid email and a password of 8+ characters are required.');
  const em = str(email).toLowerCase();
  if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(em)) return bad(res, 'That email is already registered.', 409);
  let slug = slugify(salonName), n = 1;
  while (db.prepare('SELECT 1 FROM salons WHERE slug = ?').get(slug)) slug = `${slugify(salonName)}-${++n}`;
  // Without email on this server there is no way to verify, so accounts start verified.
  const verified = emailEnabled() ? 0 : 1;
  const tx = db.transaction(() => {
    const sid = db.prepare('INSERT INTO salons (slug, name) VALUES (?, ?)').run(slug, str(salonName)).lastInsertRowid;
    return db.prepare('INSERT INTO owners (salon_id, email, name, password_hash, email_verified) VALUES (?,?,?,?,?)')
      .run(sid, em, str(name), bcrypt.hashSync(String(password), 10), verified).lastInsertRowid;
  });
  const oid = tx();
  if (!verified) sendVerifyEmail(db.prepare('SELECT * FROM owners WHERE id = ?').get(oid));
  setSession(res, oid);
  res.json({ ok: true, slug });
});

// ---------- email verification ----------
// New salons stay off the public booking pages until an owner clicks the link we email them.
// The link is a signed 48-hour token tied to the address it was sent to.
function sendVerifyEmail(owner) {
  const link = `${BASE_URL}/api/auth/verify?t=${encodeURIComponent(sign({ oid: owner.id, exp: Date.now() + 48 * 3600e3, n: 'ev', e: owner.email }))}`;
  return sendMail(owner.email, 'Confirm your email for SalonBook',
    `Hi ${owner.name},\n\nPlease confirm this is your email address. Your booking page goes live once you do.\n\n${link}\n\nThe link works for 48 hours. If you didn't sign up for SalonBook, ignore this email.\n\n— SalonBook`)
    .catch((e) => console.error('Verification email failed:', e.message));
}

app.get('/api/auth/verify', limit('verify', 20, 3600e3), (req, res) => {
  const p = verify(str(req.query.t, 800));
  const owner = p && p.n === 'ev' ? db.prepare('SELECT * FROM owners WHERE id = ?').get(p.oid) : null;
  if (!owner || owner.email !== p.e) return res.redirect('/admin.html?verified=0');
  db.prepare('UPDATE owners SET email_verified = 1 WHERE id = ?').run(owner.id);
  setSession(res, owner.id); // clicking the emailed link proves they own the address, same as a password reset
  res.redirect('/admin.html?verified=1');
});

app.post('/api/auth/login', limit('login', 10, 15 * 60e3), (req, res) => {
  const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(str(req.body?.email).toLowerCase());
  if (!owner || !bcrypt.compareSync(String(req.body?.password || ''), owner.password_hash))
    return bad(res, 'Incorrect email or password.', 401);
  const salon = db.prepare('SELECT suspended_at FROM salons WHERE id = ?').get(owner.salon_id);
  if (salon?.suspended_at && !isPlatformAdmin(owner)) return bad(res, SUSPENDED_MSG, 403);
  setSession(res, owner.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('sb_session'); res.json({ ok: true }); });

// ---------- password reset by email ----------
// The emailed link carries a signed 1-hour token tied to the current password hash, so it dies once the password changes.
const pwMark = (owner) => crypto.createHmac('sha256', SECRET).update('pw:' + owner.password_hash).digest('base64url').slice(0, 16);

app.post('/api/auth/forgot', limit('forgot', 5, 3600e3), (req, res) => {
  if (!emailEnabled()) return bad(res, 'Password reset by email is not set up on this server. Ask whoever runs it to reset your password.', 409);
  const em = str(req.body?.email).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(em)) return bad(res, 'Enter the email you sign in with.');
  const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(em);
  // Same answer whether or not the account exists, so this can't be used to find out who has one.
  if (owner) {
    const now = Date.now(), key = `forgotmail:${owner.id}`;
    const sent = (hits.get(key) || []).filter((t) => now - t < 3600e3);
    if (sent.length < 3) { // at most 3 reset emails an hour per account, whoever asks
      sent.push(now); hits.set(key, sent);
      const link = `${BASE_URL}/reset.html#${sign({ oid: owner.id, exp: now + 3600e3, n: 'pw', m: pwMark(owner) })}`;
      sendMail(owner.email, 'Reset your SalonBook password',
        `Hi ${owner.name},\n\nUse this link to choose a new SalonBook password. It works once and expires in 1 hour.\n\n${link}\n\nIf you didn't ask for this, ignore this email and your password stays the same.\n\n— SalonBook`)
        .catch((e) => console.error('Reset email failed:', e.message));
    }
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', limit('reset', 10, 3600e3), (req, res) => {
  const p = verify(str(req.body?.token, 600));
  const owner = p && p.n === 'pw' ? db.prepare('SELECT * FROM owners WHERE id = ?').get(p.oid) : null;
  if (!owner || p.m !== pwMark(owner)) return bad(res, 'This reset link has expired or was already used. Ask for a new one.', 410);
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return bad(res, 'Password must be at least 8 characters.');
  db.prepare('UPDATE owners SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), owner.id);
  setSession(res, owner.id);
  res.json({ ok: true });
});

// ---------- public booking API (no login) ----------
const getSalonBySlug = (slug) => db.prepare('SELECT * FROM salons WHERE slug = ?').get(str(slug, 60));
// A salon takes bookings only when it isn't suspended and at least one owner has confirmed their email.
const takingBookings = (salon) => !salon.suspended_at &&
  Boolean(db.prepare('SELECT 1 FROM owners WHERE salon_id = ? AND email_verified = 1').get(salon.id));
// For routes that start something new (viewing, booking, paying). Sends the error itself and returns null.
function openSalon(req, res) {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) { bad(res, 'Salon not found.', 404); return null; }
  if (!takingBookings(salon)) { bad(res, 'This salon is not taking online bookings right now. Please contact them directly.', 403); return null; }
  return salon;
}

app.get('/api/public/:slug', (req, res) => {
  const salon = openSalon(req, res);
  if (!salon) return;
  const services = db.prepare('SELECT id, name, duration_min, price FROM services WHERE salon_id = ? AND active = 1 ORDER BY name').all(salon.id)
    .map((s) => ({ ...s, deposit: depositFor(salon, s.price) }));
  const today = nowLocal(salon.timezone).slice(0, 10);
  // Upcoming closed days, so the booking page can mention them before the client picks a date.
  const closures = db.prepare(`SELECT start_date AS start, end_date AS end, note FROM closures
    WHERE salon_id = ? AND end_date >= ? AND start_date <= date(?, '+120 days') ORDER BY start_date`).all(salon.id, today, today);
  res.json({ salon: publicSalon(salon), services, today, closures });
});

app.get('/api/public/:slug/slots', (req, res) => {
  const salon = openSalon(req, res);
  if (!salon) return;
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ? AND active = 1').get(Number(req.query.service), salon.id);
  if (!service) return bad(res, 'Service not found.', 404);
  expireStaleHolds();
  const date = str(req.query.date, 10), closed = /^\d{4}-\d{2}-\d{2}$/.test(date) && closureOn(salon.id, date);
  res.json({ slots: slotsFor(salon, service, date), closed: closed ? { note: closed.note } : null });
});

app.post('/api/public/:slug/book', limit('book', 15, 3600e3), (req, res) => {
  const salon = openSalon(req, res);
  if (!salon) return;
  const b = req.body || {};
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ? AND active = 1').get(Number(b.serviceId), salon.id);
  if (!service) return bad(res, 'Please choose a service.');
  const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120);
  if (name.length < 2) return bad(res, 'Please enter your name.');
  if (phone.replace(/\D/g, '').length < 7) return bad(res, 'Please enter a valid phone number.');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'That email address looks wrong.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(b.date, 10)) || !/^\d{2}:\d{2}$/.test(str(b.time, 5))) return bad(res, 'Please pick a date and time.');

  expireStaleHolds();
  if (closureOn(salon.id, b.date)) return bad(res, 'The salon is closed that day. Please pick another date.', 409);
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
  // Booking codes are short, so cap wrong guesses per address (valid lookups are unlimited: the page polls).
  const now = Date.now(), missKey = `codemiss:${req.ip}`;
  const misses = (hits.get(missKey) || []).filter((t) => now - t < 3600e3);
  if (misses.length >= 30) return bad(res, 'Too many attempts. Please wait a bit and try again.', 429);
  const a = db.prepare('SELECT * FROM appointments WHERE code = ? AND salon_id = ?').get(str(req.params.code, 12).toUpperCase(), salon.id);
  if (!a) { misses.push(now); hits.set(missKey, misses); return bad(res, 'Booking not found.', 404); }
  res.json({
    appointment: {
      code: a.code, service: a.service_name, start: a.start_local, end: a.end_local, deposit: a.deposit, price: a.price, status: a.status,
      clientName: a.client_name, payMethod: a.pay_method, depositUsd: salon.usd_rate > 0 ? paypal.usdFor(salon, a.deposit) : null,
    },
    salon: publicSalon(salon),
  });
});

// The booking a payment action is for, if it can still take one. Sends the error itself and returns null.
function payableAppt(req, res, salon, { allowSubmitted = false } = {}) {
  expireStaleHolds();
  const a = db.prepare('SELECT * FROM appointments WHERE code = ? AND salon_id = ?').get(str(req.params.code, 12).toUpperCase(), salon.id);
  if (!a) { bad(res, 'Booking not found.', 404); return null; }
  if (a.status === 'expired') { bad(res, 'This booking expired before payment. Please book again.', 410); return null; }
  const ok = allowSubmitted ? ['pending_payment', 'payment_submitted'] : ['pending_payment'];
  if (!ok.includes(a.status)) { bad(res, 'This booking is not waiting for payment.', 409); return null; }
  return a;
}

// Client reports a manual payment (MMG transfer or PayPal.me) so the owner can check it and confirm.
app.post('/api/public/:slug/appointments/:code/payment', limit('pay', 20, 3600e3), (req, res) => {
  const salon = openSalon(req, res);
  if (!salon) return;
  const a = payableAppt(req, res, salon, { allowSubmitted: true });
  if (!a) return;
  const method = req.body?.method === 'paypal_me' ? 'paypal_me' : 'mmg';
  if (method === 'paypal_me' && !publicSalon(salon).paypal.me) return bad(res, 'This salon does not take PayPal.', 409);
  const ref = str(req.body?.reference, 60);
  if (ref.length < 4) return bad(res, `Please enter the ${method === 'paypal_me' ? 'PayPal' : 'MMG'} transaction ID from your receipt.`);
  db.prepare(`UPDATE appointments SET status = 'payment_submitted', payment_ref = ?, pay_method = ?, payment_submitted_at = datetime('now') WHERE id = ?`).run(ref, method, a.id);
  notify('payment_reported', salon, { ...a, payment_ref: ref, pay_method: method });
  res.json({ ok: true });
});

// Client chooses to pay at the salon. No deposit is taken; the owner confirms (or cancels) the booking.
app.post('/api/public/:slug/appointments/:code/cash', limit('pay', 20, 3600e3), (req, res) => {
  const salon = openSalon(req, res);
  if (!salon) return;
  if (!salon.pay_cash) return bad(res, 'This salon does not take cash bookings online.', 409);
  const a = payableAppt(req, res, salon);
  if (!a) return;
  db.prepare(`UPDATE appointments SET status = 'payment_submitted', pay_method = 'cash', payment_ref = '', payment_submitted_at = datetime('now') WHERE id = ?`).run(a.id);
  notify('cash_chosen', salon, { ...a, pay_method: 'cash' });
  res.json({ ok: true });
});

// A payment gateway (MMG or PayPal) says the deposit is paid: record it and decide the booking's fate in one transaction.
// Confirms the booking unless the owner already cancelled it, or the hold expired and the slot has since gone.
function recordGatewayPayment(salon, apptId, via, ref) {
  const outcome = db.transaction(() => {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
    let status = 'confirmed';
    if (a.status === 'cancelled' || a.status === 'confirmed') status = a.status; // owner already acted; just record payment
    else if (a.status === 'expired') {
      const clash = db.prepare(`SELECT COUNT(*) n FROM appointments WHERE salon_id = ? AND id != ?
        AND status IN ('pending_payment','payment_submitted','confirmed') AND start_local < ? AND end_local > ?`)
        .get(salon.id, a.id, a.end_local, a.start_local).n;
      if (clash >= salon.capacity) status = 'payment_submitted';
    }
    db.prepare(`UPDATE appointments SET status = ?, payment_ref = ?, payment_submitted_at = datetime('now'), paid_via = ?, pay_method = ? WHERE id = ?`)
      .run(status, ref, via, `${via}_checkout`, a.id);
    return { before: a.status, after: status, appt: { ...a, status, payment_ref: ref, paid_via: via } };
  })();
  if (outcome.after === 'confirmed' && outcome.before !== 'confirmed') {
    notify('paid_online', salon, outcome.appt);
    sendClientConfirmation(salon, outcome.appt);
    google.syncConfirmed(salon, outcome.appt).catch((e) => console.error('Google sync error', e.message));
  } else if (outcome.after === 'payment_submitted' || outcome.after === 'cancelled') {
    notify('paid_online_conflict', salon, outcome.appt);
  }
  return outcome;
}

// ---------- MMG online checkout ----------
// Client taps "Pay with MMG": create a checkout attempt and hand back MMG's payment page URL.
app.post('/api/public/:slug/appointments/:code/mmg-checkout', limit('mmg', 20, 3600e3), (req, res) => {
  const salon = openSalon(req, res);
  if (!salon) return;
  if (!mmg.configured(salon)) return bad(res, 'This salon does not take MMG online payments yet.', 409);
  const a = payableAppt(req, res, salon);
  if (!a) return;
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

  db.prepare('UPDATE mmg_attempts SET result_code = ?, mmg_txn_id = ? WHERE merchant_txn_id = ?').run('0', r.transactionId, attempt.merchant_txn_id);
  recordGatewayPayment(salon, attempt.appointment_id, 'mmg', r.transactionId);
  back(attempt.code, 'paid');
};
app.get('/api/mmg/return/:slug', mmgReturn);
app.post('/api/mmg/return/:slug', express.urlencoded({ extended: false, limit: '20kb' }), mmgReturn);

// ---------- PayPal checkout ----------
// Client taps "Pay with PayPal": create an order for the USD deposit and hand back PayPal's approval page.
app.post('/api/public/:slug/appointments/:code/paypal-checkout', limit('paypal', 20, 3600e3), async (req, res) => {
  const salon = openSalon(req, res);
  if (!salon) return;
  if (!paypal.configured(salon)) return bad(res, 'This salon does not take PayPal checkout yet.', 409);
  const a = payableAppt(req, res, salon);
  if (!a) return;
  const amountUsd = paypal.usdFor(salon, a.deposit);
  try {
    const order = await paypal.createOrder(salon, {
      amountUsd, reference: a.code, description: `Deposit ${a.code}: ${a.service_name}`, requestId: crypto.randomUUID(),
      returnUrl: `${BASE_URL}/api/paypal/return/${salon.slug}`, cancelUrl: `${BASE_URL}/api/paypal/cancel/${salon.slug}`,
    });
    db.prepare('INSERT INTO paypal_attempts (order_id, appointment_id, amount_usd) VALUES (?,?,?)').run(order.id, a.id, amountUsd);
    res.json({ url: order.approveUrl });
  } catch (e) {
    console.error('PayPal checkout error', e.message);
    bad(res, 'PayPal payment could not be started. Please try again or choose another way to pay.', 502);
  }
});

// PayPal sends the client back here with ?token=<order id>. Capturing the order is what takes the money.
app.get('/api/paypal/return/:slug', async (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return res.status(404).send('Salon not found.');
  const back = (code, flag) => res.redirect(`/s/${encodeURIComponent(salon.slug)}?${code ? `code=${encodeURIComponent(code)}&` : ''}paypal=${flag}`);
  const orderId = str(req.query.token, 64);
  const attempt = orderId && db.prepare(`SELECT t.*, a.code FROM paypal_attempts t JOIN appointments a ON a.id = t.appointment_id
                                         WHERE t.order_id = ? AND a.salon_id = ?`).get(orderId, salon.id);
  if (!attempt) return back('', 'error');
  if (attempt.status === 'completed') return back(attempt.code, 'paid'); // already processed (page refresh / repeat)
  if (!paypal.configured(salon)) return back(attempt.code, 'error');

  let r;
  try { r = await paypal.capture(salon, orderId, `capture-${orderId}`); }
  catch (e) { console.error('PayPal capture error', e.message); return back(attempt.code, 'error'); }

  if (r.status === 'failed') {
    db.prepare("UPDATE paypal_attempts SET status = 'failed' WHERE order_id = ?").run(orderId);
    return back(attempt.code, 'failed');
  }
  if (!r.captureId || db.prepare('SELECT 1 FROM paypal_attempts WHERE capture_id = ? AND order_id <> ?').get(r.captureId, orderId)) {
    console.error('PayPal capture without a usable capture ID', orderId);
    return back(attempt.code, 'error');
  }
  const amountOk = r.currency === 'USD' && Number(r.amount) >= Number(attempt.amount_usd);
  if (r.status === 'completed' && amountOk) {
    db.prepare("UPDATE paypal_attempts SET status = 'completed', capture_id = ? WHERE order_id = ?").run(r.captureId, orderId);
    recordGatewayPayment(salon, attempt.appointment_id, 'paypal', r.captureId);
    return back(attempt.code, 'paid');
  }
  // Money is on its way but not final (PayPal review, eCheck) or the amount looks wrong: the owner checks it.
  if (!amountOk) console.error('PayPal amount mismatch', orderId, r.amount, r.currency, 'expected', attempt.amount_usd);
  db.prepare("UPDATE paypal_attempts SET status = 'pending', capture_id = ? WHERE order_id = ?").run(r.captureId, orderId);
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(attempt.appointment_id);
  if (['pending_payment', 'expired'].includes(a.status)) {
    db.prepare(`UPDATE appointments SET status = 'payment_submitted', payment_ref = ?, pay_method = 'paypal_checkout', payment_submitted_at = datetime('now') WHERE id = ?`)
      .run(r.captureId, a.id);
  }
  notify('paypal_pending', salon, { ...a, payment_ref: r.captureId, pay_method: 'paypal_checkout' });
  back(attempt.code, 'pending');
});

app.get('/api/paypal/cancel/:slug', (req, res) => {
  const salon = getSalonBySlug(req.params.slug);
  if (!salon) return res.status(404).send('Salon not found.');
  const attempt = db.prepare(`SELECT a.code FROM paypal_attempts t JOIN appointments a ON a.id = t.appointment_id
                              WHERE t.order_id = ? AND a.salon_id = ?`).get(str(req.query.token, 64), salon.id);
  res.redirect(`/s/${encodeURIComponent(salon.slug)}?${attempt ? `code=${encodeURIComponent(attempt.code)}&` : ''}paypal=cancelled`);
});

// ---------- owner API ----------
const admin = express.Router();
admin.use(requireOwner);

admin.get('/me', (req, res) => {
  const { salon, owner } = req;
  res.json({
    owner: { name: owner.name, email: owner.email, platformAdmin: isPlatformAdmin(owner), emailVerified: Boolean(owner.email_verified) },
    live: takingBookings(salon), suspended: Boolean(salon.suspended_at),
    payments: {
      cash: Boolean(salon.pay_cash), usdRate: salon.usd_rate, paypalMe: salon.paypal_me,
      paypal: { enabled: Boolean(salon.paypal_enabled), ready: paypal.configured(salon), mode: salon.paypal_mode, clientId: salon.paypal_client_id, hasSecret: Boolean(salon.paypal_secret) },
    },
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
      // Safe to show: this is the public half of the salon's own key, which they give to MMG.
      salonPublicKey: mmg.publicFromPrivate(salon.mmg_private_key),
      responseUrl: `${BASE_URL}/api/mmg/return/${salon.slug}`,
    },
    notify: { emailAvailable: emailEnabled(), email: Boolean(owner.notify_email) },
    clientEmails: { enabled: Boolean(salon.client_emails), reminderHours: salon.reminder_hours },
  });
});

// MMG Merchant Checkout credentials. Blank secret fields keep the stored value.
admin.put('/mmg', (req, res) => {
  const b = req.body || {}, s = req.salon;
  const pub = b.publicKey ? String(b.publicKey).trim().slice(0, 10000) : s.mmg_public_key;
  const priv = b.privateKey ? String(b.privateKey).trim().slice(0, 10000) : open(s.mmg_private_key);
  const keyErr = mmg.checkKey(pub, 'public') || mmg.checkKey(priv, 'private');
  if (keyErr) return bad(res, keyErr);
  const merchantId = str(b.merchantId ?? s.mmg_merchant_id, 30);
  if (merchantId && !/^\d{7,15}$/.test(merchantId)) return bad(res, 'Merchant ID should be the number on your MMG merchant account (digits only).');
  const next = {
    mmg_api_enabled: b.enabled ? 1 : 0, mmg_mode: b.mode === 'live' ? 'live' : 'sandbox', mmg_merchant_id: merchantId,
    mmg_client_id: str(b.clientId ?? s.mmg_client_id, 120), mmg_secret_key: b.secretKey ? seal(str(b.secretKey, 200)) : s.mmg_secret_key,
    mmg_public_key: pub, mmg_private_key: seal(priv),
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

// Create this salon's key pair so the owner doesn't have to make one. The private half stays on the server;
// the public half is shown in Settings for them to give MMG. Replacing a key breaks checkout until MMG has
// the new public key, so that needs replace: true and turns online payments off.
admin.post('/mmg/keypair', limit('mmgkey', 10, 3600e3), async (req, res) => {
  const s = req.salon;
  if (s.mmg_private_key && !req.body?.replace) return bad(res, 'This salon already has a key. Confirm to replace it.', 409);
  try {
    const { privateKey } = await mmg.generateKeyPair();
    const off = s.mmg_private_key ? 0 : s.mmg_api_enabled;
    db.prepare('UPDATE salons SET mmg_private_key = ?, mmg_api_enabled = ? WHERE id = ?').run(seal(privateKey), off, s.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('MMG key generation failed', e.message);
    bad(res, 'The key could not be created. Please try again.', 500);
  }
});

// Cash, PayPal.me and PayPal checkout. Blank secret keeps the stored one.
admin.put('/payments', limit('payset', 30, 3600e3), async (req, res) => {
  const b = req.body || {}, s = req.salon;
  const rate = Number(b.usdRate ?? s.usd_rate);
  if (!(rate >= 0 && rate < 100000)) return bad(res, 'The US dollar rate should be how many GYD make 1 USD, for example 210.');
  const me = str(b.paypalMe ?? s.paypal_me, 40).replace(/^.*paypal\.me\//i, '').replace(/\/.*$/, '');
  if (me && !paypal.validMeName(me)) return bad(res, 'PayPal.me name should be letters and numbers only, as in paypal.me/yourname.');
  if (me && !(rate > 0)) return bad(res, 'Set the US dollar rate so PayPal deposits can be worked out in USD.');
  const next = {
    pay_cash: b.cash ? 1 : 0, usd_rate: rate, paypal_me: me,
    paypal_enabled: b.paypalEnabled ? 1 : 0, paypal_mode: b.paypalMode === 'live' ? 'live' : 'sandbox',
    paypal_client_id: str(b.paypalClientId ?? s.paypal_client_id, 200),
    paypal_secret: b.paypalSecret ? seal(str(b.paypalSecret, 200)) : s.paypal_secret,
  };
  if (next.paypal_enabled) {
    if (!next.paypal_client_id || !next.paypal_secret) return bad(res, 'Enter the PayPal client ID and secret before turning PayPal checkout on.');
    if (!(rate > 0)) return bad(res, 'Set the US dollar rate before turning PayPal checkout on.');
    // Only call PayPal when something it cares about changed.
    if (b.paypalSecret || next.paypal_client_id !== s.paypal_client_id || next.paypal_mode !== s.paypal_mode || !s.paypal_enabled) {
      try { await paypal.accessToken({ ...s, ...next }); } catch (e) { return bad(res, e.message); }
    }
  }
  db.prepare(`UPDATE salons SET pay_cash=?, usd_rate=?, paypal_me=?, paypal_enabled=?, paypal_mode=?, paypal_client_id=?, paypal_secret=? WHERE id=?`)
    .run(next.pay_cash, next.usd_rate, next.paypal_me, next.paypal_enabled, next.paypal_mode, next.paypal_client_id, next.paypal_secret, s.id);
  res.json({ ok: true });
});

// ---------- closed days ----------
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
admin.get('/closures', (req, res) => {
  const today = nowLocal(req.salon.timezone).slice(0, 10);
  res.json(db.prepare('SELECT id, start_date AS start, end_date AS end, note FROM closures WHERE salon_id = ? AND end_date >= ? ORDER BY start_date')
    .all(req.salon.id, today));
});
admin.post('/closures', (req, res) => {
  const start = str(req.body?.start, 10), end = str(req.body?.end, 10) || start, note = str(req.body?.note, 80);
  if (!isDate(start) || !isDate(end) || end < start) return bad(res, 'Choose a start date, and an end date on or after it.');
  if ((Date.parse(end) - Date.parse(start)) / 864e5 > 366) return bad(res, 'Closures can be at most a year long.');
  const id = db.prepare('INSERT INTO closures (salon_id, start_date, end_date, note) VALUES (?,?,?,?)').run(req.salon.id, start, end, note).lastInsertRowid;
  // Existing bookings on those days are left alone, but the owner should know about them.
  const affected = db.prepare(`SELECT COUNT(*) n FROM appointments WHERE salon_id = ? AND status IN ('pending_payment','payment_submitted','confirmed')
    AND start_local >= ? AND start_local <= ?`).get(req.salon.id, start + 'T00:00', end + 'T23:59').n;
  res.json({ id, affected });
});
admin.delete('/closures/:id', (req, res) => {
  db.prepare('DELETE FROM closures WHERE id = ? AND salon_id = ?').run(Number(req.params.id), req.salon.id);
  res.json({ ok: true });
});

// Emails to clients (confirmation, reminder, cancellation) and when the reminder goes out.
admin.put('/client-emails', (req, res) => {
  const hours = Number(req.body?.reminderHours);
  if (![0, 2, 12, 24, 48].includes(hours)) return bad(res, 'Choose when the reminder goes out.');
  db.prepare('UPDATE salons SET client_emails = ?, reminder_hours = ? WHERE id = ?').run(req.body?.enabled ? 1 : 0, hours, req.salon.id);
  res.json({ ok: true });
});

admin.post('/verify/resend', limit('verifyresend', 3, 3600e3), async (req, res) => {
  if (req.owner.email_verified) return res.json({ ok: true });
  if (!emailEnabled()) return bad(res, 'Email is not set up on this server.', 409);
  await sendVerifyEmail(req.owner);
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
  sendClientConfirmation(req.salon, a);
  await google.syncConfirmed(req.salon, { ...a, status: 'confirmed' });
  res.json({ ok: true });
});

admin.post('/appointments/:id/cancel', async (req, res) => {
  const a = ownAppt(req);
  if (!a) return bad(res, 'Appointment not found.', 404);
  if (['cancelled', 'expired'].includes(a.status)) return res.json({ ok: true });
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(a.id);
  notifyClient('cancelled', req.salon, a);
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

// ---------- platform (master account) API ----------
// Read-only stats across every salon, for emails listed in PLATFORM_ADMINS. Returns no client details
// (names, phones, notes) and no secrets (MMG keys, password hashes, Google tokens).
const platform = express.Router();
platform.use(requireOwner, (req, res, next) => (isPlatformAdmin(req.owner) ? next() : bad(res, 'Not found.', 404)));

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'salonbook-backups');
function lastBackup() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db.gz'));
    const latest = Math.max(...files.map((f) => fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs));
    return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
  } catch { return null; }
}
// Written by the backup script after each Google Drive upload: "<ISO time> ok|failed|skipped <detail>".
function offsiteStatus() {
  try {
    const [when, result, ...rest] = fs.readFileSync(path.join(BACKUP_DIR, 'offsite-status'), 'utf8').trim().split(' ');
    return { when, result, detail: rest.join(' ') };
  } catch { return null; }
}
function dbBytes() {
  const file = process.env.DB_PATH || path.join(__dirname, 'salonbook.db');
  return ['', '-wal'].reduce((n, ext) => { try { return n + fs.statSync(file + ext).size; } catch { return n; } }, 0);
}

platform.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  const totals = {
    salons: one('SELECT COUNT(*) n FROM salons').n,
    salons30: one("SELECT COUNT(*) n FROM salons WHERE created_at >= datetime('now','-30 days')").n,
    owners: one('SELECT COUNT(*) n FROM owners').n,
    services: one('SELECT COUNT(*) n FROM services WHERE active = 1').n,
    bookings: one('SELECT COUNT(*) n FROM appointments').n,
    bookings30: one("SELECT COUNT(*) n FROM appointments WHERE created_at >= datetime('now','-30 days')").n,
    ...one(`SELECT COALESCE(SUM(deposit),0) deposits, COALESCE(SUM(price),0) value, COUNT(*) confirmed,
                   COALESCE(SUM(paid_via = 'mmg'),0) paidByMmg, COALESCE(SUM(paid_via = 'paypal'),0) paidByPaypal,
                   COALESCE(SUM(pay_method = 'cash'),0) cash FROM appointments WHERE status = 'confirmed'`),
    mmgLive: one("SELECT COUNT(*) n FROM salons WHERE mmg_api_enabled = 1 AND mmg_mode = 'live'").n,
    mmgSandbox: one("SELECT COUNT(*) n FROM salons WHERE mmg_api_enabled = 1 AND mmg_mode <> 'live'").n,
    googleOwners: one('SELECT COUNT(*) n FROM owners WHERE google_refresh_token IS NOT NULL').n,
  };
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM appointments GROUP BY status').all().map((r) => [r.status, r.n]));

  // Last 12 weeks, oldest first. Week 11 is the 7 days ending now.
  const WEEKS = 12, weekMs = 7 * 864e5, now = Date.now();
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: new Date(now - (WEEKS - i) * weekMs).toISOString().slice(0, 10), bookings: 0, signups: 0 }));
  const bucket = (ts, key) => {
    const i = WEEKS - 1 - Math.floor((now - Date.parse(`${ts.replace(' ', 'T')}Z`)) / weekMs);
    if (i >= 0 && i < WEEKS) weeks[i][key]++;
  };
  for (const r of db.prepare("SELECT created_at FROM appointments WHERE created_at >= datetime('now','-84 days')").all()) bucket(r.created_at, 'bookings');
  for (const r of db.prepare("SELECT created_at FROM salons WHERE created_at >= datetime('now','-84 days')").all()) bucket(r.created_at, 'signups');

  const salons = db.prepare(`
    SELECT s.id, s.slug, s.name, s.created_at AS createdAt, s.mmg_api_enabled AS mmgOn, s.mmg_mode AS mmgMode, s.mmg_number <> '' AS manualMmg,
      s.suspended_at AS suspendedAt, s.pay_cash AS cash, s.paypal_enabled AS paypalOn, s.paypal_mode AS paypalMode, s.paypal_me <> '' AS paypalMe,
      EXISTS (SELECT 1 FROM owners o WHERE o.salon_id = s.id AND o.email_verified = 1) AS verified,
      (SELECT group_concat(o.email, ', ') FROM owners o WHERE o.salon_id = s.id) AS owners,
      (SELECT COUNT(*) FROM owners o WHERE o.salon_id = s.id AND o.google_refresh_token IS NOT NULL) AS google,
      (SELECT COUNT(*) FROM services v WHERE v.salon_id = s.id AND v.active = 1) AS services,
      COUNT(a.id) AS bookings,
      COALESCE(SUM(a.created_at >= datetime('now','-30 days')),0) AS bookings30,
      COALESCE(SUM(a.status = 'confirmed'),0) AS confirmed,
      COALESCE(SUM(a.status = 'payment_submitted'),0) AS awaitingOwner,
      COALESCE(SUM(CASE WHEN a.status = 'confirmed' THEN a.deposit END),0) AS deposits,
      MAX(a.created_at) AS lastBooking
    FROM salons s LEFT JOIN appointments a ON a.salon_id = s.id
    GROUP BY s.id ORDER BY bookings30 DESC, s.created_at DESC`).all()
    .map((s) => ({
      ...s, url: `${BASE_URL}/s/${s.slug}`, mmgOn: Boolean(s.mmgOn), manualMmg: Boolean(s.manualMmg),
      cash: Boolean(s.cash), paypalOn: Boolean(s.paypalOn), paypalMe: Boolean(s.paypalMe), verified: Boolean(s.verified),
      mine: s.id === req.owner.salon_id,
    }));

  res.json({
    generatedAt: new Date().toISOString(), totals, byStatus, weeks, salons,
    system: {
      baseUrl: BASE_URL, node: process.version, uptimeSec: Math.round(process.uptime()), dbBytes: dbBytes(), lastBackup: lastBackup(), offsite: offsiteStatus(),
      email: emailEnabled(), google: google.enabled(), signup: REGISTRATION_CODE ? 'code' : 'open', platformAdmins: PLATFORM_ADMINS.size,
    },
  });
});
// Suspend or restore a salon. Suspended: booking page off, its owners can't sign in. Payments already
// on their way (MMG/PayPal returns) are still recorded. You can't suspend the salon your own login belongs to.
platform.post('/salons/:id/suspend', (req, res) => {
  const s = db.prepare('SELECT id, name FROM salons WHERE id = ?').get(Number(req.params.id));
  if (!s) return bad(res, 'Salon not found.', 404);
  if (s.id === req.owner.salon_id) return bad(res, 'You can’t suspend the salon your own login belongs to.', 409);
  const on = Boolean(req.body?.suspended);
  db.prepare(`UPDATE salons SET suspended_at = ${on ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(s.id);
  console.log(`Platform: ${req.owner.email} ${on ? 'suspended' : 'restored'} salon ${s.id} (${s.name})`);
  res.json({ ok: true });
});
app.use('/api/platform', platform);

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
      .run(seal(t.refresh_token), google.emailFromIdToken(t.id_token), st.oid);
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

// ---------- client reminders ----------
function sendDueReminders() {
  if (!emailEnabled()) return;
  try {
    const salons = db.prepare('SELECT * FROM salons WHERE client_emails = 1 AND reminder_hours > 0 AND suspended_at IS NULL').all();
    for (const salon of salons) {
      const now = nowLocal(salon.timezone), until = addMinutes(now, salon.reminder_hours * 60);
      const due = db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND status = 'confirmed' AND client_email <> ''
        AND reminder_sent_at IS NULL AND start_local > ? AND start_local <= ?`).all(salon.id, now, until);
      for (const a of due) {
        if (!db.prepare("UPDATE appointments SET reminder_sent_at = datetime('now') WHERE id = ? AND reminder_sent_at IS NULL").run(a.id).changes) continue;
        // Booked and confirmed only shortly before the window? The "you're booked" email already covers it.
        const sentAt = a.client_confirm_sent_at ? Date.parse(a.client_confirm_sent_at.replace(' ', 'T') + 'Z') : 0;
        if (Date.now() - sentAt < Math.min(6, salon.reminder_hours / 2) * 3600e3) continue;
        notifyClient('reminder', salon, a, { link: clientLink(salon, a) });
      }
    }
  } catch (e) { console.error('Reminder sweep failed:', e.message); }
}
const SWEEP_MS = Number(process.env.REMINDER_SWEEP_MS) || 5 * 60e3;
setTimeout(sendDueReminders, Math.min(SWEEP_MS, 30e3)).unref();
setInterval(sendDueReminders, SWEEP_MS).unref();

// ---------- pages ----------
// Privacy policy and terms (linked from the sign-in and booking pages, and from Google's OAuth consent screen).
// Templates live in legal/ (outside public/) so the {{placeholders}} are never served raw.
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const OPERATOR_NAME = str(process.env.OPERATOR_NAME);
const CONTACT_EMAIL = str(process.env.CONTACT_EMAIL);
const legalPage = (file) => {
  const html = fs.readFileSync(path.join(__dirname, 'legal', file), 'utf8')
    .replaceAll('{{SITE}}', escHtml(BASE_URL.replace(/^https?:\/\//, '')))
    .replaceAll('{{OPERATED_BY}}', OPERATOR_NAME ? ` It is operated by ${escHtml(OPERATOR_NAME)}.` : '')
    .replaceAll('{{CONTACT}}', CONTACT_EMAIL
      // email_off: stops Cloudflare's email obfuscation, which shows "[email protected]" to readers without JavaScript (Google's reviewers included)
      ? `<!--email_off--><a href="mailto:${escHtml(CONTACT_EMAIL)}">${escHtml(CONTACT_EMAIL)}</a><!--/email_off-->.`
      : 'reply to any email SalonBook has sent you, or ask the salon you booked with to pass your request on.');
  return (req, res) => res.type('html').send(html);
};
app.get('/privacy', legalPage('privacy.html'));
app.get('/terms', legalPage('terms.html'));
app.get('/s/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => bad(res, 'Not found.', 404));
// Never send stack traces to the browser (Express does by default outside NODE_ENV=production).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (code === 500) console.error(err);
  res.status(code).json({ error: code === 500 ? 'Something went wrong. Please try again.' : 'That request could not be read.' });
});

app.listen(PORT, () => console.log(`SalonBook running at ${BASE_URL} (Google sync ${google.enabled() ? 'ON' : 'OFF – set GOOGLE_CLIENT_ID/SECRET'}, email ${emailEnabled() ? 'ON' : 'OFF – set SMTP_*'})`));
