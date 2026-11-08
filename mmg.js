// MMG (Mobile Money Guyana) Merchant Checkout.
//
// Flow (per MMG's developer docs, https://mmg.gy/developer/):
//   1. We JSON-encode the payment request, encrypt it with MMG's RSA public key and Base64-URL encode it.
//   2. The client is sent to  <checkout base>?token=…&merchantId=…&X-Client-ID=…  and pays inside MMG.
//   3. MMG sends the client back to our Response URL with ?token=…, encrypted with *our* public key.
//      We decrypt it with our private key; ResultCode "0" means the payment succeeded.
//
// Each salon has its own MMG merchant account, so credentials live on the salon row.
const crypto = require('crypto');

const CHECKOUT_URLS = {
  sandbox: 'https://mmgpg.mmgtest.net/mmg-pg/web/payments',
  live: 'https://mmgpg.mymmg.gy/mmg-pg/web/payments',
};
// MMG's docs say "RSA" without naming the padding. The community WooCommerce plugin uses OAEP with SHA-256,
// which is the default here. If MMG's sandbox answers "Token Decryption Failed" (code 5), try MMG_OAEP_HASH=sha1.
const OAEP_HASH = process.env.MMG_OAEP_HASH || 'sha256';

const RESULT = {
  0: 'Transaction successful', 1: 'Agent not registered', 2: 'Payment failed', 3: 'Invalid secret key',
  4: 'Merchant ID mismatch', 5: 'Token decryption failed', 6: 'Transaction cancelled', 7: 'Request timed out',
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const unb64url = (s) => {
  const t = String(s).trim().replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
};

// Returns an error message if the PEM can't be used, otherwise ''.
function checkKey(pem, kind) {
  if (!pem) return '';
  try {
    if (kind === 'public') crypto.createPublicKey(pem); else crypto.createPrivateKey(pem);
    return '';
  } catch { return kind === 'public' ? 'MMG public key is not a valid PEM key.' : 'Your private key is not a valid PEM key.'; }
}

const configured = (s) => Boolean(s.mmg_api_enabled && s.mmg_merchant_id && s.mmg_client_id && s.mmg_secret_key && s.mmg_public_key && s.mmg_private_key);

// Build the URL that sends the client to MMG's hosted checkout page.
function checkoutUrl(salon, { merchantTransactionId, amount, description }) {
  const payload = {
    secretKey: salon.mmg_secret_key,
    amount: String(Math.round(amount)),
    merchantId: salon.mmg_merchant_id,
    merchantTransactionId,
    productDescription: description,
    requestInitiationTime: String(Math.floor(Date.now() / 1000)),
    merchantName: (salon.mmg_name || salon.name).slice(0, 30),
  };
  // MMG expects ISO-8859-1 text; replace anything outside it so the byte count stays predictable.
  const json = JSON.stringify(payload).replace(/[^\x00-\xff]/g, '?');
  const key = crypto.createPublicKey(salon.mmg_public_key);
  const max = key.asymmetricKeyDetails.modulusLength / 8 - 2 * (OAEP_HASH === 'sha1' ? 20 : 32) - 2;
  const data = Buffer.from(json, 'latin1');
  if (data.length > max) throw new Error(`The MMG request is ${data.length} bytes but this MMG public key can only encrypt ${max}. Check you pasted MMG's key (usually 4096-bit), or shorten the secret key / account name.`);
  const token = b64url(crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: OAEP_HASH }, data));
  const u = new URL(CHECKOUT_URLS[salon.mmg_mode === 'live' ? 'live' : 'sandbox']);
  u.searchParams.set('token', token);
  u.searchParams.set('merchantId', salon.mmg_merchant_id);
  u.searchParams.set('X-Client-ID', salon.mmg_client_id);
  return u.toString();
}

// Decrypt the token MMG sends back. Returns a normalised result object, or throws.
function decodeResponse(salon, token) {
  const plain = crypto.privateDecrypt(
    { key: salon.mmg_private_key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: OAEP_HASH },
    unb64url(token),
  ).toString('latin1');
  const r = JSON.parse(plain);
  const code = String(r.ResultCode ?? r.resultCode ?? '').trim();
  return {
    ok: code === '0',
    code,
    message: String(r.ResultMessage ?? r.resultMessage ?? RESULT[code] ?? 'Unknown result'),
    merchantTransactionId: String(r.merchantTransactionId ?? ''),
    transactionId: String(r.transactionId ?? ''),
  };
}

module.exports = { configured, checkoutUrl, decodeResponse, checkKey, RESULT, CHECKOUT_URLS };
