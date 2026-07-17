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
const { COACH_KB } = require('./coach-kb.js');
const { privateCoachingNote, privateReadNote } = require('./coach-private.js');

const SUPA_URL = 'https://xttqxjuunuchlxjrknyt.supabase.co';
const ANON_KEY = 'sb_publishable_qL2xlkjIkIWGOkzaDitIJw_3iRNx9dA';
const MODEL = 'claude-opus-4-8';        // deep weekly brief generation (runs in the background)
const CHAT_MODEL = 'claude-sonnet-5';   // fast, for interactive chat replies while the CEO waits

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
    const sb = makeSb(env);
    const payload = JSON.parse(event.body || '{}');

    let me;
    const svcKey = event.headers['x-wios-service'] || event.headers['X-Wios-Service'];
    if (svcKey && env.SUPABASE_SERVICE_KEY && svcKey === env.SUPABASE_SERVICE_KEY && payload.for_user) {
      const rows = await sb(`wios_profiles?id=eq.${payload.for_user}&select=id,name,role,is_admin,active`);
      if (!rows.length || !rows[0].active) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'No such user.' }) };
      me = rows[0];
      if (!me.is_admin) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'This assistant is for the CEO only.' }) };
    } else {
      const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Sign in again.' }) };
      const uRes = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` } });
      if (!uRes.ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Sign in again.' }) };
      const user = await uRes.json();
      const meRows = await sb(`wios_profiles?id=eq.${user.id}&select=id,name,role,is_admin,active`);
      if (!meRows.length || !meRows[0].active) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Not a WIOS user.' }) };
      me = meRows[0];
      if (!me.is_admin) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'This assistant is for the CEO only.' }) };
    }

    const action = String(payload.action || 'ensure');
    const windowStart = new Date(Date.now() - 28 * 864e5).toISOString();

    const sys =
`You are the CEO's executive assistant inside WIOS, the leadership workspace for Ugly Donuts & Corn Dogs.
You report to ${me.name}, the CEO. Your job is to keep the CEO fully informed about how each C-level leader is doing, in plain, candid language. You are loyal to the CEO and tell the truth, including things a leader might not want the CEO to hear.
The mission: become the number one donut brand and the number one Korean food brand in the United States. The company is now franchising, and each C-level leader must grow (not coast in their comfort zone) for the company to get there. The company also runs a smaller premium syrup brand, Umma's Recipe: if data mentions syrup or Umma's Recipe, understand that context. Judge leaders against that mission and their seat.
For each leader, judge their week against the definition of THEIR seat in the role reference, and against whether the systems that seat owns are being built to work at scale. Apply this equally to every role: CEO (pipeline, capital, real estate), CBO (codified recipes, specs, store design, brand standards), COO (training, certification, audit and QA, store-leader development), CMO (grand-opening playbook, franchise lead generation, marketing fund, repeat rate), CPO (supply chain at scale, ordering platform, opening packages, sourcing). For any seat, separate real seat-level work (building systems and standards, developing people, planning) from low-level firefighting that a manager could own.
You are given each leader's records (tasks, goals) for last week AND their private coaching notes and their full coaching conversation. This is your edge: read the coaching chats closely and tell the CEO what they reveal about each leader. From how a person talks to their coach, you can read a lot, and the CEO wants your honest read:
- Seriousness and commitment: are they genuinely engaged and hungry, do they reply thoughtfully and act on advice, or are they dismissive, defensive, giving short low-effort replies, or ignoring the coach entirely.
- Quality of thinking: how they reason about problems, whether they think strategically and like an owner or stay surface-level and tactical, how self-aware they are, how they handle hard feedback.
- Work performance and drive: what the chat plus their records suggest about their actual output, follow-through, and momentum.
Be candid and specific, and always tie each read to observed evidence from the chat or records (quote or paraphrase the specific exchange). These are inferences from limited text, so frame them as your read of the signals, not absolute fact, and flag when there is too little chat to judge. Do not invent messages, tasks, numbers, or quotes. The goal is to give the CEO a truthful, useful picture of where each leader really is, including things a leader might not say to the CEO directly.
Never use em dashes. Use commas, periods, or parentheses instead. Keep it readable on a phone.
CONFIDENTIAL: Some leaders have private background notes (in square brackets in their data) to help you judge them fairly and charitably. Never repeat, name, quote, diagnose, or hint at any of that background in your brief or in chat. Use it only to interpret their behavior accurately (for example, do not read a focus or memory challenge as a lack of seriousness). Report on observed work and engagement, not on any private label.

FORMAT (the CEO wants to grasp it at a glance, not read a wall of text):
- Be direct and concise. Short sentences, lead with the point, cut filler. Say the hard thing plainly.
- Bold the few pivotal words with **double asterisks** (a key miss, a number, a verdict). Do not bold whole sentences.
- For each leader, use a header line "## ROLE Name" (for example "## COO Jiwoon").
- Under each, use short "- " bullets grouped by these labels on their own lines: "Did well:", "Missing:", "Coaching:" (what the coach advised and whether they are acting on it), and "Read:" (your honest read of their seriousness, thinking, and drive from the coaching chat and records, tied to specific evidence).
- USE VISUALS to make the team state obvious. The app renders three tools:
  1. Comparison table (markdown) to line up all leaders on the same metrics:
     | Leader | Tasks done | Goals hit | Trend |
     | --- | --- | --- | --- |
     | COO | 8 | 1 | up |
  2. Progress bar on its own line: [[bar label=COO goal completion value=40 color=warn]] (colors: me, team, good, warn).
  3. Trend line on its own line, oldest first: [[trend label=Team tasks done values=12,15,14,20]]
  A team overview should usually include a comparison table. Use bars for completion rates and trends for week-over-week. Keep every number real, never invented.
- End the whole brief with a "## Watch this week" section of short "- " bullets across the team.
Keep bullets to one or two short sentences. If the CEO asks for more depth, then expand.

${COACH_KB}

ROLE REFERENCE:
${ROLES_DOC}`;

    async function loadVisible() {
      return await sb(`wios_ceo_brief_messages?owner_id=eq.${me.id}&created_at=gte.${encodeURIComponent(windowStart)}&select=*&order=created_at.asc&limit=400`);
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

        // coaching material for this person: the latest weekly note plus a deeper slice of the
        // actual coaching conversation, so the assistant can read how they engage, think, and
        // respond to hard feedback (not just whether a note exists).
        const coach = await sb(`wios_coaching_messages?user_id=eq.${p.id}&select=role,content,is_weekly,created_at&order=created_at.desc&limit=60`);
        const coachChrono = coach.reverse();
        const latestWeekly = [...coach].reverse().find((m) => m.is_weekly);

        const doneLines = doneLastWeek.map((t) => `  - ${t.title}${t.urgent ? ' (urgent)' : ''} done ${fmt(t.completed_at)}`).join('\n') || '  none recorded';
        const activeLines = activeTasks.slice(0, 15).map((t) => `  - ${t.title}${t.urgent ? ' (urgent)' : ''}`).join('\n') || '  none';
        const goalLines = goals.slice(0, 12).map((g) => `  - [${g.period_type} ${g.period_key}] ${g.title} (${g.status})`).join('\n') || '  none';
        const coachLine = latestWeekly ? String(latestWeekly.content).slice(0, 900) : 'no coaching note yet';
        const chatOnly = coachChrono.filter((m) => !m.is_weekly);
        const chatLines = chatOnly.slice(-24)
          .map((m) => `    ${m.role === 'coach' ? 'Coach' : p.role}: ${String(m.content).slice(0, 600)}`).join('\n') || '    (no coaching chat yet)';
        const engagementNote = chatOnly.length
          ? `  (${chatOnly.filter((m) => m.role !== 'coach').length} messages from ${(p.name || '').split(' ')[0]} in coaching chat)`
          : `  (${(p.name || '').split(' ')[0]} has not replied to the coach in chat)`;

        const priv = privateReadNote(p.role);
        sections.push(
`### ${p.role} ${p.name}${priv ? `\n[${priv}]` : ''}
Tasks completed last week:
${doneLines}
Currently active tasks:
${activeLines}
Goals:
${goalLines}
Latest coaching note to them:
  ${coachLine}
Their coaching conversation (read this closely to judge how they engage, think, and respond to hard feedback):
${engagementNote}
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
      let createdWeekly = false;
      if (!existing.length) {
        const { block } = await teamBlock();
        const prompt =
`Write the CEO's Monday brief for last week using the exact section format from your instructions: a "## ROLE Name" header per leader (CEO, CBO, CMO, COO, CPO as present), then "- " bullets under "Did well:", "Missing:", "Coaching:" (what the coach advised and whether they are acting on it, call out if they are ignoring it), and "Read:" (your honest read of their seriousness, quality of thinking, and drive based on their coaching conversation and records, tied to specific observed evidence, framed as your read of the signals). Finish with a "## Watch this week" section of short bullets across the team.
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
            createdWeekly = true;
          }
        } else {
          console.error('ceo brief gen failed', aiRes.status, await aiRes.text());
        }
      }
      const thread = await loadVisible();
      return { statusCode: 200, headers: cors, body: JSON.stringify({ thread, week_key: thisWeek, created: createdWeekly }) };
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
      // full history so the assistant remembers past conversations and the CEO's style:
      // recent turns verbatim, everything older folded into a compact digest
      const full = (await sb(`wios_ceo_brief_messages?owner_id=eq.${me.id}&select=role,content,is_weekly,created_at&order=created_at.desc&limit=200`)).reverse();
      const nonWeekly = full.filter((m) => !m.is_weekly);
      const recent = nonWeekly.slice(-16);
      const older = nonWeekly.slice(0, Math.max(0, nonWeekly.length - 16));
      let memoryNote = '';
      if (older.length) {
        const digest = older.slice(-60).map((m) => `${m.role === 'assistant' ? 'You' : 'CEO'}: ${String(m.content).slice(0, 220)}`).join('\n');
        memoryNote = `\n\nEARLIER CONVERSATION MEMORY (older chats with the CEO, for context and style, oldest first):\n${digest}`;
      }
      const recentTurns = recent.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
      const messages = recentTurns.length && recentTurns[recentTurns.length - 1].role === 'user' ? recentTurns : [...recentTurns, { role: 'user', content: message }];

      // roster so the assistant can map a role or name to a person for directives
      const roster = (await sb('wios_profiles?active=eq.true&select=id,name,role&order=role.asc'))
        .map((p) => `${p.role} ${p.name} (id ${p.id})`).join(', ');

      const directiveProtocol =
`\n\nDIRECTIVE PROTOCOL: The CEO may give you standing guidance for how the coaching bots should coach the leaders (for example "push the COO harder on motivation" or "get everyone studying the bigger picture"). When the CEO's message contains such guidance, do two things:
1. Reply normally and briefly confirm you will pass it to the coaching, in your own words.
2. On the VERY LAST line of your reply, append a machine tag exactly in this format, nothing after it:
[[DIRECTIVE target=<user id, or ALL> text=<the directive rewritten as a clear instruction to a coach>]]
Use ALL for the whole team, or the specific user id from the roster for one person. Only append the tag when there is a real directive. Never append it for ordinary questions. The tag will be removed before the CEO sees your reply, so do not reference it.
ROSTER: ${roster}`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 1200, system: sys + memoryNote + directiveProtocol + `\n\nCURRENT TEAM DATA:\n${block}`, messages }),
      });
      if (!aiRes.ok) {
        console.error('ceo brief chat failed', aiRes.status, await aiRes.text());
        return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'The assistant did not respond. Try again in a moment.' }) };
      }
      const ai = await aiRes.json();
      let answer = (ai.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
        || 'Let me look into that for you.';

      // capture any directive tag, store it, and strip it from what the CEO sees
      const dm = answer.match(/\[\[DIRECTIVE\s+target=(\S+)\s+text=([\s\S]*?)\]\]/i);
      if (dm) {
        const rawTarget = dm[1].trim();
        const text = dm[2].trim().slice(0, 1000);
        let target = /^all$/i.test(rawTarget) ? null : rawTarget;
        // only accept a target that is a real active profile id; otherwise treat as ALL
        if (target) {
          const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
          if (!uuidLike) { target = null; }
          else {
            const exists = await sb(`wios_profiles?id=eq.${target}&active=eq.true&select=id&limit=1`);
            if (!exists.length) target = null;
          }
        }
        if (text) {
          try {
            await sb('wios_coach_directives', {
              method: 'POST',
              headers: { 'Prefer': 'return=minimal' },
              body: JSON.stringify({ created_by: me.id, target_user_id: target, directive: text }),
            });
          } catch (e) { console.error('directive store failed', e); }
        }
        answer = answer.replace(dm[0], '').trim();
      }
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
