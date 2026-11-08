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

> **MMG note:** Without MMG merchant checkout set up, the owner verifies each deposit manually, and nothing is marked paid without the owner's tap. With it set up (see *MMG online checkout* below), MMG's own result confirms the booking.

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

## MMG online checkout (optional)

If a salon has an **MMG merchant account**, clients can pay the deposit on MMG's own payment page and the booking confirms itself. No owner tap is needed.

1. Apply for MMG e-commerce / Merchant Checkout access ([mmg.gy/developer](https://mmg.gy/developer/)). MMG gives you a **Merchant ID**, **Client ID**, **Secret Key** and RSA key pair(s).
2. Give MMG your **Response URL**: `BASE_URL/api/mmg/return/<your-salon>` (shown under Settings → MMG online payments). It must be a public HTTPS address in live mode.
3. Settings → **MMG online payments**: paste the IDs, secret key, MMG's public key and your private key. Start in **Sandbox**, make a test booking, then switch to **Live**.

How it works: the payment request is encrypted with MMG's public key (RSA-OAEP, SHA-256 by default) and the client is redirected to MMG. MMG redirects back with an encrypted result, which is decrypted with your private key. Result code `0` confirms the booking, adds it to Google Calendar and emails the owners. If the client pays after the hold expired and the slot has been taken, the booking is left as "Payment reported" and the owners are emailed to sort it out.

The manual flow (client sends to your MMG number and types the transaction ID) stays available as a fallback.

> Built from MMG's published Merchant Checkout docs plus a community WooCommerce plugin. MMG's docs don't state the RSA padding. If the sandbox returns "Token Decryption Failed", set `MMG_OAEP_HASH=sha1` in `.env` and restart.

## Email notifications

Owners get an email when a client books, reports a manual MMG payment, or pays through MMG checkout. Configure SMTP in `.env` (see `.env.example`; for Gmail use an App Password). Each owner can turn their own emails on or off, and send a test, under Settings → Notifications. Notification channels live in `notify.js`, so WhatsApp/SMS can be added there later.

## Not included (ideas for next)

SMS/WhatsApp notifications, client emails, per-stylist calendars, client self-cancel/reschedule, password reset by email, deposit refunds.
