-- ############################################################
-- #  SQL 01 of 03  ·  WIOS SCHEMA                             #
-- #  Run this FIRST. Sets up every table, all security, and   #
-- #  the 5 founder accounts (shared password Djrmffl202!).    #
-- #  Safe to re-run any time to pick up changes.              #
-- #  Run 02 and 03 only if you hit the problem they describe. #
-- ############################################################

-- ============================================================
-- WIOS schema (its own Supabase project: xttqxjuunuchlxjrknyt)
-- All tables use the wios_ prefix, each with its own RLS.
--
-- This file is IDEMPOTENT: safe on a fresh database AND safe to
-- re-run on an existing one to pick up changes.
-- ============================================================

-- ── 1. Profiles ─────────────────────────────────────────────
create table if not exists public.wios_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null,                        -- free text short label: CEO, CBO, CMO, COO, CPO, CFO ...
  is_admin boolean not null default false,   -- admins see the Team tab and manage members
  active boolean not null default true,      -- deactivate instead of deleting (keeps their history)
  created_at timestamptz not null default now()
);
-- upgrade path for an earlier install
alter table public.wios_profiles drop constraint if exists wios_profiles_role_check;
alter table public.wios_profiles add column if not exists is_admin boolean not null default false;
alter table public.wios_profiles add column if not exists active boolean not null default true;
update public.wios_profiles set is_admin = true where lower(role) = 'ceo' and is_admin = false;
update public.wios_profiles set role = upper(role) where role <> upper(role);

-- ── 2. Personal tasks (incl. system goal prompts) ───────────
create table if not exists public.wios_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wios_profiles(id) on delete cascade,
  title text not null,
  notes text,
  status text not null default 'active' check (status in ('active','waiting','scheduled','done')),
  urgent boolean not null default false,
  reminded boolean not null default false,   -- came back from waiting or scheduled
  remind_at timestamptz,                     -- waiting: when to bring it back
  waiting_since timestamptz,                 -- waiting: for the "N days waiting" count
  scheduled_at timestamptz,                  -- scheduled: when to surface it
  is_system boolean not null default false,  -- goal prompt tasks
  system_kind text,                          -- 'goal_prompt'
  system_ref text,                           -- e.g. 'week:2026-07-13'
  sort_order double precision,               -- manual ordering within Active (lower = higher up)
  subtasks jsonb not null default '[]'::jsonb, -- [{id, text, done}]
  due_at timestamptz,                          -- optional "finish before" deadline
  due_reminded boolean not null default false, -- so the 24h-before push fires once
  alarm_at timestamptz,                         -- optional reminder: push at this exact time
  alarm_fired boolean not null default false,   -- so the reminder push fires once
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists wios_tasks_owner_idx on public.wios_tasks(owner_id, status);
alter table public.wios_tasks add column if not exists alarm_at timestamptz;
alter table public.wios_tasks add column if not exists alarm_fired boolean not null default false;
create unique index if not exists wios_tasks_sysref_uq
  on public.wios_tasks(owner_id, system_ref) where system_ref is not null;
-- upgrade path for an earlier install
alter table public.wios_tasks add column if not exists sort_order double precision;
alter table public.wios_tasks add column if not exists subtasks jsonb not null default '[]'::jsonb;
alter table public.wios_tasks add column if not exists due_at timestamptz;
alter table public.wios_tasks add column if not exists due_reminded boolean not null default false;

-- ── 3. Coop tasks (relay / baton model) ─────────────────────
create table if not exists public.wios_coops (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  notes text,
  creator_id uuid not null references public.wios_profiles(id),
  holder_id uuid references public.wios_profiles(id),       -- whose turn (null while an invite is pending)
  pending_id uuid references public.wios_profiles(id),      -- invited via pass, not yet accepted
  last_holder_id uuid references public.wios_profiles(id),  -- restore point if an invite is declined
  status text not null default 'active' check (status in ('active','closed')),
  urgent boolean not null default false,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.wios_profiles(id),
  remind_at timestamptz,                                   -- nudge the current holder if still their turn
  reminded boolean not null default false
);
-- upgrade path
alter table public.wios_coops add column if not exists remind_at timestamptz;
alter table public.wios_coops add column if not exists reminded boolean not null default false;

create table if not exists public.wios_coop_members (
  coop_id uuid not null references public.wios_coops(id) on delete cascade,
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  invited_by uuid references public.wios_profiles(id),
  invite_message text,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (coop_id, user_id)
);

create table if not exists public.wios_coop_messages (
  id uuid primary key default gen_random_uuid(),
  coop_id uuid not null references public.wios_coops(id) on delete cascade,
  user_id uuid not null references public.wios_profiles(id),
  kind text not null default 'comment' check (kind in ('comment','pass','system')),
  body text,
  pass_to uuid references public.wios_profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists wios_coop_msgs_idx on public.wios_coop_messages(coop_id, created_at);

-- ── 3b. Requests (one asker -> many recipients; each accepts then completes) ──
create table if not exists public.wios_requests (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.wios_profiles(id) on delete cascade,
  title text not null,
  message text,
  urgent boolean not null default false,
  status text not null default 'open' check (status in ('open','done')),  -- done = creator closed it
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists wios_requests_idx on public.wios_requests(creator_id, status);

create table if not exists public.wios_request_targets (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.wios_requests(id) on delete cascade,
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','completed','declined')),
  accepted_at timestamptz,
  completed_at timestamptz,
  unique (request_id, user_id)
);
create index if not exists wios_req_targets_idx on public.wios_request_targets(user_id, status);

-- ── 3c. Role projects (many people share a project, each owns a role of tasks) ──
create table if not exists public.wios_role_projects (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.wios_profiles(id) on delete cascade,
  title text not null,
  description text,
  due_at timestamptz,                        -- the project deadline (set at creation)
  status text not null default 'active' check (status in ('active','done')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists wios_role_projects_idx on public.wios_role_projects(creator_id, status);
alter table public.wios_role_projects add column if not exists due_at timestamptz;

create table if not exists public.wios_role_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.wios_role_projects(id) on delete cascade,
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  status text not null default 'working' check (status in ('working','completed','acknowledged')),
  completed_at timestamptz,
  acknowledged_at timestamptz,
  unique (project_id, user_id)
);
create index if not exists wios_role_members_idx on public.wios_role_members(user_id, status);
alter table public.wios_role_members add column if not exists acknowledged_at timestamptz;
alter table public.wios_role_members drop constraint if exists wios_role_members_status_check;
alter table public.wios_role_members add constraint wios_role_members_status_check check (status in ('working','completed','acknowledged'));

create table if not exists public.wios_role_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.wios_role_projects(id) on delete cascade,
  assignee_id uuid not null references public.wios_profiles(id) on delete cascade,  -- whose role
  title text not null,
  due_at timestamptz,
  done boolean not null default false,
  added_by uuid references public.wios_profiles(id) on delete set null,
  approved boolean not null default true,   -- false when someone else added to your role and you have not approved
  created_at timestamptz not null default now()
);
create index if not exists wios_role_items_idx on public.wios_role_items(project_id, assignee_id);

-- ── 4. Goals ────────────────────────────────────────────────
create table if not exists public.wios_goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wios_profiles(id) on delete cascade,
  period_type text not null check (period_type in ('week','month','semester','year')),
  period_key text not null,       -- week: monday date, month: YYYY-MM, semester: YYYY-H1, year: YYYY
  title text not null,
  status text not null default 'open',
  kept_from text,                 -- previous period_key if the goal was kept
  parent_id uuid references public.wios_goals(id) on delete set null, -- links a goal to a higher-period goal
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists wios_goals_idx on public.wios_goals(owner_id, period_type, period_key);
alter table public.wios_goals add column if not exists parent_id uuid references public.wios_goals(id) on delete set null;
-- 'kept' status: rebuild the constraint every run so an earlier install picks it up
alter table public.wios_goals drop constraint if exists wios_goals_status_check;
alter table public.wios_goals add constraint wios_goals_status_check
  check (status in ('open','completed','kept','deleted'));

create table if not exists public.wios_goal_periods (
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  period_type text not null check (period_type in ('week','month','semester','year')),
  period_key text not null,
  prompted boolean not null default false,
  review_done boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, period_type, period_key)
);

-- ── 5. Recurring reminders (daily / weekly / monthly) ───────
create table if not exists public.wios_recurrings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wios_profiles(id) on delete cascade,
  title text not null,
  freq text not null check (freq in ('daily','weekly','monthly')),
  days smallint[],                          -- weekly: 0=Sun .. 6=Sat
  day_of_month smallint,                    -- monthly: 1..31 (clamped to the end of short months)
  time_hhmm text not null default '09:00',  -- 30-minute steps
  streak int not null default 0,
  best_streak int not null default 0,
  last_done_date date,
  last_pushed_date date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.wios_recurring_logs (
  id uuid primary key default gen_random_uuid(),
  rec_id uuid not null references public.wios_recurrings(id) on delete cascade,
  done_date date not null,
  created_at timestamptz not null default now(),
  unique (rec_id, done_date)
);

-- ── 6. Push subscriptions ───────────────────────────────────
create table if not exists public.wios_push_subs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- in-app notification feed (mirrors every push we send)
create table if not exists public.wios_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  title text not null,
  body text,
  kind text,                                 -- 'coop' | 'task' | 'goal' | ...
  coop_id uuid,                              -- deep-link target when relevant
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists wios_notif_idx on public.wios_notifications(user_id, created_at desc);

-- Weekly coaching bot: one thread per person. The Monday feedback and the back-and-forth
-- chat both live here. week_key is the Monday (YYYY-MM-DD) the thread belongs to. Rows older
-- than 4 weeks are pruned by the coach function; nothing else deletes them.
create table if not exists public.wios_coaching_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  role text not null,                        -- 'coach' | 'user'
  content text not null,
  week_key text not null,                    -- Monday of the week this belongs to, YYYY-MM-DD
  is_weekly boolean not null default false,  -- true for the auto Monday feedback message
  created_at timestamptz not null default now()
);
create index if not exists wios_coach_idx on public.wios_coaching_messages(user_id, created_at);
create unique index if not exists wios_coach_weekly_uq
  on public.wios_coaching_messages(user_id, week_key) where is_weekly;

-- CEO assistant brief: an admin-only weekly report that summarizes every C-level's week
-- (their work plus what their coach told them and whether they acted on it), and the chat
-- about it. owner_id is the admin who owns this brief thread. Kept forever; the app shows
-- the last 4 weeks of the chat window.
create table if not exists public.wios_ceo_brief_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wios_profiles(id) on delete cascade,
  role text not null,                        -- 'assistant' | 'user'
  content text not null,
  week_key text not null,
  is_weekly boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists wios_ceobrief_idx on public.wios_ceo_brief_messages(owner_id, created_at);
create unique index if not exists wios_ceobrief_weekly_uq
  on public.wios_ceo_brief_messages(owner_id, week_key) where is_weekly;

-- Ask bot memory: every question and answer, kept forever, so the bot remembers past
-- conversations and the person's style. The Ask screen starts fresh each open (it does not
-- replay old turns), but the bot loads recent history plus a digest for context.
create table if not exists public.wios_ask_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  role text not null,                        -- 'assistant' | 'user'
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists wios_ask_idx on public.wios_ask_messages(user_id, created_at);

-- Coaching directives: standing instructions the CEO gives (through the CEO assistant) that the
-- coaching bots must quietly follow. target_user_id null means it applies to every leader;
-- otherwise it applies to that one person. Coaches read active directives into their prompt but
-- never reveal them to the person being coached.
create table if not exists public.wios_coach_directives (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.wios_profiles(id) on delete cascade,
  target_user_id uuid references public.wios_profiles(id) on delete cascade,   -- null = all leaders
  directive text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists wios_directive_idx on public.wios_coach_directives(target_user_id, active);





-- ============================================================
-- Helpers (security definer avoids RLS policy recursion)
-- ============================================================
create or replace function public.wios_is_user()
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wios_profiles where id = auth.uid() and active) $$;

create or replace function public.wios_is_admin()
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wios_profiles where id = auth.uid() and is_admin and active) $$;

create or replace function public.wios_is_coop_member(cid uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wios_coop_members where coop_id = cid and user_id = auth.uid()) $$;

-- Used only by the wios-members Netlify function (service key) to find an
-- existing uglyops account by email. Never callable from an app client.
create or replace function public.wios_find_auth_user(p_email text)
returns uuid language sql security definer set search_path = public, auth as
$$ select id from auth.users where lower(email) = lower(p_email) limit 1 $$;
revoke all on function public.wios_find_auth_user(text) from public, anon, authenticated;
grant execute on function public.wios_find_auth_user(text) to service_role;

-- ============================================================
-- RLS
-- ============================================================
alter table public.wios_profiles enable row level security;
alter table public.wios_tasks enable row level security;
alter table public.wios_coops enable row level security;
alter table public.wios_coop_members enable row level security;
alter table public.wios_coop_messages enable row level security;
alter table public.wios_goals enable row level security;
alter table public.wios_goal_periods enable row level security;
alter table public.wios_recurrings enable row level security;
alter table public.wios_recurring_logs enable row level security;
alter table public.wios_push_subs enable row level security;
alter table public.wios_notifications enable row level security;
alter table public.wios_coaching_messages enable row level security;
alter table public.wios_ceo_brief_messages enable row level security;
alter table public.wios_ask_messages enable row level security;
alter table public.wios_coach_directives enable row level security;

-- profiles: every active WIOS user sees the roster (needed to address teammates).
-- Members are added and deactivated by the wios-members function using the
-- service key, so no client insert or update policy is granted here.
drop policy if exists wios_profiles_select on public.wios_profiles;
create policy wios_profiles_select on public.wios_profiles
  for select using (public.wios_is_user());

-- tasks: owner full access, admins read-all
drop policy if exists wios_tasks_select on public.wios_tasks;
create policy wios_tasks_select on public.wios_tasks
  for select using (owner_id = auth.uid() or public.wios_is_admin());
drop policy if exists wios_tasks_insert on public.wios_tasks;
create policy wios_tasks_insert on public.wios_tasks
  for insert with check (owner_id = auth.uid());
drop policy if exists wios_tasks_update on public.wios_tasks;
create policy wios_tasks_update on public.wios_tasks
  for update using (owner_id = auth.uid());
drop policy if exists wios_tasks_delete on public.wios_tasks;
create policy wios_tasks_delete on public.wios_tasks
  for delete using (owner_id = auth.uid());

-- coops: members and creator, admins read-all
drop policy if exists wios_coops_select on public.wios_coops;
create policy wios_coops_select on public.wios_coops
  for select using (creator_id = auth.uid() or public.wios_is_coop_member(id) or public.wios_is_admin());
drop policy if exists wios_coops_insert on public.wios_coops;
create policy wios_coops_insert on public.wios_coops
  for insert with check (creator_id = auth.uid() and public.wios_is_user());
drop policy if exists wios_coops_update on public.wios_coops;
create policy wios_coops_update on public.wios_coops
  for update using (creator_id = auth.uid() or public.wios_is_coop_member(id));
drop policy if exists wios_coops_delete on public.wios_coops;
create policy wios_coops_delete on public.wios_coops
  for delete using (creator_id = auth.uid() or public.wios_is_admin());

drop policy if exists wios_cm_select on public.wios_coop_members;
create policy wios_cm_select on public.wios_coop_members
  for select using (user_id = auth.uid() or public.wios_is_coop_member(coop_id) or public.wios_is_admin());
drop policy if exists wios_cm_insert on public.wios_coop_members;
create policy wios_cm_insert on public.wios_coop_members
  for insert with check (public.wios_is_coop_member(coop_id) or
    exists (select 1 from public.wios_coops c where c.id = coop_id and c.creator_id = auth.uid()));
drop policy if exists wios_cm_update on public.wios_coop_members;
create policy wios_cm_update on public.wios_coop_members
  for update using (user_id = auth.uid());
drop policy if exists wios_cm_delete on public.wios_coop_members;
create policy wios_cm_delete on public.wios_coop_members
  for delete using (user_id = auth.uid() or public.wios_is_admin()
    or exists (select 1 from public.wios_coops c where c.id = coop_id and c.creator_id = auth.uid()));

drop policy if exists wios_msg_select on public.wios_coop_messages;
create policy wios_msg_select on public.wios_coop_messages
  for select using (public.wios_is_coop_member(coop_id) or public.wios_is_admin());
drop policy if exists wios_msg_insert on public.wios_coop_messages;
create policy wios_msg_insert on public.wios_coop_messages
  for insert with check (user_id = auth.uid() and public.wios_is_coop_member(coop_id));
drop policy if exists wios_msg_delete on public.wios_coop_messages;
create policy wios_msg_delete on public.wios_coop_messages
  for delete using (public.wios_is_admin()
    or exists (select 1 from public.wios_coops c where c.id = coop_id and c.creator_id = auth.uid()));

-- goals: owner full access, admins read-all
drop policy if exists wios_goals_select on public.wios_goals;
create policy wios_goals_select on public.wios_goals
  for select using (owner_id = auth.uid() or public.wios_is_admin());
drop policy if exists wios_goals_write on public.wios_goals;
create policy wios_goals_write on public.wios_goals
  for insert with check (owner_id = auth.uid());
drop policy if exists wios_goals_update on public.wios_goals;
create policy wios_goals_update on public.wios_goals
  for update using (owner_id = auth.uid());
drop policy if exists wios_goals_delete on public.wios_goals;
create policy wios_goals_delete on public.wios_goals
  for delete using (owner_id = auth.uid());

drop policy if exists wios_gp_select on public.wios_goal_periods;
create policy wios_gp_select on public.wios_goal_periods
  for select using (user_id = auth.uid() or public.wios_is_admin());
drop policy if exists wios_gp_insert on public.wios_goal_periods;
create policy wios_gp_insert on public.wios_goal_periods
  for insert with check (user_id = auth.uid());
drop policy if exists wios_gp_update on public.wios_goal_periods;
create policy wios_gp_update on public.wios_goal_periods
  for update using (user_id = auth.uid());

-- requests: creator + targets can read; recipient updates own target row
alter table public.wios_requests enable row level security;
alter table public.wios_request_targets enable row level security;
-- security definer helpers break the requests <-> targets policy loop
create or replace function public.wios_is_request_target(rid uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wios_request_targets t
                  where t.request_id = rid and t.user_id = auth.uid()); $$;
create or replace function public.wios_is_request_creator(rid uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wios_requests r
                  where r.id = rid and r.creator_id = auth.uid()); $$;
revoke all on function public.wios_is_request_target(uuid) from public;
revoke all on function public.wios_is_request_creator(uuid) from public;
grant execute on function public.wios_is_request_target(uuid) to authenticated;
grant execute on function public.wios_is_request_creator(uuid) to authenticated;
drop policy if exists wios_requests_select on public.wios_requests;
create policy wios_requests_select on public.wios_requests for select using (
  creator_id = auth.uid() or public.wios_is_admin()
  or public.wios_is_request_target(id));
drop policy if exists wios_requests_insert on public.wios_requests;
create policy wios_requests_insert on public.wios_requests for insert with check (creator_id = auth.uid());
drop policy if exists wios_requests_update on public.wios_requests;
create policy wios_requests_update on public.wios_requests for update using (creator_id = auth.uid());
drop policy if exists wios_requests_delete on public.wios_requests;
create policy wios_requests_delete on public.wios_requests for delete using (creator_id = auth.uid());
drop policy if exists wios_req_targets_select on public.wios_request_targets;
create policy wios_req_targets_select on public.wios_request_targets for select using (
  user_id = auth.uid() or public.wios_is_admin()
  or public.wios_is_request_creator(request_id));
drop policy if exists wios_req_targets_insert on public.wios_request_targets;
create policy wios_req_targets_insert on public.wios_request_targets for insert with check (
  public.wios_is_request_creator(request_id));
drop policy if exists wios_req_targets_update on public.wios_request_targets;
create policy wios_req_targets_update on public.wios_request_targets for update using (
  user_id = auth.uid() or public.wios_is_request_creator(request_id));
drop policy if exists wios_req_targets_delete on public.wios_request_targets;
create policy wios_req_targets_delete on public.wios_request_targets for delete using (
  public.wios_is_request_creator(request_id));

-- role projects: any member or the creator can see and act; items are open so anyone
-- in the project can add to another person's role (that person then approves).
create or replace function public.wios_is_role_member(pid uuid) returns boolean
  language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.wios_role_members m where m.project_id = pid and m.user_id = auth.uid());
  $$;
alter table public.wios_role_projects enable row level security;
alter table public.wios_role_members enable row level security;
alter table public.wios_role_items enable row level security;

drop policy if exists wios_rp_select on public.wios_role_projects;
create policy wios_rp_select on public.wios_role_projects for select using (
  creator_id = auth.uid() or public.wios_is_admin() or public.wios_is_role_member(id));
drop policy if exists wios_rp_insert on public.wios_role_projects;
create policy wios_rp_insert on public.wios_role_projects for insert with check (creator_id = auth.uid());
drop policy if exists wios_rp_update on public.wios_role_projects;
create policy wios_rp_update on public.wios_role_projects for update using (
  creator_id = auth.uid() or public.wios_is_role_member(id));
drop policy if exists wios_rp_delete on public.wios_role_projects;
create policy wios_rp_delete on public.wios_role_projects for delete using (
  creator_id = auth.uid() or public.wios_is_admin());

drop policy if exists wios_rm_select on public.wios_role_members;
create policy wios_rm_select on public.wios_role_members for select using (
  user_id = auth.uid() or public.wios_is_admin() or public.wios_is_role_member(project_id)
  or exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid()));
drop policy if exists wios_rm_insert on public.wios_role_members;
create policy wios_rm_insert on public.wios_role_members for insert with check (
  exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid())
  or public.wios_is_role_member(project_id));
drop policy if exists wios_rm_update on public.wios_role_members;
create policy wios_rm_update on public.wios_role_members for update using (
  user_id = auth.uid()
  or exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid()));
drop policy if exists wios_rm_delete on public.wios_role_members;
create policy wios_rm_delete on public.wios_role_members for delete using (
  user_id = auth.uid()
  or exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid()));

drop policy if exists wios_ri_select on public.wios_role_items;
create policy wios_ri_select on public.wios_role_items for select using (
  public.wios_is_admin() or public.wios_is_role_member(project_id)
  or exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid()));
drop policy if exists wios_ri_insert on public.wios_role_items;
create policy wios_ri_insert on public.wios_role_items for insert with check (
  public.wios_is_role_member(project_id)
  or exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid()));
drop policy if exists wios_ri_update on public.wios_role_items;
create policy wios_ri_update on public.wios_role_items for update using (
  public.wios_is_role_member(project_id)
  or exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid()));
drop policy if exists wios_ri_delete on public.wios_role_items;
create policy wios_ri_delete on public.wios_role_items for delete using (
  public.wios_is_role_member(project_id)
  or exists (select 1 from public.wios_role_projects p where p.id = project_id and p.creator_id = auth.uid()));

-- recurrings + logs: owner full access, admins read-all
drop policy if exists wios_rec_select on public.wios_recurrings;
create policy wios_rec_select on public.wios_recurrings
  for select using (owner_id = auth.uid() or public.wios_is_admin());
drop policy if exists wios_rec_insert on public.wios_recurrings;
create policy wios_rec_insert on public.wios_recurrings
  for insert with check (owner_id = auth.uid());
drop policy if exists wios_rec_update on public.wios_recurrings;
create policy wios_rec_update on public.wios_recurrings
  for update using (owner_id = auth.uid());
drop policy if exists wios_rec_delete on public.wios_recurrings;
create policy wios_rec_delete on public.wios_recurrings
  for delete using (owner_id = auth.uid());

drop policy if exists wios_rlog_select on public.wios_recurring_logs;
create policy wios_rlog_select on public.wios_recurring_logs
  for select using (public.wios_is_admin() or
    exists (select 1 from public.wios_recurrings r where r.id = rec_id and r.owner_id = auth.uid()));
drop policy if exists wios_rlog_insert on public.wios_recurring_logs;
create policy wios_rlog_insert on public.wios_recurring_logs
  for insert with check (
    exists (select 1 from public.wios_recurrings r where r.id = rec_id and r.owner_id = auth.uid()));
drop policy if exists wios_rlog_delete on public.wios_recurring_logs;
create policy wios_rlog_delete on public.wios_recurring_logs
  for delete using (
    exists (select 1 from public.wios_recurrings r where r.id = rec_id and r.owner_id = auth.uid()));

drop policy if exists wios_push_all on public.wios_push_subs;
create policy wios_push_all on public.wios_push_subs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists wios_notif_all on public.wios_notifications;
create policy wios_notif_all on public.wios_notifications
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists wios_coach_all on public.wios_coaching_messages;
create policy wios_coach_all on public.wios_coaching_messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists wios_ceobrief_all on public.wios_ceo_brief_messages;
create policy wios_ceobrief_all on public.wios_ceo_brief_messages
  for all using (owner_id = auth.uid() and public.wios_is_admin())
  with check (owner_id = auth.uid() and public.wios_is_admin());

drop policy if exists wios_ask_all on public.wios_ask_messages;
create policy wios_ask_all on public.wios_ask_messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Only admins can create or see directives from the client. The coaching function reads them
-- with the service key (which bypasses RLS), so the coached person never sees them.
drop policy if exists wios_directive_admin on public.wios_coach_directives;
create policy wios_directive_admin on public.wios_coach_directives
  for all using (public.wios_is_admin()) with check (public.wios_is_admin());

-- retire the old helper name if an earlier install created it
drop function if exists public.wios_is_ceo();

-- ============================================================
-- SEED (method A): create the 5 founder accounts AND their WIOS
-- profiles in one run. Shared password: Djrmffl202!
--
-- This block creates real Supabase Auth accounts, so it needs the
-- pgcrypto extension (bundled with Supabase). It is safe to re-run:
-- accounts that already exist are skipped, profiles are refreshed.
--
-- Sign-in ID is the part before the @ (john.kim, sonya.lee, ...).
-- Everyone added later goes through the app: Settings > Members.
-- ============================================================
create extension if not exists pgcrypto;

do $$
declare
  r record;
  uid uuid;
begin
  for r in
    select * from (values
      ('john.kim@uglydonutsncorndogs.com',    'John Kim',    'CEO', true),
      ('sonya.lee@uglydonutsncorndogs.com',   'Sonya Lee',   'CBO', false),
      ('deborah.lee@uglydonutsncorndogs.com', 'Deborah Lee', 'CMO', false),
      ('jiwoon.lee@uglydonutsncorndogs.com',  'Jiwoon Lee',  'COO', false),
      ('joseph.lee@uglydonutsncorndogs.com',  'Joseph Lee',  'CPO', false)
    ) as t(email, name, role, is_admin)
  loop
    -- reuse the account if this email already exists, otherwise make one
    select id into uid from auth.users where lower(email) = lower(r.email) limit 1;

    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email,
        encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, email_change,
        email_change_token_new, email_change_token_current,
        phone_change, phone_change_token, reauthentication_token,
        created_at, updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', lower(r.email),
        crypt('Djrmffl202!', gen_salt('bf')), now(),
        jsonb_build_object('provider','email','providers', array['email']),
        jsonb_build_object('name', r.name),
        '', '', '',
        '', '',
        '', '', '',
        now(), now()
      );

      -- identity row so email/password sign-in works
      insert into auth.identities (
        provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at
      ) values (
        uid::text, uid,
        jsonb_build_object('sub', uid::text, 'email', lower(r.email), 'email_verified', true),
        'email', now(), now(), now()
      );
    end if;

    -- link (or refresh) the WIOS profile
    insert into public.wios_profiles (id, name, role, is_admin, active)
    values (uid, r.name, r.role, r.is_admin, true)
    on conflict (id) do update
      set name = excluded.name, role = excluded.role,
          is_admin = excluded.is_admin, active = true;
  end loop;
end $$;

-- Make PostgREST pick up the new function right away
notify pgrst, 'reload schema';

-- Verify (should return 5 rows):
-- select p.name, p.role, p.is_admin, u.email
-- from public.wios_profiles p join auth.users u on u.id = p.id order by p.role;

-- ── surveys (title + questions with 1-4 options, sent to people) ──

create table if not exists public.wios_surveys (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.wios_profiles(id) on delete cascade,
  title text not null,
  questions jsonb not null default '[]'::jsonb,   -- [{id, text, options:[text,...]}]
  urgent boolean not null default false,
  status text not null default 'open',            -- open | done
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists wios_surveys_idx on public.wios_surveys(creator_id, status);

create table if not exists public.wios_survey_targets (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.wios_surveys(id) on delete cascade,
  user_id uuid not null references public.wios_profiles(id) on delete cascade,
  status text not null default 'pending',         -- pending | answered
  answers jsonb,                                  -- {question_id: option_index}
  answered_at timestamptz,
  unique(survey_id, user_id)
);
create index if not exists wios_sv_targets_idx on public.wios_survey_targets(user_id, status);

alter table public.wios_surveys enable row level security;
alter table public.wios_survey_targets enable row level security;

create or replace function public.wios_is_survey_target(sid uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wios_survey_targets t
                  where t.survey_id = sid and t.user_id = auth.uid()); $$;

create or replace function public.wios_is_survey_creator(sid uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wios_surveys s
                  where s.id = sid and s.creator_id = auth.uid()); $$;

revoke all on function public.wios_is_survey_target(uuid) from public;
revoke all on function public.wios_is_survey_creator(uuid) from public;
grant execute on function public.wios_is_survey_target(uuid) to authenticated;
grant execute on function public.wios_is_survey_creator(uuid) to authenticated;

-- surveys: creator + admins + targeted people can read; creator manages
drop policy if exists wios_surveys_select on public.wios_surveys;
create policy wios_surveys_select on public.wios_surveys for select using (
  creator_id = auth.uid() or public.wios_is_admin()
  or public.wios_is_survey_target(id));
drop policy if exists wios_surveys_insert on public.wios_surveys;
create policy wios_surveys_insert on public.wios_surveys for insert with check (creator_id = auth.uid());
drop policy if exists wios_surveys_update on public.wios_surveys;
create policy wios_surveys_update on public.wios_surveys for update using (creator_id = auth.uid());
drop policy if exists wios_surveys_delete on public.wios_surveys;
create policy wios_surveys_delete on public.wios_surveys for delete using (creator_id = auth.uid());

-- targets: each person sees + updates their own row; creator sees + manages all rows
drop policy if exists wios_sv_targets_select on public.wios_survey_targets;
create policy wios_sv_targets_select on public.wios_survey_targets for select using (
  user_id = auth.uid() or public.wios_is_admin()
  or public.wios_is_survey_creator(survey_id));
drop policy if exists wios_sv_targets_insert on public.wios_survey_targets;
create policy wios_sv_targets_insert on public.wios_survey_targets for insert with check (
  public.wios_is_survey_creator(survey_id));
drop policy if exists wios_sv_targets_update on public.wios_survey_targets;
create policy wios_sv_targets_update on public.wios_survey_targets for update using (
  user_id = auth.uid() or public.wios_is_survey_creator(survey_id));
drop policy if exists wios_sv_targets_delete on public.wios_survey_targets;
create policy wios_sv_targets_delete on public.wios_survey_targets for delete using (
  public.wios_is_survey_creator(survey_id));
