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
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists wios_tasks_owner_idx on public.wios_tasks(owner_id, status);
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

-- ── 4. Goals ────────────────────────────────────────────────
create table if not exists public.wios_goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wios_profiles(id) on delete cascade,
  period_type text not null check (period_type in ('week','month','semester','year')),
  period_key text not null,       -- week: monday date, month: YYYY-MM, semester: YYYY-H1, year: YYYY
  title text not null,
  status text not null default 'open',
  kept_from text,                 -- previous period_key if the goal was kept
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists wios_goals_idx on public.wios_goals(owner_id, period_type, period_key);
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

drop policy if exists wios_msg_select on public.wios_coop_messages;
create policy wios_msg_select on public.wios_coop_messages
  for select using (public.wios_is_coop_member(coop_id) or public.wios_is_admin());
drop policy if exists wios_msg_insert on public.wios_coop_messages;
create policy wios_msg_insert on public.wios_coop_messages
  for insert with check (user_id = auth.uid() and public.wios_is_coop_member(coop_id));

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
