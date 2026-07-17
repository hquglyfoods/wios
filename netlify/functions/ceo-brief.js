// ============================================================
// WIOS CEO assistant brief. Admin-only. Every Monday it produces a
// single report for the CEO summarizing each C-level leader's past
// week: what they did, what their coach told them, what they did well,
// what was missing, and whether they acted on prior coaching. The CEO
// can then chat about it. History is kept forever; the app shows the
// last 4 weeks of the chat window.
//
// POST { action: 'ensure' }  -> generate this week's report if missing, return thread
// POST { action: 'chat', message } -> chat with the assistant about the team
// ============================================================
const { makeSb } = require('./lib-push.js');
const { ROLES_DOC } = require('./roles-doc.js');

const SUPA_URL = 'https://xttqxjuunuchlxjrknyt.supabase.co';
const ANON_KEY = 'sb_publishable_qL2xlkjIkIWGOkzaDitIJw_3iRNx9dA';
const MODEL = 'claude-sonnet-5';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmt(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}
function mondayKey(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const back = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - back);
  return x.toISOString().slice(0, 10);
}
function isoDay(d) { return d.toISOString().slice(0, 10); }

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
    const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Sign in again.' }) };
    const uRes = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` } });
    if (!uRes.ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Sign in again.' }) };
    const user = await uRes.json();

    const sb = makeSb(env);
    const meRows = await sb(`wios_profiles?id=eq.${user.id}&select=id,name,role,is_admin,active`);
    if (!meRows.length || !meRows[0].active) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Not a WIOS user.' }) };
    const me = meRows[0];
    if (!me.is_admin) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'This assistant is for the CEO only.' }) };

    const payload = JSON.parse(event.body || '{}');
    const action = String(payload.action || 'ensure');
    const windowStart = new Date(Date.now() - 28 * 864e5).toISOString();

    const sys =
`You are the CEO's executive assistant inside WIOS, the leadership workspace for Ugly Donuts & Corn Dogs.
You report to ${me.name}, the CEO. Your job is to keep the CEO fully informed about how each C-level leader is doing, in plain, candid language. You are loyal to the CEO and tell the truth, including things a leader might not want the CEO to hear.
For each leader, judge their week against the definition of THEIR seat in the role reference. For the COO especially, separate real COO work (building operating systems and standards, training and certifying operators, franchisee build-out, quality audits, developing store leaders) from general-manager firefighting on single stores.
You are given each leader's records (tasks, goals) for last week AND their private coaching notes and coaching chat. Use the coaching material to tell the CEO what the coach advised and, importantly, whether the leader appears to be acting on it or ignoring it. Cite specific real examples. Never invent tasks, dates, numbers, or quotes.
Never use em dashes. Use commas, periods, or parentheses instead. Keep it readable on a phone.

FORMAT (the CEO wants to grasp it at a glance, not read a wall of text):
- For each leader, use a header line "## ROLE Name" (for example "## COO Jiwoon").
- Under each, use short "- " bullets grouped by these labels on their own lines: "Did well:", "Missing:", "Coaching:" (what the coach advised and whether they are acting on it).
- End the whole brief with a "## Watch this week" section of short "- " bullets across the team.
Keep bullets to one or two sentences. Be candid and specific.

ROLE REFERENCE:
${ROLES_DOC}`;

    async function loadVisible() {
      return await sb(`wios_ceo_brief_messages?owner_id=eq.${me.id}&created_at=gte.${encodeURIComponent(windowStart)}&select=*&order=created_at.asc&limit=400`);
    }
    async function loadContext() {
      return await sb(`wios_ceo_brief_messages?owner_id=eq.${me.id}&select=*&order=created_at.desc&limit=40`);
    }

    // Build the per-leader data block for last week.
    async function teamBlock() {
      const people = await sb('wios_profiles?select=id,name,role,is_admin,active&order=role.asc');
      const active = people.filter((p) => p.active);
      const now = new Date();
      const thisWeek = mondayKey(now);
      const lastMon = new Date(thisWeek + 'T00:00:00Z');
      const prevMon = new Date(lastMon.getTime() - 7 * 864e5);
      const sinceIso = prevMon.toISOString();

      const sections = [];
      for (const p of active) {
        const idq = `"${p.id}"`;
        const tasks = await sb(`wios_tasks?owner_id=in.(${idq})&select=*&order=created_at.desc&limit=500`);
        const goals = await sb(`wios_goals?owner_id=in.(${idq})&status=neq.deleted&select=*&order=period_key.desc&limit=200`);
        const doneLastWeek = tasks.filter((t) => t.status === 'done' && t.completed_at && t.completed_at >= sinceIso);
        const activeTasks = tasks.filter((t) => t.status === 'active');

        // coaching material for this person (recent)
        const coach = await sb(`wios_coaching_messages?user_id=eq.${p.id}&select=role,content,is_weekly,created_at&order=created_at.desc&limit=20`);
        const coachChrono = coach.reverse();
        const latestWeekly = [...coach].reverse().find((m) => m.is_weekly);

        const doneLines = doneLastWeek.map((t) => `  - ${t.title}${t.urgent ? ' (urgent)' : ''} done ${fmt(t.completed_at)}`).join('\n') || '  none recorded';
        const activeLines = activeTasks.slice(0, 15).map((t) => `  - ${t.title}${t.urgent ? ' (urgent)' : ''}`).join('\n') || '  none';
        const goalLines = goals.slice(0, 12).map((g) => `  - [${g.period_type} ${g.period_key}] ${g.title} (${g.status})`).join('\n') || '  none';
        const coachLine = latestWeekly ? String(latestWeekly.content).slice(0, 900) : 'no coaching note yet';
        const chatLines = coachChrono.filter((m) => !m.is_weekly).slice(-8)
          .map((m) => `    ${m.role === 'coach' ? 'Coach' : p.role}: ${String(m.content).slice(0, 300)}`).join('\n') || '    (no coaching chat)';

        sections.push(
`### ${p.role} ${p.name}
Tasks completed last week:
${doneLines}
Currently active tasks:
${activeLines}
Goals:
${goalLines}
Latest coaching note to them:
  ${coachLine}
Recent coaching conversation (to see if they are engaging with the advice):
${chatLines}`);
      }

      const header = `TODAY: ${fmt(now.toISOString())}\nLAST WEEK: ${isoDay(prevMon)} to ${isoDay(lastMon)}\n`;
      return { block: header + '\n' + sections.join('\n\n'), thisWeek };
    }

    // ---------------------------------------------------------
    if (action === 'ensure') {
      const now = new Date();
      const thisWeek = mondayKey(now);
      const existing = await sb(`wios_ceo_brief_messages?owner_id=eq.${me.id}&week_key=eq.${thisWeek}&is_weekly=eq.true&select=id&limit=1`);
      if (!existing.length) {
        const { block } = await teamBlock();
        const prompt =
`Write the CEO's Monday brief for last week using the exact section format from your instructions: a "## ROLE Name" header per leader (CEO, CBO, CMO, COO, CPO as present), then "- " bullets under "Did well:", "Missing:", and "Coaching:" (what the coach advised and whether they are acting on it, call out if they are ignoring it). Finish with a "## Watch this week" section of short bullets across the team.
Be candid and specific with real examples. Do not invent anything. Talk straight to the CEO.

${block}`;
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: MODEL, max_tokens: 2500, system: sys, messages: [{ role: 'user', content: prompt }] }),
        });
        if (aiRes.ok) {
          const ai = await aiRes.json();
          const text = (ai.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          if (text) {
            await sb('wios_ceo_brief_messages', {
              method: 'POST',
              body: JSON.stringify({ owner_id: me.id, role: 'assistant', content: text, week_key: thisWeek, is_weekly: true }),
            });
          }
        } else {
          console.error('ceo brief gen failed', aiRes.status, await aiRes.text());
        }
      }
      const thread = await loadVisible();
      return { statusCode: 200, headers: cors, body: JSON.stringify({ thread, week_key: thisWeek }) };
    }

    // ---------------------------------------------------------
    if (action === 'chat') {
      const message = String(payload.message || '').trim().slice(0, 2000);
      if (!message) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Say something.' }) };
      const now = new Date();
      const thisWeek = mondayKey(now);
      await sb('wios_ceo_brief_messages', {
        method: 'POST',
        body: JSON.stringify({ owner_id: me.id, role: 'user', content: message, week_key: thisWeek, is_weekly: false }),
      });

      // fresh team data so the CEO can ask follow-ups grounded in current records
      const { block } = await teamBlock();
      const ctx = (await loadContext()).reverse();
      const recentTurns = ctx.slice(-16).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
      const messages = recentTurns.length && recentTurns[recentTurns.length - 1].role === 'user' ? recentTurns : [...recentTurns, { role: 'user', content: message }];

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1800, system: sys + `\n\nCURRENT TEAM DATA:\n${block}`, messages }),
      });
      if (!aiRes.ok) {
        console.error('ceo brief chat failed', aiRes.status, await aiRes.text());
        return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'The assistant did not respond. Try again in a moment.' }) };
      }
      const ai = await aiRes.json();
      const answer = (ai.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
        || 'Let me look into that for you.';
      await sb('wios_ceo_brief_messages', {
        method: 'POST',
        body: JSON.stringify({ owner_id: me.id, role: 'assistant', content: answer, week_key: thisWeek, is_weekly: false }),
      });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ answer }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
