# SalonBook

Multi-salon booking app. Each salon gets its own booking link; clients pay an MMG deposit; owners confirm and the appointment syncs to their Google Calendar.

## Run it

```bash
npm install
cp .env.example .env     # edit BASE_URL etc.
npm start                # http://localhost:3000
```

Requires Node 18+. Data lives in `salonbook.db` (SQLite) — back this file up.

1. Open the site → **Register your salon** (creates the salon + first owner).
2. **Services** tab: add services, durations, prices.
3. **Settings** tab: MMG number/name, deposit rule, opening hours, stylists working at once.
4. Share the booking link shown at the top of the dashboard (`/s/<your-salon>`).

Set `REGISTRATION_CODE` in `.env` if you don't want strangers creating salons on your server.

## How a booking works

1. Client picks service → date → time → enters name/phone. The slot is **held** (default 60 min).
2. Client is shown the deposit amount, your MMG number and a booking code to use as the MMG note. They pay in their MMG app, then enter the MMG transaction ID.
3. Owner sees **"Payment reported"** in the dashboard, checks the money arrived in MMG, and taps **Payment received – confirm**.
4. On confirm, the appointment is added to the owner's Google Calendar. Cancelling removes it.
5. If no payment is reported before the hold runs out, the slot is released automatically.

> **MMG note:** MMG has no public payment API that this app can use, so the owner verifies each deposit manually. That is deliberate — nothing is marked paid without the owner's tap. If you get MMG merchant API access later, the place to plug it in is the `/payment` and `/confirm` routes in `server.js`.

## Branding and QR code

- **Settings → Branding:** pick a brand colour and upload a logo (shrunk automatically). Both appear on that salon's booking page; each salon is styled independently, and salons that set nothing get the default plum colour. Pale colours are darkened automatically so the white header text stays readable.
- **Dashboard → "QR code for your shop":** a QR code pointing at the salon's booking link, with **Print poster** (salon name, logo, QR, link) and **Download QR (SVG)** for printing elsewhere. Set `BASE_URL` to your real public address *before* printing, because the QR encodes it.

## Google Calendar sync

Each owner connects **their own** Google account (Settings → Connect Google Calendar).

One-time setup by whoever runs the server:

1. Google Cloud Console → create a project → enable **Google Calendar API**.
2. **OAuth consent screen**: External; add the scope `.../auth/calendar.events`. Add your owners' Google emails as *Test users* (fine for a handful of salons; publish the app for wider use).
3. **Credentials → OAuth client ID → Web application**. Authorized redirect URI:
   `https://YOUR-DOMAIN/api/google/callback` (must equal `BASE_URL` + `/api/google/callback`).
4. Put the client ID/secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, restart.

Google requires **HTTPS** redirect URIs except for `localhost`, so a public deployment needs a domain with HTTPS (e.g. a Cloudflare Tunnel or a reverse proxy with a certificate). Sync is best-effort: if Google is unreachable, the booking still confirms.

## Design notes

- **Multi-tenant:** every owner API query is scoped to the signed-in owner's salon; owners from other salons can't see or touch each other's data.
- **Several owners per salon:** add co-owners under Settings; each connects their own calendar.
- **Double-booking:** availability is rechecked on the server at booking time. "Stylists working at once" lets a salon take more than one client per time slot.
- **Times** are stored as local wall-clock time in the salon's timezone (default `America/Guyana`).
- Passwords are bcrypt-hashed; sessions are signed HttpOnly cookies; booking/login endpoints are rate-limited.

## Not included (ideas for next)

SMS/WhatsApp reminders, per-stylist calendars, client self-cancel/reschedule, password reset by email, deposit refunds.
