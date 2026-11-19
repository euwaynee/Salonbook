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

// Account mail to one address (password resets). Ignores the notify_email preference.
async function sendMail(to, subject, text) {
  if (!emailEnabled()) throw new Error('Email is not configured');
  await mailer().sendMail({ from: `"SalonBook" <${SMTP.from}>`, to, subject, text });
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

const GATEWAY = { mmg: 'MMG', paypal: 'PayPal' };
const TEMPLATES = {
  booked: (a) => ({
    subject: `New booking: ${a.client_name}, ${when(a.start_local)}`,
    lead: 'A client just booked. The slot is held until they pay the deposit or choose to pay at the salon.',
  }),
  payment_reported: (a) => {
    const via = a.pay_method === 'paypal_me' ? 'PayPal' : 'MMG';
    return {
      subject: `Check ${via}: ${a.client_name} says they paid ${money(a.deposit)}`,
      lead: `The client reported ${via} transaction ID ${a.payment_ref}. Check that the money arrived, then confirm the booking in your dashboard.`,
    };
  },
  cash_chosen: (a) => ({
    subject: `Cash booking: ${a.client_name}, ${when(a.start_local)}`,
    lead: `The client chose to pay ${money(a.price)} in cash at the salon, with no deposit. Confirm or cancel the booking in your dashboard.`,
  }),
  paid_online: (a) => ({
    subject: `Paid via ${GATEWAY[a.paid_via]}: ${a.client_name}, ${when(a.start_local)}`,
    lead: `${GATEWAY[a.paid_via]} confirmed the ${money(a.deposit)} deposit (transaction ${a.payment_ref}). The booking is confirmed automatically.`,
  }),
  paid_online_conflict: (a) => ({
    subject: `Action needed: ${a.client_name} paid but the booking can't be confirmed`,
    lead: `${GATEWAY[a.paid_via]} confirmed the ${money(a.deposit)} deposit (transaction ${a.payment_ref}), but ${a.status === 'cancelled'
      ? 'the booking had already been cancelled'
      : 'the hold had already expired and the slot was taken'}. Contact the client to rebook or refund.`,
  }),
  client_cancelled: (a) => ({
    subject: `Cancelled by client: ${a.client_name}, ${when(a.start_local)}`,
    lead: `The client cancelled through their booking link. The time is free again.${a.payment_ref || a.paid_via
      ? ` They had paid a ${money(a.deposit)} deposit (ref ${a.payment_ref || 'n/a'}); refunds are up to you and your cancellation policy.` : ''}`,
  }),
  client_rescheduled: (a) => ({
    subject: `Moved by client: ${a.client_name}, now ${when(a.start_local)}`,
    lead: `The client moved their appointment from ${when(a.old_start)} to ${when(a.start_local)}.${a.status === 'confirmed' ? ' Your Google Calendar is updated if connected.' : ''}`,
  }),
  paypal_pending: (a) => ({
    subject: `Check PayPal: ${a.client_name}'s deposit isn't final yet`,
    lead: `PayPal took the deposit (transaction ${a.payment_ref}) but marked it pending, or the amount didn't match. Check it in your PayPal account, then confirm the booking in your dashboard.`,
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

// ---------- emails to the client ----------
// Sent only when the client gave an email and the salon has client emails on. Replies aren't read, so every
// email points the client to the salon's phone instead.
const CLIENT_TEMPLATES = {
  confirmed: (a, s) => ({
    subject: `You're booked at ${s.name}: ${when(a.start_local)}`,
    lead: 'Your appointment is confirmed. See you then!',
  }),
  reminder: (a, s) => ({
    subject: `Reminder: ${a.service_name} at ${s.name}, ${when(a.start_local)}`,
    lead: 'A reminder of your upcoming appointment.',
  }),
  cancelled: (a, s) => ({
    subject: `Your appointment at ${s.name} was cancelled`,
    lead: a.cancelled_by === 'client'
      ? `As you asked, your ${a.service_name} appointment on ${when(a.start_local)} is cancelled.${a.payment_ref || a.paid_via ? ' About your deposit, please contact the salon.' : ''}`
      : `Your ${a.service_name} appointment on ${when(a.start_local)} has been cancelled by the salon. If you didn't expect this, please contact them.`,
  }),
  rescheduled: (a, s) => ({
    subject: `Your appointment at ${s.name} is now ${when(a.start_local)}`,
    lead: 'Your appointment has been moved to the new time below.',
  }),
};
const toPay = (a) => (a.pay_method === 'cash' ? a.price : Math.max(0, a.price - a.deposit));

function notifyClient(kind, salon, a, { link } = {}) {
  if (!emailEnabled() || !salon.client_emails || !a.client_email) return Promise.resolve(false);
  const t = CLIENT_TEMPLATES[kind](a, salon);
  const lines = [
    `Hi ${a.client_name},`, '', t.lead, '',
    `Service:  ${a.service_name}`,
    `When:     ${when(a.start_local)}`,
    salon.address ? `Where:    ${salon.address}` : null,
    `Code:     ${a.code}`,
    kind !== 'cancelled' && toPay(a) > 0 ? `To pay at the salon: ${money(toPay(a))}${a.pay_method === 'cash' ? ' (cash)' : ''}` : null,
    '',
    kind !== 'cancelled' && link ? `Your booking: ${link}` : null,
    kind !== 'cancelled' && link && salon.client_changes
      ? `To cancel or move it, use the link above${salon.change_cutoff_hours ? ` up to ${salon.change_cutoff_hours} hours before` : ''}.` : null,
    salon.phone ? `Need to change something? Contact ${salon.name}: ${salon.phone}` : `Need to change something? Contact ${salon.name}.`,
    '', `— ${salon.name}, booked through SalonBook. Please don't reply to this email; it isn't read.`,
  ].filter((l) => l !== null);
  return mailer().sendMail({
    from: `"${salon.name.replace(/"/g, '')}" <${SMTP.from}>`, to: a.client_email, subject: t.subject, text: lines.join('\n'),
  }).then(() => true, (e) => { console.error(`Client email (${kind}) failed:`, e.message); return false; });
}

module.exports = { notify, notifyClient, emailEnabled, sendMail };
