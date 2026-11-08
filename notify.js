// Owner notifications. Each channel is a function (salon, owners, message) => Promise.
// Email is the only channel today; add WhatsApp/SMS by pushing another entry onto CHANNELS.
const db = require('./db');

let transport = null;
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
};
const emailEnabled = () => Boolean(SMTP.host && SMTP.user && SMTP.pass);

function mailer() {
  if (!transport) {
    transport = require('nodemailer').createTransport({
      host: SMTP.host, port: SMTP.port, secure: SMTP.port === 465, auth: { user: SMTP.user, pass: SMTP.pass },
    });
  }
  return transport;
}

async function email(salon, owners, msg) {
  if (!emailEnabled()) return;
  const to = owners.filter((o) => o.notify_email).map((o) => o.email);
  if (!to.length) return;
  await mailer().sendMail({
    from: `"SalonBook · ${salon.name.replace(/"/g, '')}" <${SMTP.from}>`,
    to: to.join(', '),
    subject: msg.subject,
    text: msg.text,
  });
}

const CHANNELS = [email];

const money = (n) => 'GYD ' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const when = (local) => {
  const d = new Date(local + ':00Z');
  return d.toLocaleString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
};
const details = (a) => [
  `Client:   ${a.client_name}  (${a.client_phone}${a.client_email ? ', ' + a.client_email : ''})`,
  `Service:  ${a.service_name}`,
  `When:     ${when(a.start_local)}`,
  `Price:    ${money(a.price)}  (deposit ${money(a.deposit)})`,
  `Code:     ${a.code}`,
  a.notes ? `Notes:    ${a.notes}` : '',
].filter(Boolean).join('\n');

const TEMPLATES = {
  booked: (a) => ({
    subject: `New booking: ${a.client_name}, ${when(a.start_local)}`,
    lead: 'A client just booked. The slot is held until they pay the deposit.',
  }),
  payment_reported: (a) => ({
    subject: `Check MMG: ${a.client_name} says they paid ${money(a.deposit)}`,
    lead: `The client reported MMG transaction ID ${a.payment_ref}. Check that the money arrived, then confirm the booking in your dashboard.`,
  }),
  mmg_paid: (a) => ({
    subject: `Paid via MMG: ${a.client_name}, ${when(a.start_local)}`,
    lead: `MMG confirmed the ${money(a.deposit)} deposit (transaction ${a.payment_ref}). The booking is confirmed automatically.`,
  }),
  mmg_paid_conflict: (a) => ({
    subject: `Action needed: ${a.client_name} paid but the booking can't be confirmed`,
    lead: `MMG confirmed the ${money(a.deposit)} deposit (transaction ${a.payment_ref}), but ${a.status === 'cancelled'
      ? 'the booking had already been cancelled'
      : 'the hold had already expired and the slot was taken'}. Contact the client to rebook or refund.`,
  }),
  test: () => ({ subject: 'SalonBook test email', lead: 'Email notifications are working.' }),
};

// Fire-and-forget: a failed notification must never break a booking.
// opts.to: send only to this address (used by the "send test email" button).
function notify(event, salon, appt, opts = {}) {
  const owners = opts.to ? [{ email: opts.to, notify_email: 1 }]
    : db.prepare('SELECT email, notify_email FROM owners WHERE salon_id = ?').all(salon.id);
  const t = TEMPLATES[event](appt || {});
  const msg = { subject: t.subject, text: `${t.lead}\n\n${appt ? details(appt) + '\n\n' : ''}— ${salon.name} on SalonBook` };
  return Promise.allSettled(CHANNELS.map((ch) => ch(salon, owners, msg))).then((rs) => {
    for (const r of rs) if (r.status === 'rejected') console.error(`Notify (${event}) failed:`, r.reason?.message || r.reason);
    return rs;
  });
}

module.exports = { notify, emailEnabled };
