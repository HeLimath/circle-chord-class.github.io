-- ============================================================
-- 원의 현 탐구 실시간 학급 버전
-- Supabase SQL Editor에서 이 파일 전체를 한 번 실행하세요.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Tables ----------

create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null default '원과 현 탐구',
  owner_id uuid not null references auth.users(id) on delete cascade,
  phase text not null default 'explore'
    check (phase in ('explore', 'hypothesis', 'verify', 'prove')),
  is_active boolean not null default true,
  published_clusters jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.participants (
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  alias text not null check (char_length(alias) between 1 and 20),
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create table if not exists public.hypotheses (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  participant_id uuid not null references auth.users(id) on delete cascade,
  alias text not null check (char_length(alias) between 1 and 20),
  text text not null check (char_length(text) between 5 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, participant_id)
);

create index if not exists participants_session_idx
  on public.participants(session_id);

create index if not exists hypotheses_session_idx
  on public.hypotheses(session_id);

-- ---------- updated_at trigger ----------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists class_sessions_set_updated_at on public.class_sessions;
create trigger class_sessions_set_updated_at
before update on public.class_sessions
for each row execute function public.set_updated_at();

drop trigger if exists hypotheses_set_updated_at on public.hypotheses;
create trigger hypotheses_set_updated_at
before update on public.hypotheses
for each row execute function public.set_updated_at();

-- ---------- Security helper functions ----------
-- SECURITY DEFINER를 사용하여 RLS 정책 간 재귀를 피합니다.

create or replace function public.owns_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.class_sessions s
    where s.id = p_session_id
      and s.owner_id = auth.uid()
  );
$$;

create or replace function public.is_participant(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.participants p
    where p.session_id = p_session_id
      and p.user_id = auth.uid()
  );
$$;

create or replace function public.session_is_active(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.class_sessions s
    where s.id = p_session_id
      and s.is_active = true
  );
$$;

revoke all on function public.owns_session(uuid) from public;
revoke all on function public.is_participant(uuid) from public;
revoke all on function public.session_is_active(uuid) from public;
grant execute on function public.owns_session(uuid) to authenticated;
grant execute on function public.is_participant(uuid) to authenticated;
grant execute on function public.session_is_active(uuid) to authenticated;

-- ---------- RPC: create class ----------

create or replace function public.create_class_session(p_title text)
returns table (
  id uuid,
  code text,
  title text,
  owner_id uuid,
  phase text,
  is_active boolean,
  published_clusters jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_row public.class_sessions%rowtype;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  loop
    -- 읽기 쉬운 6자리 16진 코드
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (
      select 1 from public.class_sessions s
      where s.code = v_code and s.is_active = true
    );
  end loop;

  insert into public.class_sessions(code, title, owner_id)
  values (
    v_code,
    left(coalesce(nullif(trim(p_title), ''), '원과 현 탐구'), 60),
    v_user
  )
  returning * into v_row;

  return query
  select
    v_row.id, v_row.code, v_row.title, v_row.owner_id,
    v_row.phase, v_row.is_active, v_row.published_clusters,
    v_row.created_at, v_row.updated_at;
end;
$$;

revoke all on function public.create_class_session(text) from public;
grant execute on function public.create_class_session(text) to authenticated;

-- ---------- RPC: join class ----------

create or replace function public.join_class_session(p_code text, p_alias text)
returns table (
  id uuid,
  code text,
  title text,
  owner_id uuid,
  phase text,
  is_active boolean,
  published_clusters jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row public.class_sessions%rowtype;
  v_alias text := left(trim(coalesce(p_alias, '')), 20);
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  if char_length(v_alias) < 1 then
    raise exception 'Alias is required';
  end if;

  select *
  into v_row
  from public.class_sessions s
  where s.code = upper(trim(p_code))
    and s.is_active = true
  limit 1;

  if v_row.id is null then
    return;
  end if;

  insert into public.participants(session_id, user_id, alias)
  values (v_row.id, v_user, v_alias)
  on conflict (session_id, user_id)
  do update set alias = excluded.alias;

  return query
  select
    v_row.id, v_row.code, v_row.title, v_row.owner_id,
    v_row.phase, v_row.is_active, v_row.published_clusters,
    v_row.created_at, v_row.updated_at;
end;
$$;

revoke all on function public.join_class_session(text, text) from public;
grant execute on function public.join_class_session(text, text) to authenticated;

-- ---------- RLS ----------

alter table public.class_sessions enable row level security;
alter table public.participants enable row level security;
alter table public.hypotheses enable row level security;

drop policy if exists "session members can select" on public.class_sessions;
create policy "session members can select"
on public.class_sessions
for select
to authenticated
using (
  auth.uid() is not null
  and (
    owner_id = auth.uid()
    or public.is_participant(id)
  )
);

drop policy if exists "owner can update session" on public.class_sessions;
create policy "owner can update session"
on public.class_sessions
for update
to authenticated
using (auth.uid() is not null and owner_id = auth.uid())
with check (auth.uid() is not null and owner_id = auth.uid());

drop policy if exists "participants visible to self or owner" on public.participants;
create policy "participants visible to self or owner"
on public.participants
for select
to authenticated
using (
  auth.uid() is not null
  and (
    user_id = auth.uid()
    or public.owns_session(session_id)
  )
);

drop policy if exists "hypotheses visible to self or owner" on public.hypotheses;
create policy "hypotheses visible to self or owner"
on public.hypotheses
for select
to authenticated
using (
  auth.uid() is not null
  and (
    participant_id = auth.uid()
    or public.owns_session(session_id)
  )
);

drop policy if exists "student can insert own hypothesis" on public.hypotheses;
create policy "student can insert own hypothesis"
on public.hypotheses
for insert
to authenticated
with check (
  auth.uid() is not null
  and participant_id = auth.uid()
  and public.is_participant(session_id)
  and public.session_is_active(session_id)
);

drop policy if exists "student can update own hypothesis" on public.hypotheses;
create policy "student can update own hypothesis"
on public.hypotheses
for update
to authenticated
using (
  auth.uid() is not null
  and participant_id = auth.uid()
  and public.is_participant(session_id)
)
with check (
  auth.uid() is not null
  and participant_id = auth.uid()
  and public.is_participant(session_id)
  and public.session_is_active(session_id)
);

drop policy if exists "student or owner can delete hypothesis" on public.hypotheses;
create policy "student or owner can delete hypothesis"
on public.hypotheses
for delete
to authenticated
using (
  auth.uid() is not null
  and (
    participant_id = auth.uid()
    or public.owns_session(session_id)
  )
);

-- ---------- Privileges ----------

revoke all on public.class_sessions from anon, authenticated;
revoke all on public.participants from anon, authenticated;
revoke all on public.hypotheses from anon, authenticated;

grant select, update on public.class_sessions to authenticated;
grant select on public.participants to authenticated;
grant select, insert, update, delete on public.hypotheses to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ---------- Realtime ----------
-- 이미 publication에 들어가 있는 경우를 고려하여 예외를 무시합니다.

do $$
begin
  alter publication supabase_realtime add table public.class_sessions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.participants;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.hypotheses;
exception when duplicate_object then null;
end $$;
