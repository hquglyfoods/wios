// ============================================================
// WIOS notify function
// GET  -> { publicKey }  (VAPID public key for client subscribe)
// POST -> { to: [userId,...], title, body, tag?, coopId? }
//         Sends web push to the target users.
//         Caller must be an authenticated WIOS user (Supabase JWT).
// ============================================================
const { pushToUsers, makeSb } = require('./lib-push.js');

const SUPA_URL = 'https://xttqxjuunuchlxjrknyt.supabase.co';
const ANON_KEY = 'sb_publishable_qL2xlkjIkIWGOkzaDitIJw_3iRNx9dA';

exports.handler = async (event) => {
  const env = process.env;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: env.VAPID_PUBLIC_KEY || '' }),
    };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  try {
    // Verify caller: valid Supabase session AND registered WIOS profile
    const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, headers: cors, body: 'Missing token' };

    const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` },
    });
    if (!userRes.ok) return { statusCode: 401, headers: cors, body: 'Invalid token' };
    const user = await userRes.json();

    const sb = makeSb(env);
    const prof = await sb(`wios_profiles?id=eq.${user.id}&select=id,name,role`);
    if (!prof.length) return { statusCode: 403, headers: cors, body: 'Not a WIOS user' };

    const payload = JSON.parse(event.body || '{}');
    const to = Array.isArray(payload.to) ? payload.to.filter((x) => x && x !== user.id) : [];
    if (!to.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: 0 }) };

    const title = String(payload.title || 'WIOS').slice(0, 120);
    const body = String(payload.body || '').slice(0, 300);
    const coopId = payload.coopId || null;
    const kind = payload.kind || (coopId ? 'coop' : 'task');
    // Per-item tag keeps separate arrivals separate in the phone's tray. A
    // shared tag makes each new push REPLACE the previous one, which is why
    // several arrivals used to collapse into a single visible notification.
    const tag = payload.tag || (coopId ? `coop-${coopId}` : `wios-${kind}`);

    // in-app notification feed: one row per recipient
    try {
      await sb('wios_notifications', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(to.map((uid) => ({
          user_id: uid, title, body, kind, coop_id: coopId,
        }))),
      });
    } catch (e) { console.error('notif insert', e.message); }

    const sent = await pushToUsers(to, {
      title, body,
      tag,
      url: coopId ? `/?coop=${coopId}` : '/',
      coopId,
    }, env);

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ sent }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: cors, body: 'Error: ' + e.message };
  }
};
