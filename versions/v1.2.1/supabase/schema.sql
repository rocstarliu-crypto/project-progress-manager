-- 项目进度管理 V1.2.0：Supabase 多人协作数据库
-- 在 Supabase Dashboard > SQL Editor 中完整执行一次。

create table if not exists public.collaboration_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_id uuid not null references auth.users(id) on delete cascade,
  share_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.collaboration_project_members (
  project_id uuid not null references public.collaboration_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.project_state (
  project_id uuid primary key references public.collaboration_projects(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.collaboration_projects enable row level security;
alter table public.collaboration_project_members enable row level security;
alter table public.project_state enable row level security;

grant select on public.collaboration_projects to authenticated;
grant select on public.collaboration_project_members to authenticated;
grant select on public.project_state to authenticated;

create or replace function public.is_collaboration_member(p_project_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.collaboration_project_members
    where project_id = p_project_id and user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_collaboration_project(p_project_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.collaboration_project_members
    where project_id = p_project_id and user_id = auth.uid() and role in ('owner', 'editor')
  );
$$;

drop policy if exists "members read projects" on public.collaboration_projects;
create policy "members read projects" on public.collaboration_projects
for select to authenticated using (public.is_collaboration_member(id) or owner_id = auth.uid());

drop policy if exists "members read memberships" on public.collaboration_project_members;
create policy "members read memberships" on public.collaboration_project_members
for select to authenticated using (public.is_collaboration_member(project_id));

drop policy if exists "members read state" on public.project_state;
create policy "members read state" on public.project_state
for select to authenticated using (public.is_collaboration_member(project_id));

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
  return v_project;
end;
$$;

create or replace function public.join_collaboration_project(p_share_code text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_project uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select id into v_project from public.collaboration_projects where share_code = upper(trim(p_share_code));
  if v_project is null then raise exception 'SHARE_CODE_NOT_FOUND'; end if;
  insert into public.collaboration_project_members(project_id, user_id, role) values (v_project, v_user, 'editor') on conflict (project_id, user_id) do nothing;
  return v_project;
end;
$$;

create or replace function public.list_collaboration_projects()
returns table (project_id uuid, name text, share_code text, role text, revision bigint, updated_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select p.id, p.name, p.share_code, m.role, s.revision, s.updated_at
  from public.collaboration_project_members m
  join public.collaboration_projects p on p.id = m.project_id
  join public.project_state s on s.project_id = p.id
  where m.user_id = auth.uid()
  order by s.updated_at desc;
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
  return v_revision;
end;
$$;

revoke all on function public.create_collaboration_project(text, jsonb) from public;
revoke all on function public.join_collaboration_project(text) from public;
revoke all on function public.list_collaboration_projects() from public;
revoke all on function public.save_collaboration_project(uuid, bigint, jsonb) from public;
grant execute on function public.create_collaboration_project(text, jsonb) to authenticated;
grant execute on function public.join_collaboration_project(text) to authenticated;
grant execute on function public.list_collaboration_projects() to authenticated;
grant execute on function public.save_collaboration_project(uuid, bigint, jsonb) to authenticated;
grant execute on function public.is_collaboration_member(uuid) to authenticated;
grant execute on function public.can_edit_collaboration_project(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_state'
  ) then
    alter publication supabase_realtime add table public.project_state;
  end if;
end $$;
