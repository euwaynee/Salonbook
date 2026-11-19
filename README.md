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

### Platform (master) account

Put your owner login email in `PLATFORM_ADMINS` in `.env` (comma-separate several) and restart. That login then
gets a **Platform** button on the dashboard, opening `/platform.html`: totals, bookings and new salons per week,
every salon with its bookings, deposits and MMG status, and server health (database size, last backup).
It never shows clients' names or phone numbers, or anyone's keys or passwords. Its only action is **Suspend / Restore**
on each salon: a suspended salon's booking page goes offline and its owners can't sign in; nothing is deleted, and
payments already under way are still recorded. You can't suspend the salon your own login belongs to.

### Email confirmation

When email is set up (SMTP in `.env`), a new salon's booking page stays off until an owner clicks the confirmation
link emailed at sign-up (valid 48 hours; the dashboard has a "Send it again" button). Accounts that existed before
this feature count as confirmed. Without SMTP, new accounts start confirmed, since there's no way to send the link.

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
- **Stored secrets are encrypted** (AES-256-GCM): MMG secret and private keys, PayPal secrets and Google Calendar refresh tokens. The key is `DATA_KEY` in `.env` or, if unset, the `.data_key` file created on first run. A copy of `salonbook.db` alone can't reveal them, and **without the key they can't be recovered**, so the backup includes it. Older plain-text values are encrypted automatically at startup (`secrets.js`).

## Backups

`backup.sh` runs nightly from cron (`30 3 * * * /home/casper/salonbook/backup.sh >> …/salonbook-backups/backup.log 2>&1`):

1. A consistent, integrity-checked snapshot of the database, plus `.env`, `.data_key` and `.session_secret`, kept 30 days in `../salonbook-backups/`.
2. If Google Drive is connected, all of that is encrypted (GPG, AES-256) with the passphrase in `~/.config/salonbook/backup-pass` and uploaded to `SalonBook-backups/` on Drive, kept 60 days. The Platform page shows the last upload and flags failures.

**Keep a copy of the passphrase somewhere other than this server** (a password manager). If the server is lost, the Drive copies can't be opened without it.

**Connect Google Drive** (once): run `~/.local/bin/rclone config` → `n` (new remote) → name it `gdrive` → storage `drive` → leave client ID/secret blank → scope `drive.file` (rclone can only see files it created) → no advanced config → for "use web browser", answer `n` on a server without a browser and follow the `rclone authorize "drive"` instructions on a computer that has one → not a shared drive → confirm. Then test with `./backup.sh` and check the Platform page.

**Restore** on a fresh server:

```sh
rclone copy gdrive:SalonBook-backups/salonbook-<date>.tar.gpg .
gpg --batch --passphrase-file backup-pass -d salonbook-<date>.tar.gpg | tar -xf -
gunzip -c salonbook-<date>.db.gz > salonbook/salonbook.db
cp env-<date> salonbook/.env; cp data_key-<date> salonbook/.data_key; cp session_secret-<date> salonbook/.session_secret
chmod 600 salonbook/.env salonbook/.data_key salonbook/.session_secret
```

## MMG online checkout (optional)

If a salon has an **MMG merchant account**, clients can pay the deposit on MMG's own payment page and the booking confirms itself. No owner tap is needed.

1. Apply for MMG e-commerce / Merchant Checkout access ([mmg.gy/developer](https://mmg.gy/developer/)). MMG gives you a **Merchant ID**, **Client ID**, **Secret Key** and RSA key pair(s).
2. Give MMG your **Response URL**: `BASE_URL/api/mmg/return/<your-salon>` (shown under Settings → MMG online payments). It must be a public HTTPS address in live mode.
3. Settings → **MMG online payments**: paste the IDs, secret key and MMG's public key, then click **Create my public key** and send that key to MMG. (A salon that already gave MMG its own key can paste the private key instead.) Start in **Sandbox**, make a test booking, then switch to **Live**.

How it works: the payment request is encrypted with MMG's public key (RSA-OAEP, SHA-256 by default) and the client is redirected to MMG. MMG redirects back with an encrypted result, which is decrypted with your private key. Result code `0` confirms the booking, adds it to Google Calendar and emails the owners. If the client pays after the hold expired and the slot has been taken, the booking is left as "Payment reported" and the owners are emailed to sort it out.

The manual flow (client sends to your MMG number and types the transaction ID) stays available as a fallback.

> Built from MMG's published Merchant Checkout docs plus a community WooCommerce plugin. MMG's docs don't state the RSA padding. If the sandbox returns "Token Decryption Failed", set `MMG_OAEP_HASH=sha1` in `.env` and restart.

## Cash and PayPal (optional)

Under Settings → **Other ways to pay** each salon can add, alongside MMG:

- **Cash at the salon.** The client books with no deposit; the booking shows as "Payment reported · Cash at the salon" and the owner confirms or cancels it.
- **PayPal.me.** The client sends the deposit through `paypal.me/<name>/<amount>USD` and types in the PayPal transaction ID; the owner checks it and confirms (like manual MMG).
- **PayPal checkout.** The client pays on PayPal's page and the booking confirms itself. The salon creates a REST app at [developer.paypal.com](https://developer.paypal.com) (Apps & Credentials) and pastes its client ID and secret; SalonBook checks them with PayPal on save. Money is only captured when the client returns to SalonBook, so an abandoned checkout never charges anyone. A capture PayPal marks pending, or one for the wrong amount, is left for the owner to check.

PayPal doesn't support GYD, so PayPal deposits are charged in **USD at the salon's own rate** (GYD per 1 USD), rounded up to the cent. The salon's PayPal account must be able to receive payments: accounts registered in Guyana generally can only send, so this suits salons with a PayPal account from another country.

## Email notifications

Owners get an email when a client books, reports a manual MMG or PayPal.me payment, chooses cash, or pays through MMG or PayPal checkout. Configure SMTP in `.env` (see `.env.example`; for Gmail use an App Password). Each owner can turn their own emails on or off, and send a test, under Settings → Notifications. Notification channels live in `notify.js`, so WhatsApp/SMS can be added there later.

## Forgotten passwords

**Forgot your password?** on the sign-in page emails a one-time link (valid 1 hour) to choose a new password. It needs SMTP set up as above. Without email, reset from the server's shell: `node reset-password.js <email>`.

## Privacy policy and terms

`/privacy` and `/terms` are served from the templates in `legal/` and are the links to give Google on the OAuth consent screen (authorized domain: the top-level domain of `BASE_URL`). Set `OPERATOR_NAME` and `CONTACT_EMAIL` in `.env` to show who runs the server and how to reach them. Keep the *Google user data* section in step with what `google.js` actually does.

## Not included (ideas for next)

SMS/WhatsApp notifications, client emails, per-stylist calendars, client self-cancel/reschedule, deposit refunds, closed days/holidays.
