// PayPal Checkout (Orders v2 REST API), one PayPal app per salon.
//
// Flow:
//   1. createOrder(): we create an order for the USD deposit and send the client to PayPal's approval page.
//   2. PayPal sends the client back to our return URL with ?token=<order id>.
//   3. capture(): we capture the order. Only then is money taken, so a client who never comes back is never charged.
//
// PayPal does not support GYD, so the deposit is converted with the salon's own rate (GYD per 1 USD).
const { open } = require('./secrets');

const API = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
const base = (salon) => API[salon.paypal_mode === 'live' ? 'live' : 'sandbox'];

const configured = (s) => Boolean(s.paypal_enabled && s.paypal_client_id && s.paypal_secret && s.usd_rate > 0);

// GYD deposit -> USD string with 2 decimals, rounded up so the salon never receives less than the deposit.
const usdFor = (salon, gyd) => (Math.ceil((Number(gyd) / Number(salon.usd_rate)) * 100) / 100).toFixed(2);

async function call(salon, method, path, { token, body, requestId } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base(salon) + path, { method, headers, body: payload, signal: AbortSignal.timeout(20000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`PayPal ${r.status}: ${data.name || data.error || ''} ${data.message || data.error_description || ''}`.trim());
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}

// Exchanges the salon's client ID + secret for a short-lived access token. Also used to test credentials on save.
async function accessToken(salon, secretOverride) {
  const secret = secretOverride ?? open(salon.paypal_secret);
  const basic = Buffer.from(`${salon.paypal_client_id}:${secret}`).toString('base64');
  const r = await fetch(base(salon) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error('PayPal rejected these credentials. Check the client ID, secret and mode.');
  return data.access_token;
}

// Returns { id, approveUrl }.
async function createOrder(salon, { amountUsd, reference, description, returnUrl, cancelUrl, requestId }) {
  const token = await accessToken(salon);
  const order = await call(salon, 'POST', '/v2/checkout/orders', {
    token, requestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: reference, custom_id: reference, description: description.slice(0, 127), amount: { currency_code: 'USD', value: amountUsd } }],
      payment_source: { paypal: { experience_context: {
        brand_name: salon.name.slice(0, 127), user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
        return_url: returnUrl, cancel_url: cancelUrl,
      } } },
    },
  });
  const link = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!order.id || !link) throw new Error('PayPal did not return an approval link');
  return { id: order.id, approveUrl: link.href };
}

// Captures an approved order. Returns { status: 'completed' | 'pending' | 'failed', captureId, amount, currency }.
async function capture(salon, orderId, requestId) {
  const token = await accessToken(salon);
  let order;
  try {
    order = await call(salon, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { token, requestId, body: {} });
  } catch (e) {
    // Already captured (page refresh, double click): read the order instead.
    if (e.status === 422 && JSON.stringify(e.data || {}).includes('ORDER_ALREADY_CAPTURED')) {
      order = await call(salon, 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { token });
    } else throw e;
  }
  const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap) return { status: 'failed' };
  const status = cap.status === 'COMPLETED' ? 'completed' : cap.status === 'PENDING' ? 'pending' : 'failed';
  return { status, captureId: String(cap.id || ''), amount: cap.amount?.value, currency: cap.amount?.currency_code };
}

// PayPal.me link for the manual option. Names are 1-20 letters/digits.
const validMeName = (s) => /^[A-Za-z0-9]{1,20}$/.test(s);
const meLink = (salon, amountUsd) => `https://paypal.me/${encodeURIComponent(salon.paypal_me)}/${amountUsd}USD`;

module.exports = { configured, usdFor, accessToken, createOrder, capture, validMeName, meLink };
