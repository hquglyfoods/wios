// ============================================================
// WIOS Ask. Answers natural-language questions about the work
// recorded in WIOS, using Claude Sonnet.
//
// POST { question, history?: [{role, content}, ...] }
//   - Caller must be an active WIOS user.
//   - Admins can ask about the whole team. Everyone else only
//     ever sees their own records (enforced here on the server,
//     the model never receives other people's rows).
// ============================================================
const { makeSb } = require('./lib-push.js');

const SUPA_URL = 'https://xttqxjuunuchlxjrknyt.supabase.co';
const ANON_KEY = 'sb_publishable_qL2xlkjIkIWGOkzaDitIJw_3iRNx9dA';
const MODEL = 'claude-sonnet-5';

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmt(ts){ if(!ts) return null; const d=new Date(ts);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`; }

exports.handler = async (event) => {
  const env = process.env;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    if (!env.ANTHROPIC_API_KEY) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'The AI key is not set on the server yet.' }) };
    }

    // ── verify caller ──
    const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Sign in again.' }) };

    const uRes = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` },
    });
    if (!uRes.ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Sign in again.' }) };
    const user = await uRes.json();

    const sb = makeSb(env);
    const meRows = await sb(`wios_profiles?id=eq.${user.id}&select=id,name,role,is_admin,active`);
    if (!meRows.length || !meRows[0].active) {
      return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Not a WIOS user.' }) };
    }
    const me = meRows[0];
    const isAdmin = !!me.is_admin;

    const payload = JSON.parse(event.body || '{}');
    const question = String(payload.question || '').trim().slice(0, 2000);
    if (!question) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Ask a question.' }) };
    const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];

    // ── gather data within the caller's permission ──
    const people = await sb('wios_profiles?select=id,name,role,is_admin,active');
    const nameOf = (id) => { const p = people.find(x => x.id === id); return p ? `${p.role} ${p.name}` : 'someone'; };
    const scopeIds = isAdmin ? people.map(p => p.id) : [me.id];
    const idList = scopeIds.map(x => `"${x}"`).join(',');

    // Tasks (owned by anyone in scope)
    const tasks = await sb(`wios_tasks?owner_id=in.(${idList})&select=*&order=created_at.desc&limit=1000`);
    // Goals
    const goals = await sb(`wios_goals?owner_id=in.(${idList})&status=neq.deleted&select=*&order=period_key.desc&limit=1000`);
    // Recurrings
    const recs = await sb(`wios_recurrings?owner_id=in.(${idList})&select=*&limit=500`);
    // Coops: those the scope users created, hold, or are members of
    const coopsAll = await sb('wios_coops?select=*&order=created_at.desc&limit=1000');
    const memAll = await sb('wios_coop_members?select=*&limit=3000');
    const scopeSet = new Set(scopeIds);
    const visibleCoopIds = new Set();
    coopsAll.forEach(c => {
      if (scopeSet.has(c.creator_id) || scopeSet.has(c.holder_id)) visibleCoopIds.add(c.id);
    });
    memAll.forEach(m => { if (scopeSet.has(m.user_id)) visibleCoopIds.add(m.coop_id); });
    const coops = coopsAll.filter(c => visibleCoopIds.has(c.id));
    const coopIdList = coops.map(c => `"${c.id}"`).join(',');
    let msgs = [];
    if (coops.length) {
      msgs = await sb(`wios_coop_messages?coop_id=in.(${coopIdList})&select=*&order=created_at.asc&limit=3000`);
    }

    // ── shape it into compact, readable records for the model ──
    const taskLines = tasks.map(t => {
      const bits = [`[${t.status}]`, t.title];
      if (isAdmin) bits.push(`(owner: ${nameOf(t.owner_id)})`);
      if (t.urgent) bits.push('urgent');
      if (t.status === 'done' && t.completed_at) bits.push(`done ${fmt(t.completed_at)}`);
      if (t.status === 'waiting') bits.push(`waiting since ${fmt(t.waiting_since || t.created_at)}, comes back ${fmt(t.remind_at)}`);
      if (t.status === 'scheduled') bits.push(`set aside until ${fmt(t.scheduled_at)}`);
      bits.push(`created ${fmt(t.created_at)}`);
      return '- ' + bits.join(' ');
    });

    const goalLines = goals.map(g => {
      const bits = [`[${g.period_type} ${g.period_key}]`, g.title, `- ${g.status}`];
      if (isAdmin) bits.push(`(owner: ${nameOf(g.owner_id)})`);
      if (g.completed_at) bits.push(`completed ${fmt(g.completed_at)}`);
      if (g.kept_from) bits.push(`kept from ${g.kept_from}`);
      return '- ' + bits.join(' ');
    });

    const recLines = recs.map(r => {
      const when = r.freq === 'weekly' ? (r.days || []).map(d => DOW[d]).join('/')
        : r.freq === 'monthly' ? `day ${r.day_of_month}` : 'daily';
      const bits = [r.title, `(${when} at ${r.time_hhmm})`, `streak ${r.streak}, best ${r.best_streak}`];
      if (!r.active) bits.push('paused');
      if (isAdmin) bits.push(`(owner: ${nameOf(r.owner_id)})`);
      return '- ' + bits.join(' ');
    });

    const coopLines = coops.map(c => {
      const parts = [c.title, `- ${c.status}`, `started by ${nameOf(c.creator_id)} on ${fmt(c.created_at)}`];
      if (c.status === 'closed') parts.push(`closed ${fmt(c.closed_at)} by ${nameOf(c.closed_by)}`);
      else if (c.holder_id) parts.push(`currently with ${nameOf(c.holder_id)}`);
      else if (c.pending_id) parts.push(`invite pending for ${nameOf(c.pending_id)}`);
      const thread = msgs.filter(m => m.coop_id === c.id).map(m => {
        if (m.kind === 'pass') return `    passed ${nameOf(m.user_id)} to ${nameOf(m.pass_to)}${m.body ? `: ${m.body}` : ''} (${fmt(m.created_at)})`;
        if (m.kind === 'system') return `    ${m.body} (${fmt(m.created_at)})`;
        return `    ${nameOf(m.user_id)}: ${m.body} (${fmt(m.created_at)})`;
      });
      return '- ' + parts.join(' ') + (thread.length ? '\n' + thread.join('\n') : '');
    });

    const today = new Date();
    const scopeText = isAdmin
      ? 'You can see records for the whole leadership team.'
      : `You can only see ${me.name}'s own records.`;

    const dataBlock =
`TODAY: ${DOW[today.getUTCDay()]} ${MON[today.getUTCMonth()]} ${today.getUTCDate()} ${today.getUTCFullYear()}
ASKED BY: ${me.role} ${me.name}${isAdmin ? ' (admin)' : ''}

=== TASKS (${tasks.length}) ===
${taskLines.join('\n') || 'none'}

=== GOALS (${goals.length}) ===
${goalLines.join('\n') || 'none'}

=== DAILY REMINDERS (${recs.length}) ===
${recLines.join('\n') || 'none'}

=== COOP TASKS (${coops.length}) ===
${coopLines.join('\n') || 'none'}`;

    const system =
`You are the assistant inside WIOS, the leadership workspace for Ugly Donuts & Corn Dogs.
You answer questions about the work recorded in the app: tasks, goals, daily reminders, and coop (shared relay) tasks.
${scopeText}
Answer only from the records below. If the answer is not in the records, say so plainly rather than guessing.
Be concise and specific. When the user asks "when" something happened, cite the dates shown.
When useful, group by date or by person. Do not invent tasks, dates, or people.
Never use em dashes. Use commas, periods, or parentheses instead.

ROLE-FIT QUESTIONS: If the user asks whether their work fits their role (for example "am I doing what fits my role as COO"), do a grounded analysis of the actual tasks, goals, and coop work in the records:
- Look at what the tasks are really about, and sort them into (a) role-level work that only a person in that seat should own (strategy, building systems and standards, developing people, planning, cross-functional decisions) versus (b) lower-level or day-to-day work that a manager or staffer could own (individual store operations, one-off firefighting, routine fixes).
- Say honestly where their time is actually going based on the pattern you see. If most of the work is operational firefighting and there is little that grows the role or the person, name that directly and kindly.
- Use the reference below for what each seat should focus on. Judge against the role the user names, not against a generic idea of "busy".
- Point to a few concrete example tasks from the records to support what you say (do not invent any). End with 2 or 3 specific, doable shifts that would move them toward true role-level work. Keep it constructive and peer-to-peer, not harsh.
- Only give this analysis when they ask for it. For plain lookups, just answer the lookup.

ROLE REFERENCE (what each seat should mostly be doing):
- CEO: vision and direction, fundraising and investor and lender relationships, franchise growth and major partnerships, hiring and aligning the leadership team.
- CBO (Brand and Creative): brand, menu development, store design and experience, creative direction and standards.
- CMO (Marketing): demand and traffic, campaigns, content and channels, customer growth and loyalty.
- COO (Operations): building repeatable operating systems and standards across stores, training and developing store leaders, unit economics and process, scaling operations. NOT acting as a general manager who only puts out fires at individual stores. If the COO's record is mostly single-store operational problems with little system-building or people-development, that is a sign they are stuck in GM work instead of the COO role.
- CPO (Product or People, use whichever the records suggest): if product, the supply chain, ingredients, and product quality and consistency; if people, hiring systems, HR, culture, and team development.

RECORDS:
${dataBlock}`;

    const messages = [
      ...history.filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)
        .map(h => ({ role: h.role, content: String(h.content).slice(0, 4000) })),
      { role: 'user', content: question },
    ];

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error('anthropic error', aiRes.status, t);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'The AI did not respond. Try again in a moment.' }) };
    }
    const ai = await aiRes.json();
    const answer = (ai.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      || 'I could not find anything to say about that.';

    return { statusCode: 200, headers: cors, body: JSON.stringify({ answer }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
