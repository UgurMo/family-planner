// Mamak Family App - Cloudflare Worker
// Push notificaties versturen via Web Push API

const VAPID_PUBLIC  = "BKJQcII6_W4BhUXtVEhWSB4nNsAz0U-JfGSSqk72ckNnV4FYr-5lsbtiViqLt6Oxp3kahTEBvCLaE1v1yTtUMew";
const VAPID_PRIVATE = "6F1wmGFdAjd_Cz--tkrJVehCOzCHuThNKsFAkyBk19M";
const VAPID_SUBJECT = "mailto:umtt@hotmail.com";
const JB_KEY        = "$2a$10$1O6R6Xoo0cqOKGbFvulKPeanxMqbdfbiS079uC2eUnRxbXBbrErcm";
const JB_SUBS_BIN   = "69cff19c856a682189f858a3";

// Helper: base64url encode
function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Helper: base64url decode
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// Maak VAPID JWT token
async function makeVapidToken(audience) {
  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: audience, exp: now + 12 * 3600, sub: VAPID_SUBJECT
  })));

  const keyData = base64urlDecode(VAPID_PRIVATE);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    // Wrap in PKCS8 structure for P-256
    (() => {
      const header = new Uint8Array([0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20]);
      const result = new Uint8Array(header.length + keyData.length);
      result.set(header); result.set(keyData, header.length);
      return result.buffer;
    })(),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );

  return `${header}.${payload}.${base64urlEncode(sig)}`;
}

// Stuur push naar één subscription
async function sendPush(subscription, payload) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const token = await makeVapidToken(audience);

  const body = new TextEncoder().encode(JSON.stringify(payload));

  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${token},k=${VAPID_PUBLIC}`,
      'Content-Type': 'application/json',
      'TTL': '86400'
    },
    body
  });
}

// Haal subscriptions op uit JSONBin
async function getSubscriptions() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${JB_SUBS_BIN}/latest`, {
    headers: { 'X-Master-Key': JB_KEY, 'X-Bin-Meta': 'false' }
  });
  const json = await res.json();
  return json.data || [];
}

// Sla subscription op in JSONBin
async function saveSubscription(sub, username) {
  const subs = await getSubscriptions();
  const existing = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (existing >= 0) { subs[existing] = { ...sub, username }; }
  else { subs.push({ ...sub, username }); }

  await fetch(`https://api.jsonbin.io/v3/b/${JB_SUBS_BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JB_KEY },
    body: JSON.stringify({ data: subs })
  });
}

// Stuur naar alle subscriptions behalve de verzender
async function broadcast(payload, excludeUsername) {
  const subs = await getSubscriptions();
  const targets = excludeUsername ? subs.filter(s => s.username !== excludeUsername) : subs;
  await Promise.allSettled(targets.map(sub => sendPush(sub, payload)));
}

export default {
  async fetch(request, env) {
    // CORS headers
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    // POST /subscribe — sla subscription op
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const { subscription, username } = await request.json();
      await saveSubscription(subscription, username);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // POST /notify — stuur notificatie
    if (request.method === 'POST' && url.pathname === '/notify') {
      const { title, body, sender } = await request.json();
      await broadcast({ title, body }, sender);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('Mamak Push Worker actief', { headers: cors });
  }
};
