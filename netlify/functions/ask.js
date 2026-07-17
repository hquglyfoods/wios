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
const { ROLES_DOC } = require('./roles-doc.js');

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
The company is Ugly Donuts & Corn Dogs, building to become the number one donut brand and the number one Korean food brand in the United States, now franchising. It also runs a smaller premium syrup brand, Umma's Recipe: if tasks or data mention syrup sales or production or Umma's Recipe, understand that context.
${scopeText}
Answer only from the records below. If the answer is not in the records, say so plainly rather than guessing.
Be concise and specific. When the user asks "when" something happened, cite the dates shown.
When useful, group by date or by person. Do not invent tasks, dates, or people.
Format for easy reading, not a wall of text: be direct and concise, lead with a one line answer, then short "- " bullets for the details. Bold the few pivotal words with **double asterisks**. For a multi part answer, use short "## Label" section headers with bullets under each. Keep bullets to one or two short sentences. If they ask for more detail, then expand.
Never use em dashes. Use commas, periods, or parentheses instead.

ROLE-FIT AND GROWTH QUESTIONS: If the user asks whether their work fits their role, how to grow into it, what they are missing, or how to become excellent in their seat (for example "am I doing what fits my role as COO", "how do I grow as COO", "what am I missing"), give a grounded coaching answer:
- Anchor on the ROLE REFERENCE below, which is this company's own definition of each seat: its responsibilities, direction, what to master, the level to reach, and the standards to hit. Judge the person against their OWN seat's definition, not a generic idea of being busy.
- Look at the person's actual tasks, goals, and coop work in the records. Sort what they are really spending time on into (a) true role-level work that grows the seat (building systems, standards, playbooks, training and developing people, strategy, planning) versus (b) lower-level day-to-day or firefighting work that a manager or staffer could own. Cite a few real example tasks from the records (never invent any).
- Say honestly where their time is actually going. If most of it is low-level firefighting with little that builds the system or grows them, name it directly and kindly. This applies to every seat: separate real seat-level work (building systems and standards, developing people, planning) from firefighting a manager could own. For example, a COO doing mostly single-store fixes instead of building the training, certification, and audit systems is stuck in general-manager work, and the same logic applies to each role against what its seat should own.
- Then coach forward, using the reference but not limited to it: what excellent looks like for this seat, the specific gaps between where they are now and that level, what they should master next, and 2 to 4 concrete, doable shifts or next steps that would move them toward true role-level work and toward the standards their seat is supposed to hit. Be specific to what the records show, not generic advice.
- You may reason beyond the document to give genuinely useful growth guidance, as long as it is consistent with the company's franchising-only, build-the-system-so-it-runs-without-you direction. Keep the tone constructive and peer-to-peer, a trusted advisor, not harsh and not flattering.
- Only give this fuller analysis when they ask about role fit or growth. For plain lookups ("what did I do last week"), just answer the lookup.

OWNERSHIP AND ROUTING QUESTIONS: If the user describes a task or need and asks who should own it or who to ask (for example "I need an employment verification letter for a former employee, who should do this", "who owns this", "should I ask John for this"), route it using the ROLE REFERENCE below:
- Name the seat that actually owns the work, and the person in it. Use the responsibilities in the reference to decide. For example: store operations, training and certification, franchisee onboarding and build-out, quality assurance and store audits, HR, labor, payroll, and employee benefits belong to the COO; supply chain, ingredients, vendors, and equipment belong to the CPO; menu, recipes, and store design belong to the CBCO; marketing, campaigns, grand openings, marketing results and analytics, customer engagement and loyalty, and franchise lead generation belong to the CMO; capital, franchise deals, real estate, and investor relations belong to the CEO.
- IMPORTANT: if the thing they are asking to hand off is actually part of THEIR OWN seat, tell them so plainly and kindly. Many day-to-day items that feel like a favor to ask the CEO for (an employment verification letter, a payroll question, a store staffing issue, an HR document) are the COO's own responsibility, not the CEO's. In that case explain that this sits in their role, that they can and should handle or sign it themselves (as the employer or operator), and only escalate to the CEO if it needs a company-level decision or the CEO's specific authority. Do not send someone to the CEO for routine work their own seat owns.
- Be specific and practical: say who owns it, why (which responsibility it falls under), and what the cleanest way to get it done is. Keep it brief and helpful, not preachy.

ROLE REFERENCE (the company's own definition of each seat, use as the anchor):
${ROLES_DOC}

RECORDS:
${dataBlock}`;

    // Ask bot memory: load the person's stored history from the database so the bot
    // remembers past conversations and their style, even though the screen starts fresh.
    // Recent turns are included verbatim; older ones are summarized into a compact digest.
    const allAsk = await sb(`wios_ask_messages?user_id=eq.${me.id}&select=role,content,created_at&order=created_at.desc&limit=200`);
    const askChrono = allAsk.slice().reverse();                 // oldest first
    const recentTurns = askChrono.slice(-24);                   // last 24 verbatim
    const olderTurns = askChrono.slice(0, Math.max(0, askChrono.length - 24));
    let memoryNote = '';
    if (olderTurns.length) {
      const digest = olderTurns.slice(-60).map(m => `${m.role === 'assistant' ? 'You' : 'Them'}: ${String(m.content).slice(0, 220)}`).join('\n');
      memoryNote = `\n\nEARLIER CONVERSATION MEMORY (older exchanges with this person, for context and to remember their style, oldest first):\n${digest}`;
    }

    const messages = [
      ...recentTurns.filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)
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
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: system + memoryNote, messages }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error('anthropic error', aiRes.status, t);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'The AI did not respond. Try again in a moment.' }) };
    }
    const ai = await aiRes.json();
    const answer = (ai.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      || 'I could not find anything to say about that.';

    // persist this exchange forever so the bot keeps context next time
    try {
      await sb('wios_ask_messages', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify([
          { user_id: me.id, role: 'user', content: question },
          { user_id: me.id, role: 'assistant', content: answer },
        ]),
      });
    } catch (e) { console.error('ask store failed', e); }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ answer }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
