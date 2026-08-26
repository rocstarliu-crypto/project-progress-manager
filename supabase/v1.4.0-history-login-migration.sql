-- 项目进度管理 V1.4.0：历史版本 + 登录历史升级脚本
-- 适用于已经执行过旧版 schema.sql 的 Supabase 项目。
-- 在 Supabase Dashboard > SQL Editor 中完整执行一次。

create table if not exists public.project_state_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.collaboration_projects(id) on delete cascade,
  revision bigint not null,
  data jsonb not null,
  saved_by uuid references auth.users(id) on delete set null,
  saved_at timestamptz not null default now(),
  action text not null default 'save' check (action in ('initial', 'save', 'restore')),
  unique (project_id, revision)
);

create index if not exists project_state_history_project_time_idx
on public.project_state_history(project_id, saved_at desc);

create table if not exists public.user_login_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  logged_in_at timestamptz not null default now(),
  region text not null default '未知区域'
);

create index if not exists user_login_history_user_time_idx
on public.user_login_history(user_id, logged_in_at desc);

alter table public.project_state_history enable row level security;
alter table public.user_login_history enable row level security;

grant select on public.project_state_history to authenticated;
grant select on public.user_login_history to authenticated;

drop policy if exists "members read project history" on public.project_state_history;
create policy "members read project history" on public.project_state_history
for select to authenticated using (public.is_collaboration_member(project_id));

drop policy if exists "users read own login history" on public.user_login_history;
create policy "users read own login history" on public.user_login_history
for select to authenticated using (user_id = auth.uid());

create or replace function public.create_collaboration_project(p_name text, p_initial_data jsonb)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_project uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_name is null or char_length(trim(p_name)) = 0 or char_length(trim(p_name)) > 60 then raise exception 'INVALID_PROJECT_NAME'; end if;
  insert into public.collaboration_projects(name, owner_id) values (trim(p_name), v_user) returning id into v_project;
  insert into public.collaboration_project_members(project_id, user_id, role) values (v_project, v_user, 'owner');
  insert into public.project_state(project_id, data, revision, updated_by) values (v_project, coalesce(p_initial_data, '{}'::jsonb), 1, v_user);
  insert into public.project_state_history(project_id, revision, data, saved_by, action)
  values (v_project, 1, coalesce(p_initial_data, '{}'::jsonb), v_user, 'initial');
  return v_project;
end;
$$;

create or replace function public.save_collaboration_project(p_project_id uuid, p_expected_revision bigint, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_revision bigint;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not public.can_edit_collaboration_project(p_project_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'INVALID_PROJECT_DATA'; end if;
  update public.project_state
    set data = p_data, revision = revision + 1, updated_by = v_user, updated_at = now()
    where project_id = p_project_id and revision = p_expected_revision
    returning revision into v_revision;
  if v_revision is null then raise exception 'CLOUD_VERSION_CONFLICT'; end if;
  update public.collaboration_projects set updated_at = now() where id = p_project_id;
  insert into public.project_state_history(project_id, revision, data, saved_by, action)
  values (p_project_id, v_revision, p_data, v_user, 'save')
  on conflict (project_id, revision) do nothing;
  delete from public.project_state_history
  where id in (
    select id from public.project_state_history
    where project_id = p_project_id
    order by saved_at desc
    offset 200
  );
  return v_revision;
end;
$$;

create or replace function public.list_project_history(p_project_id uuid, p_limit integer default 50)
returns table (history_id uuid, revision bigint, saved_at timestamptz, saved_by uuid, action text)
language sql stable security definer set search_path = public
as $$
  select h.id, h.revision, h.saved_at, h.saved_by, h.action
  from public.project_state_history h
  where h.project_id = p_project_id
    and public.is_collaboration_member(p_project_id)
  order by h.saved_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

create or replace function public.restore_collaboration_project(p_project_id uuid, p_history_id uuid, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_data jsonb;
  v_revision bigint;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not public.can_edit_collaboration_project(p_project_id) then raise exception 'NOT_AUTHORIZED'; end if;
  select data into v_data from public.project_state_history where id = p_history_id and project_id = p_project_id;
  if v_data is null then raise exception 'HISTORY_NOT_FOUND'; end if;
  update public.project_state
    set data = v_data, revision = revision + 1, updated_by = v_user, updated_at = now()
    where project_id = p_project_id and revision = p_expected_revision
    returning revision into v_revision;
  if v_revision is null then raise exception 'CLOUD_VERSION_CONFLICT'; end if;
  update public.collaboration_projects set updated_at = now() where id = p_project_id;
  insert into public.project_state_history(project_id, revision, data, saved_by, action)
  values (p_project_id, v_revision, v_data, v_user, 'restore')
  on conflict (project_id, revision) do nothing;
  return v_revision;
end;
$$;

create or replace function public.record_login_history(p_region text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  insert into public.user_login_history(user_id, region)
  values (v_user, left(coalesce(nullif(trim(p_region), ''), '未知区域'), 120));
  delete from public.user_login_history
  where id in (
    select id from public.user_login_history
    where user_id = v_user
    order by logged_in_at desc
    offset 100
  );
end;
$$;

create or replace function public.list_login_history(p_limit integer default 30)
returns table (logged_in_at timestamptz, region text)
language sql stable security definer set search_path = public
as $$
  select h.logged_in_at, h.region
  from public.user_login_history h
  where h.user_id = auth.uid()
  order by h.logged_in_at desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

insert into public.project_state_history(project_id, revision, data, saved_by, saved_at, action)
select project_id, revision, data, updated_by, updated_at, 'initial'
from public.project_state
on conflict (project_id, revision) do nothing;

revoke all on function public.list_project_history(uuid, integer) from public;
revoke all on function public.restore_collaboration_project(uuid, uuid, bigint) from public;
revoke all on function public.record_login_history(text) from public;
revoke all on function public.list_login_history(integer) from public;

grant execute on function public.create_collaboration_project(text, jsonb) to authenticated;
grant execute on function public.save_collaboration_project(uuid, bigint, jsonb) to authenticated;
grant execute on function public.list_project_history(uuid, integer) to authenticated;
grant execute on function public.restore_collaboration_project(uuid, uuid, bigint) to authenticated;
grant execute on function public.record_login_history(text) to authenticated;
grant execute on function public.list_login_history(integer) to authenticated;
