// ============================================================
// WIOS Coaching bot. A weekly leadership coach for each person.
//
// POST { action: 'ensure' }
//   - Prunes coaching messages older than 4 weeks.
//   - If this week (Monday based) has no auto feedback yet, generates
//     it from last week's records against the person's role, stores it.
//   - Returns the whole remaining thread (last 4 weeks), oldest first.
//
// POST { action: 'chat', message }
//   - Appends the user's message, generates the coach's reply using the
//     recent thread as context, stores and returns the reply.
//
// Coaching is always personal: only the caller's own records are used,
// even for the admin. Records are stored per person and never shared.
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
// Monday (UTC) of the week containing date d, as YYYY-MM-DD.
function mondayKey(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay();                 // 0 Sun .. 6 Sat
  const back = (dow + 6) % 7;                // days since Monday
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

    const payload = JSON.parse(event.body || '{}');
    const action = String(payload.action || 'ensure');

    // ── history is kept permanently in the database so the coach remembers everything.
    //    The chat window only SHOWS the last 4 weeks; older turns still inform the coach. ──
    const windowStart = new Date(Date.now() - 28 * 864e5).toISOString();

    // load the visible thread (last 4 weeks, oldest first) for the chat window
    async function loadVisibleThread() {
      return await sb(`wios_coaching_messages?user_id=eq.${me.id}&created_at=gte.${encodeURIComponent(windowStart)}&select=*&order=created_at.asc&limit=400`);
    }
    // load recent history (for model context) going a bit further back than the window
    async function loadContextThread() {
      return await sb(`wios_coaching_messages?user_id=eq.${me.id}&select=*&order=created_at.desc&limit=60`);
    }

    const firstName = (me.name || '').split(' ')[0] || me.name;

    const coachSystemBase =
`You are the leadership coach inside WIOS, the leadership workspace for Ugly Donuts & Corn Dogs.
You coach one person: ${me.role} ${me.name}. Speak directly to them ("you").

YOUR STANCE: You are a guide, not a critic. Your tone is supportive and developmental, but you are coldly honest about the real situation. You do not soften the truth to be nice, and you do not flatter. If something is not ready, or there is no visible progress, you say so plainly and then help them fix it. Being kind here means telling them what they actually need to hear so they can grow, not making them feel good.

HOW YOU COACH:
- Judge them against the definition of THEIR seat in the role reference below, not against a generic idea of being busy.
- Use their real records (tasks, goals, coop and role-project work) as evidence. Cite specific real examples. Never invent tasks, dates, or numbers.
- Ask probing questions. Do not just deliver a verdict. Dig into what they are actually preparing, what their plan is, and where THEY themselves feel unprepared. Draw it out of them. A good coach asks "what is your plan for X", "what do you feel is missing", "how far along is Y really", and makes them think, not just receive.
- Keep the company's real stakes front and center. Ugly Donuts is now officially franchising. Soon serious, experienced operators (people who run dozens of units) will come to franchise this brand. Coach toward that reality. For the ${me.role}, always tie feedback to whether they are getting ready for it. For the COO specifically: when those big operators arrive to be trained, is the COO ready to train them? What is the training program, the certification, the audit system? What is built, what is only an idea, what is missing? Press on this.
- PROGRESS OVER TIME: You have long-term memory (see COACHING MEMORY below, a digest of every past weekly note). Every weekly note MUST compare to the week before: did they improve, hold steady, or show no progress on what you flagged last time. If you told them to do something and it still has not happened, name that directly. Praise real progress specifically; do not invent progress that is not in the records.
- You may reason beyond the document to give genuinely useful growth guidance, as long as it fits the company's franchising-only, build-the-system-so-it-runs-without-you direction.

FORMAT (very important, the reader wants to understand at a glance, not read a wall of text):
- Write in short, scannable sections with clear labels, not long paragraphs.
- Use these section markers exactly, each on its own line, so the app can style them:
  "## Where you stand" , "## What went well" , "## What is missing" , "## Franchise readiness" , "## Questions for you" , "## Focus this week"
- Under each, use short bullet lines starting with "- ". Keep each bullet to one or two sentences.
- In "## Questions for you", ask 2 or 3 real questions that make them reflect and that you want them to answer back to you in chat.
- Keep the whole note tight. Quality over length.
Never use em dashes. Use commas, periods, or parentheses instead.

When the person replies in chat, keep the same guide-but-honest stance, keep probing, and keep answers short and structured with the same section and bullet style when it helps.

ROLE REFERENCE:
${ROLES_DOC}`;

    // Long-term memory: a digest of all past weekly notes (kept forever in the DB).
    // Included in the system prompt so the coach remembers across the whole history.
    async function memoryDigest() {
      const weeklies = await sb(`wios_coaching_messages?user_id=eq.${me.id}&is_weekly=eq.true&select=week_key,content&order=week_key.asc&limit=200`);
      if (!weeklies.length) return '';
      const lines = weeklies.map((w) => `Week of ${w.week_key}:\n${String(w.content).slice(0, 800)}`);
      return `\n\nCOACHING MEMORY (your past weekly notes to this person, oldest first):\n${lines.join('\n\n')}`;
    }

    // Gather this person's own records for a given window (used for the weekly feedback).
    async function gatherRecords(sinceIso) {
      const idq = `"${me.id}"`;
      const tasks = await sb(`wios_tasks?owner_id=in.(${idq})&select=*&order=created_at.desc&limit=1000`);
      const goals = await sb(`wios_goals?owner_id=in.(${idq})&status=neq.deleted&select=*&order=period_key.desc&limit=500`);
      const recs = await sb(`wios_recurrings?owner_id=in.(${idq})&select=*&limit=200`);

      const inWindow = (ts) => ts && ts >= sinceIso;
      const taskLines = tasks.map((t) => {
        const bits = [`[${t.status}]`, t.title];
        if (t.urgent) bits.push('urgent');
        if (t.status === 'done' && t.completed_at) bits.push(`done ${fmt(t.completed_at)}`);
        bits.push(`created ${fmt(t.created_at)}`);
        return '- ' + bits.join(' ');
      });
      const doneLastWeek = tasks.filter((t) => t.status === 'done' && inWindow(t.completed_at));
      const goalLines = goals.map((g) => {
        const bits = [`[${g.period_type} ${g.period_key}]`, g.title, `- ${g.status}`];
        if (g.completed_at) bits.push(`completed ${fmt(g.completed_at)}`);
        return '- ' + bits.join(' ');
      });
      const recLines = recs.map((r) => {
        const bits = [r.title, `(streak ${r.streak}, best ${r.best_streak})`];
        if (!r.active) bits.push('paused');
        return '- ' + bits.join(' ');
      });
      return { tasks, taskLines, doneLastWeek, goalLines, recLines };
    }

    // ---------------------------------------------------------
    if (action === 'ensure') {
      const now = new Date();
      const thisWeek = mondayKey(now);

      const existingWeekly = await sb(`wios_coaching_messages?user_id=eq.${me.id}&week_key=eq.${thisWeek}&is_weekly=eq.true&select=id&limit=1`);
      if (!existingWeekly.length) {
        // last week = the 7 days before this Monday
        const lastMon = new Date(thisWeek + 'T00:00:00Z');
        const prevMon = new Date(lastMon.getTime() - 7 * 864e5);
        const sinceIso = prevMon.toISOString();
        const rec = await gatherRecords(sinceIso);

        const dataBlock =
`TODAY: ${fmt(now.toISOString())}
COACHING: ${me.role} ${me.name}
LAST WEEK: ${isoDay(prevMon)} to ${isoDay(lastMon)}

=== TASKS COMPLETED LAST WEEK (${rec.doneLastWeek.length}) ===
${rec.doneLastWeek.map((t) => `- ${t.title}${t.urgent ? ' (urgent)' : ''} done ${fmt(t.completed_at)}`).join('\n') || 'none recorded'}

=== ALL RECENT TASKS (${rec.tasks.length}) ===
${rec.taskLines.join('\n') || 'none'}

=== GOALS ===
${rec.goalLines.join('\n') || 'none'}

=== DAILY REMINDERS ===
${rec.recLines.join('\n') || 'none'}`;

        const weeklyUserPrompt =
`Write ${firstName}'s weekly coaching note for the week that just ended, using the exact section format from your instructions ("## Where you stand", "## What went well", "## What is missing", "## Franchise readiness", "## Questions for you", "## Focus this week"), with short "- " bullets under each.
Requirements:
- Compare to last week using COACHING MEMORY. In "## Where you stand", say plainly whether they improved, held steady, or showed no progress on what you flagged before. If a past flag is still unaddressed, name it.
- Ground everything in the real records below. Cite specific tasks or goals. Do not invent progress.
- In "## Franchise readiness", assess how ready they are as ${me.role} for real franchise operators arriving soon (for the COO, focus on training, certification, and audit systems: what is built, what is only an idea, what is missing).
- In "## Questions for you", ask 2 or 3 pointed questions you want them to answer back in chat.
Talk straight to them. Honest and developmental, not flattering, not harsh.

${dataBlock}`;

        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: MODEL, max_tokens: 1400, system: coachSystemBase + (await memoryDigest()),
            messages: [{ role: 'user', content: weeklyUserPrompt }],
          }),
        });
        if (aiRes.ok) {
          const ai = await aiRes.json();
          const text = (ai.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          if (text) {
            await sb('wios_coaching_messages', {
              method: 'POST',
              body: JSON.stringify({ user_id: me.id, role: 'coach', content: text, week_key: thisWeek, is_weekly: true }),
            });
          }
        } else {
          console.error('coach weekly gen failed', aiRes.status, await aiRes.text());
          // do not hard-fail the whole call; just return the thread without a new weekly
        }
      }

      const thread = await loadVisibleThread();
      return { statusCode: 200, headers: cors, body: JSON.stringify({ thread, week_key: thisWeek }) };
    }

    // ---------------------------------------------------------
    if (action === 'chat') {
      const message = String(payload.message || '').trim().slice(0, 2000);
      if (!message) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Say something.' }) };
      const now = new Date();
      const thisWeek = mondayKey(now);

      // store the user's message
      await sb('wios_coaching_messages', {
        method: 'POST',
        body: JSON.stringify({ user_id: me.id, role: 'user', content: message, week_key: thisWeek, is_weekly: false }),
      });

      // build context from recent history (newest 60, then oldest first) so the coach
      // remembers earlier conversations even beyond the 4-week display window
      const ctx = (await loadContextThread()).reverse();
      const recentTurns = ctx.slice(-24).map((m) => ({
        role: m.role === 'coach' ? 'assistant' : 'user',
        content: String(m.content).slice(0, 4000),
      }));
      // ensure it ends with the user's new message
      const messages = recentTurns.length && recentTurns[recentTurns.length - 1].role === 'user'
        ? recentTurns
        : [...recentTurns, { role: 'user', content: message }];

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 1400, system: coachSystemBase + (await memoryDigest()), messages }),
      });
      if (!aiRes.ok) {
        console.error('coach chat failed', aiRes.status, await aiRes.text());
        return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'The coach did not respond. Try again in a moment.' }) };
      }
      const ai = await aiRes.json();
      const answer = (ai.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
        || 'Let me think about that with you. Can you say a little more?';

      await sb('wios_coaching_messages', {
        method: 'POST',
        body: JSON.stringify({ user_id: me.id, role: 'coach', content: answer, week_key: thisWeek, is_weekly: false }),
      });

      return { statusCode: 200, headers: cors, body: JSON.stringify({ answer }) };
    }

    // ---------------------------------------------------------
    // Admin only: read another person's coaching thread (last 4 weeks shown).
    if (action === 'read_user') {
      if (!me.is_admin) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Not allowed.' }) };
      const target = String(payload.user_id || '').trim();
      if (!target) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing user.' }) };
      const thread = await sb(`wios_coaching_messages?user_id=eq.${target}&created_at=gte.${encodeURIComponent(windowStart)}&select=*&order=created_at.asc&limit=400`);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ thread }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
