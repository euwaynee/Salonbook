// Google Calendar sync using plain REST (no googleapis dependency).
// Each salon owner connects their own Google account via OAuth; we store the refresh token.
const db = require('./db');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const REDIRECT_URI = `${BASE_URL}/api/google/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
].join(' ');

const enabled = () => Boolean(CLIENT_ID && CLIENT_SECRET);

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // ensures a refresh token is returned
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token error');
  return data;
}

const exchangeCode = (code) =>
  tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI });

async function accessTokenFor(owner) {
  if (!owner.google_refresh_token) throw new Error('Google Calendar not connected');
  const t = await tokenRequest({ refresh_token: owner.google_refresh_token, grant_type: 'refresh_token' });
  return t.access_token;
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    return payload.email || null;
  } catch { return null; }
}

function eventBody(appt, salon) {
  const lines = [
    `Service: ${appt.service_name}`,
    `Client: ${appt.client_name} (${appt.client_phone})`,
    appt.client_email ? `Email: ${appt.client_email}` : null,
    `Deposit paid via MMG: GYD ${appt.deposit}${appt.payment_ref ? ` (ref ${appt.payment_ref})` : ''}`,
    appt.notes ? `Notes: ${appt.notes}` : null,
    `Booking code: ${appt.code}`,
  ].filter(Boolean);
  return {
    summary: `${appt.service_name} – ${appt.client_name}`,
    description: lines.join('\n'),
    location: salon.address || undefined,
    start: { dateTime: `${appt.start_local}:00`, timeZone: salon.timezone },
    end: { dateTime: `${appt.end_local}:00`, timeZone: salon.timezone },
  };
}

// All sync functions are best-effort: a Google outage must never block a booking.
async function createEvent(owner, salon, appt) {
  if (!enabled() || !owner.google_refresh_token) return null;
  const token = await accessTokenFor(owner);
  const cal = encodeURIComponent(owner.google_calendar_id || 'primary');
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventBody(appt, salon)),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Google create event failed');
  return data.id;
}

async function deleteEvent(owner, appt) {
  let ids = {};
  try { ids = JSON.parse(appt.google_event_id || '{}'); } catch {}
  const eventId = ids[owner.id];
  if (!enabled() || !owner.google_refresh_token || !eventId) return;
  const token = await accessTokenFor(owner);
  const cal = encodeURIComponent(owner.google_calendar_id || 'primary');
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${eventId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error('Google delete event failed');
}

// Sync a confirmed appointment to every owner of the salon.
async function syncConfirmed(salon, appt) {
  const owners = db.prepare('SELECT * FROM owners WHERE salon_id = ?').all(salon.id);
  const ids = {}; // owner id -> Google event id, so each owner's event can be removed later
  for (const o of owners) {
    try {
      const id = await createEvent(o, salon, appt);
      if (id) ids[o.id] = id;
    } catch (e) { console.error('Google sync failed for owner', o.id, e.message); }
  }
  if (Object.keys(ids).length) {
    db.prepare('UPDATE appointments SET google_event_id = ? WHERE id = ?').run(JSON.stringify(ids), appt.id);
  }
}

async function removeEvents(salon, appt) {
  const owners = db.prepare('SELECT * FROM owners WHERE salon_id = ?').all(salon.id);
  for (const o of owners) {
    try { await deleteEvent(o, appt); }
    catch (e) { console.error('Google delete failed for owner', o.id, e.message); }
  }
}

// When an owner connects Google later, push their salon's upcoming confirmed bookings to the new calendar.
async function backfillOwner(ownerId) {
  const owner = db.prepare('SELECT * FROM owners WHERE id = ?').get(ownerId);
  if (!owner) return;
  const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(owner.salon_id);
  const now = new Date().toLocaleString('sv-SE', { timeZone: salon.timezone, hour12: false }).replace(' ', 'T').slice(0, 16);
  const appts = db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND status = 'confirmed' AND start_local > ?`).all(salon.id, now);
  for (const a of appts) {
    try {
      const id = await createEvent(owner, salon, a);
      if (!id) continue;
      let ids = {};
      try { ids = JSON.parse(a.google_event_id || '{}'); } catch {}
      ids[owner.id] = id;
      db.prepare('UPDATE appointments SET google_event_id = ? WHERE id = ?').run(JSON.stringify(ids), a.id);
    } catch (e) { console.error('Backfill failed for appointment', a.id, e.message); }
  }
}

module.exports = { backfillOwner, enabled, authUrl, exchangeCode, emailFromIdToken, syncConfirmed, removeEvents };
