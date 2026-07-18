-- 04_wios_request_rls_fix.sql
-- Fixes: "infinite recursion detected in policy for relation wios_requests"
--
-- Cause: the select policy on wios_requests checked membership with a plain
-- subquery on wios_request_targets, and the policies on wios_request_targets
-- checked creatorship with a plain subquery on wios_requests. Each subquery
-- re-applies the other table's RLS policy, so Postgres detects a loop.
--
-- Fix: the same pattern the coop and role tables already use. Two SECURITY
-- DEFINER helper functions read the other table without RLS, breaking the loop.
-- Access rules are unchanged: creator and admins plus the targeted people can
-- read a request; targets update their own row; only the creator manages rows.
--
-- Safe to run more than once.

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

-- wios_requests
drop policy if exists wios_requests_select on public.wios_requests;
create policy wios_requests_select on public.wios_requests for select using (
  creator_id = auth.uid() or public.wios_is_admin()
  or public.wios_is_request_target(id));

-- (insert / update / delete on wios_requests only reference creator_id, no change needed,
--  but recreate them so this file alone restores the full policy set.)
drop policy if exists wios_requests_insert on public.wios_requests;
create policy wios_requests_insert on public.wios_requests for insert with check (creator_id = auth.uid());
drop policy if exists wios_requests_update on public.wios_requests;
create policy wios_requests_update on public.wios_requests for update using (creator_id = auth.uid());
drop policy if exists wios_requests_delete on public.wios_requests;
create policy wios_requests_delete on public.wios_requests for delete using (creator_id = auth.uid());

-- wios_request_targets
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
