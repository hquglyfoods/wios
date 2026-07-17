// ============================================================
// WIOS scheduled function. Runs every 30 minutes (netlify.toml).
// 1. Waiting tasks whose remind time arrived  -> back to Active + push
// 2. Scheduled tasks whose date arrived       -> Active + push
// 3. Recurring reminders due now (ET)         -> push (once per day)
// 4. New goal periods (week/month/semester/yr)-> urgent goal prompt task + push
// ============================================================
const { pushToUsers, makeSb } = require('./lib-push.js');

const TZ = 'America/New_York';

function etParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`,
    dow: dowMap[p.weekday],
    y: +p.year, m: +p.month, day: +p.day,
  };
}

const pad = (n) => String(n).padStart(2, '0');

function periodKeys(et) {
  // week key = Monday of the current ET week, as YYYY-MM-DD
  const base = new Date(Date.UTC(et.y, et.m - 1, et.day));
  const shift = (et.dow + 6) % 7; // days since Monday
  base.setUTCDate(base.getUTCDate() - shift);
  const week = `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
  return {
    week,
    month: `${et.y}-${pad(et.m)}`,
    semester: `${et.y}-H${et.m <= 6 ? 1 : 2}`,
    year: String(et.y),
  };
}

const PERIOD_LABEL = { week: 'Weekly', month: 'Monthly', semester: 'Semester', year: 'Yearly' };

function lastDayOfMonth(y, m) { return new Date(y, m, 0).getDate(); } // m = 1..12

function recurringDueToday(rec, et) {
  if (rec.freq === 'daily') return true;
  if (rec.freq === 'weekly') return Array.isArray(rec.days) && rec.days.includes(et.dow);
  if (rec.freq === 'monthly') {
    const dom = Math.min(rec.day_of_month || 1, lastDayOfMonth(et.y, et.m));
    return et.day === dom;
  }
  return false;
}

exports.handler = async () => {
  const env = process.env;
  const sb = makeSb(env);
  const nowIso = new Date().toISOString();
  const et = etParts();
  const report = { waiting: 0, scheduled: 0, recurring: 0, goalPrompts: 0 };

  try {
    // ── 1. Waiting tasks due back ───────────────────────────
    const waiting = await sb(`wios_tasks?status=eq.waiting&remind_at=lte.${encodeURIComponent(nowIso)}&select=id,owner_id,title`);
    for (const t of waiting) {
      await sb(`wios_tasks?id=eq.${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active', reminded: true }),
      });
      await pushToUsers([t.owner_id], {
        title: 'Follow-up reminder', body: t.title, tag: 'wios-remind', url: '/',
      }, env);
      report.waiting++;
    }

    // ── 2. Scheduled tasks due ──────────────────────────────
    const scheduled = await sb(`wios_tasks?status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(nowIso)}&select=id,owner_id,title`);
    for (const t of scheduled) {
      await sb(`wios_tasks?id=eq.${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active', reminded: true }),
      });
      await pushToUsers([t.owner_id], {
        title: 'Back on your list', body: t.title, tag: 'wios-sched', url: '/', kind: 'task',
      }, env);
      report.scheduled++;
    }

    // ── 2b. Coop pass reminders (nudge whoever the ball is with) ──
    const coopsDue = await sb(`wios_coops?status=eq.active&reminded=eq.false&remind_at=lte.${encodeURIComponent(nowIso)}&select=id,title,holder_id,pending_id`);
    for (const c of coopsDue) {
      const who = c.holder_id || c.pending_id;
      if (who) {
        await pushToUsers([who], {
          title: 'Still waiting on you', body: c.title, tag: 'wios-coop-remind',
          url: `/?coop=${c.id}`, coopId: c.id,
        }, env);
      }
      await sb(`wios_coops?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ reminded: true }) });
      report.coopReminders = (report.coopReminders || 0) + 1;
    }

    // ── 2c. Deadline reminders: push 24h before a task's "finish before" time ──
    const in24h = new Date(Date.now() + 24 * 3600000).toISOString();
    const dueSoonTasks = await sb(`wios_tasks?status=eq.active&due_reminded=eq.false&due_at=lte.${encodeURIComponent(in24h)}&due_at=gt.${encodeURIComponent(nowIso)}&select=id,owner_id,title,due_at`);
    for (const t of dueSoonTasks) {
      await pushToUsers([t.owner_id], {
        title: 'Due within 24 hours', body: t.title, tag: 'wios-due-' + t.id, url: '/', kind: 'task',
      }, env);
      await sb(`wios_tasks?id=eq.${t.id}`, { method: 'PATCH', body: JSON.stringify({ due_reminded: true }) });
      report.dueReminders = (report.dueReminders || 0) + 1;
    }

    // ── 2d. Task reminders: push at the exact alarm_at time the user set ──
    // Only for tasks still on the person's list (active or waiting), fired once.
    const alarmTasks = await sb(`wios_tasks?alarm_fired=eq.false&alarm_at=lte.${encodeURIComponent(nowIso)}&status=in.(active,waiting)&select=id,owner_id,title,alarm_at`);
    for (const t of alarmTasks) {
      await pushToUsers([t.owner_id], {
        title: 'Reminder', body: t.title, tag: 'wios-alarm-' + t.id, url: '/', kind: 'task',
      }, env);
      await sb(`wios_tasks?id=eq.${t.id}`, { method: 'PATCH', body: JSON.stringify({ alarm_fired: true }) });
      report.alarms = (report.alarms || 0) + 1;
    }

    // ── 3. Recurring reminders ──────────────────────────────
    const recs = await sb('wios_recurrings?active=eq.true&select=*');
    for (const r of recs) {
      if (!recurringDueToday(r, et)) continue;
      if (r.last_done_date === et.dateStr) continue;   // already done today
      if (r.last_pushed_date === et.dateStr) continue; // already handled today
      if ((r.time_hhmm || '09:00') > et.hhmm) continue; // not yet time

      // Drop a real task card in the owner's Active list (one per recurring per day),
      // then push about that exact card. Push only fires when a new card was created,
      // so the notification always matches something actually on their list.
      const sysRef = `rec:${r.id}:${et.dateStr}`;
      const exists = await sb(`wios_tasks?owner_id=eq.${r.owner_id}&system_ref=eq.${encodeURIComponent(sysRef)}&select=id`);
      let created = false;
      if (!exists.length) {
        try {
          await sb('wios_tasks', {
            method: 'POST',
            body: JSON.stringify({
              owner_id: r.owner_id, title: r.title, status: 'active',
              is_system: true, system_kind: 'recurring', system_ref: sysRef,
            }),
          });
          created = true;
        } catch (e) { /* unique guard raced: card already exists, fine */ }
      }
      if (created || !exists.length) {
        await pushToUsers([r.owner_id], {
          title: 'Recurring task is due', body: r.title, tag: 'wios-rec-' + r.id, url: '/', kind: 'task',
        }, env);
      }
      await sb(`wios_recurrings?id=eq.${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_pushed_date: et.dateStr }),
      });
      report.recurring++;
    }

    // ── 4. Goal period prompts ──────────────────────────────
    const keys = periodKeys(et);
    const users = await sb('wios_profiles?active=eq.true&select=id,name');
    for (const u of users) {
      for (const type of ['week', 'month', 'semester', 'year']) {
        const key = keys[type];
        const existing = await sb(`wios_goal_periods?user_id=eq.${u.id}&period_type=eq.${type}&period_key=eq.${encodeURIComponent(key)}&select=user_id`);
        if (existing.length) continue;
        // new period for this user: record it, create urgent prompt task, push
        await sb('wios_goal_periods', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({ user_id: u.id, period_type: type, period_key: key, prompted: true }),
        });
        const sysRef = `${type}:${key}`;
        try {
          await sb('wios_tasks', {
            method: 'POST',
            body: JSON.stringify({
              owner_id: u.id,
              title: `Review last period & set your ${PERIOD_LABEL[type]} goals`,
              status: 'active', urgent: true,
              is_system: true, system_kind: 'goal_prompt', system_ref: sysRef,
            }),
          });
        } catch (e) {
          // unique index guard: prompt already exists, fine
        }
        await pushToUsers([u.id], {
          title: `${PERIOD_LABEL[type]} goals`, body: 'Time to review last period and set new goals.', tag: 'wios-goal', url: '/',
        }, env);
        report.goalPrompts++;
      }
    }

    console.log('cron report', JSON.stringify(report), 'ET', et.dateStr, et.hhmm);
    return { statusCode: 200, body: JSON.stringify(report) };
  } catch (e) {
    console.error('cron error', e);
    return { statusCode: 500, body: e.message };
  }
};
