-- 05_wios_surveys.sql
-- New Survey feature: a title plus one or more questions, each with 1-4 answer
-- options, sent to one or more people. Each recipient answers once; the creator
-- sees per-option results and closes the survey.
--
-- RLS uses SECURITY DEFINER helpers from the start (same pattern as the coop,
-- role and fixed request tables) so the surveys <-> targets policies can never
-- recurse into each other.
--
-- Safe to run more than once.

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
