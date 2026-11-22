-- Bill Splitter: token-gated sync, no accounts.
-- Security model: tables are LOCKED (RLS on, deny-all policies, no grants). The only way in is the
-- SECURITY DEFINER RPCs below, each of which authenticates by a 128-bit group token. Only the
-- SHA-256 of a token is stored, so a database leak does not leak working links.

create table if not exists public.sb_groups (
  id          text primary key check (char_length(id) <= 80),
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.sb_links (
  id          uuid primary key default gen_random_uuid(),
  group_id    text not null references public.sb_groups(id) on delete cascade,
  token_hash  bytea not null unique,
  role        text not null check (role in ('owner','editor','viewer')),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists sb_links_group on public.sb_links(group_id);

create table if not exists public.sb_records (
  group_id           text not null references public.sb_groups(id) on delete cascade,
  kind               text not null check (kind in ('group','member','expense','settlement','recurring','activity')),
  id                 text not null check (char_length(id) <= 80),
  data               jsonb not null,
  field_times        jsonb not null,
  server_updated_at  timestamptz not null default clock_timestamp(),
  primary key (group_id, kind, id)
);
create index if not exists sb_records_cursor on public.sb_records(group_id, server_updated_at);

create table if not exists public.sb_rate_limits (
  key text not null, window_start timestamptz not null, hits int not null default 0,
  primary key (key, window_start)
);

-- ---- lock everything down ---------------------------------------------------------------
alter table public.sb_groups      enable row level security;
alter table public.sb_links       enable row level security;
alter table public.sb_records     enable row level security;
alter table public.sb_rate_limits enable row level security;
create policy deny_all on public.sb_groups      for all using (false) with check (false);
create policy deny_all on public.sb_links       for all using (false) with check (false);
create policy deny_all on public.sb_records     for all using (false) with check (false);
create policy deny_all on public.sb_rate_limits for all using (false) with check (false);
revoke all on public.sb_groups, public.sb_links, public.sb_records, public.sb_rate_limits from anon, authenticated, public;

-- ---- helpers (not callable from the API) -------------------------------------------------
create or replace function public._sb_rate(p_key text, p_max int, p_secs int) returns void
language plpgsql security definer set search_path = public as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_secs) * p_secs); n int;
begin
  insert into sb_rate_limits(key, window_start, hits) values (p_key, w, 1)
  on conflict (key, window_start) do update set hits = sb_rate_limits.hits + 1
  returning hits into n;
  if n > p_max then raise exception 'rate_limited'; end if;
  if random() < 0.01 then delete from sb_rate_limits where window_start < now() - interval '2 hours'; end if;
end $$;

create or replace function public._sb_ip() returns text
language sql stable as $$
  select split_part(coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', 'unknown'), ',', 1)
$$;

create or replace function public._sb_auth(p_token text)
returns table (group_id text, role text, link_id uuid, archived boolean)
language plpgsql security definer set search_path = public as $$
declare l sb_links; g sb_groups;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then raise exception 'invalid_token'; end if;
  select * into l from sb_links where token_hash = sha256(convert_to(p_token, 'UTF8'));
  if not found then raise exception 'invalid_token'; end if;
  if l.revoked_at is not null then raise exception 'token_revoked'; end if;
  if l.expires_at is not null and l.expires_at < now() then raise exception 'token_expired'; end if;
  select * into g from sb_groups where id = l.group_id;
  return query select l.group_id, l.role, l.id, g.archived;
end $$;

-- ---- public RPCs -------------------------------------------------------------------------
create or replace function public.sb_create_group(p_group_id text, p_token text, p_group jsonb, p_times jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _sb_rate('create_group:' || _sb_ip(), 10, 3600);
  if p_token !~ '^[0-9a-f]{32}$' or char_length(p_group_id) not between 8 and 80 then raise exception 'bad_request'; end if;
  if length(p_group::text) > 65536 then raise exception 'too_large'; end if;
  insert into sb_groups(id) values (p_group_id);
  insert into sb_links(group_id, token_hash, role) values (p_group_id, sha256(convert_to(p_token, 'UTF8')), 'owner');
  insert into sb_records(group_id, kind, id, data, field_times) values (p_group_id, 'group', p_group_id, p_group, p_times);
end $$;

create or replace function public.sb_redeem(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  perform _sb_rate('redeem:' || _sb_ip(), 60, 60);
  select * into a from _sb_auth(p_token);
  return jsonb_build_object('group_id', a.group_id, 'role', a.role, 'archived', a.archived);
end $$;

create or replace function public.sb_pull(p_token text, p_since text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; since timestamptz; rows jsonb; cur timestamptz; cnt int;
begin
  select * into a from _sb_auth(p_token);
  perform _sb_rate('pull:' || a.link_id, 240, 60);
  since := case when coalesce(p_since, '') = '' then 'epoch'::timestamptz else p_since::timestamptz end;
  with r as (
    select kind, id, data, field_times, server_updated_at from sb_records
    where group_id = a.group_id and server_updated_at > since
    order by server_updated_at asc limit 500
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'data', data, 'fieldTimes', field_times) order by server_updated_at), '[]'::jsonb),
         max(server_updated_at), count(*)
  into rows, cur, cnt from r;
  return jsonb_build_object(
    'role', a.role, 'archived', a.archived, 'records', rows,
    'cursor', to_char(coalesce(cur, since) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'more', cnt = 500);
end $$;

create or replace function public.sb_push(p_token text, p_records jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; r jsonb; ex sb_records; nd jsonb; nf jsonb; k text; n int := 0; v_kind text; rid text; found_row boolean;
begin
  select * into a from _sb_auth(p_token);
  if a.role = 'viewer' then raise exception 'forbidden'; end if;
  if a.archived and a.role <> 'owner' then raise exception 'group_archived'; end if;
  perform _sb_rate('push:' || a.link_id, 120, 60);
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 100 then raise exception 'bad_request'; end if;
  perform pg_advisory_xact_lock(hashtext(a.group_id));      -- serialise writers per group

  for r in select * from jsonb_array_elements(p_records) loop
    v_kind := r->>'kind'; rid := r->>'id';
    if length(r::text) > 65536 then raise exception 'too_large'; end if;
    if v_kind is null or v_kind not in ('group','member','expense','settlement','recurring','activity')
       or rid is null or char_length(rid) > 80
       or jsonb_typeof(r->'data') <> 'object' or jsonb_typeof(r->'fieldTimes') <> 'object' then
      raise exception 'bad_request';
    end if;
    if v_kind = 'group' then
      if a.role <> 'owner' or rid <> a.group_id then continue; end if;      -- only owners edit group settings
    elsif (r->'data'->>'groupId') is distinct from a.group_id then
      raise exception 'bad_request';                                         -- cannot write into another group
    end if;

    select * into ex from sb_records where group_id = a.group_id and kind = v_kind and id = rid;
    found_row := found;
    if not found_row then
      insert into sb_records(group_id, kind, id, data, field_times) values (a.group_id, v_kind, rid, r->'data', r->'fieldTimes');
    else
      -- per-field last-write-wins; timestamps are "<ISO>~<device>" so byte-order compare == time order
      nd := ex.data; nf := ex.field_times;
      for k in select jsonb_object_keys(r->'fieldTimes') loop
        if (coalesce(nf->>k, '') collate "C") < ((r->'fieldTimes'->>k) collate "C") then
          nd := case when (r->'data') ? k then jsonb_set(nd, array[k], r->'data'->k, true) else nd - k end;
          nf := jsonb_set(nf, array[k], r->'fieldTimes'->k, true);
        end if;
      end loop;
      -- idempotent: a retried identical push changes nothing and does not bump the cursor
      if nd is distinct from ex.data or nf is distinct from ex.field_times then
        update sb_records set data = nd, field_times = nf, server_updated_at = clock_timestamp()
        where group_id = a.group_id and kind = v_kind and id = rid;
      end if;
    end if;
    if v_kind = 'group' and a.role = 'owner' then
      update sb_groups set archived = coalesce((select (data->>'archived')::boolean from sb_records where group_id = a.group_id and kind = 'group' and id = a.group_id), false)
      where id = a.group_id;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'applied', n);
end $$;

create or replace function public.sb_create_link(p_owner_token text, p_new_token text, p_role text, p_hours int default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare a record; lid uuid;
begin
  select * into a from _sb_auth(p_owner_token);
  if a.role <> 'owner' then raise exception 'forbidden'; end if;
  perform _sb_rate('link:' || a.link_id, 30, 3600);
  if p_new_token !~ '^[0-9a-f]{32}$' or p_role not in ('owner','editor','viewer') then raise exception 'bad_request'; end if;
  insert into sb_links(group_id, token_hash, role, expires_at)
  values (a.group_id, sha256(convert_to(p_new_token, 'UTF8')), p_role, case when p_hours is null then null else now() + make_interval(hours => p_hours) end)
  returning id into lid;
  return lid;
end $$;

create or replace function public.sb_revoke_link(p_owner_token text, p_link_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from _sb_auth(p_owner_token);
  if a.role <> 'owner' then raise exception 'forbidden'; end if;
  update sb_links set revoked_at = now() where id = p_link_id and group_id = a.group_id and revoked_at is null;
end $$;

create or replace function public.sb_list_links(p_owner_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from _sb_auth(p_owner_token);
  if a.role <> 'owner' then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'role', role, 'createdAt', created_at, 'expiresAt', expires_at, 'revokedAt', revoked_at, 'current', id = a.link_id) order by created_at)
                   from sb_links where group_id = a.group_id), '[]'::jsonb);
end $$;

create or replace function public.sb_delete_group(p_owner_token text) returns void
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from _sb_auth(p_owner_token);
  if a.role <> 'owner' then raise exception 'forbidden'; end if;
  delete from sb_groups where id = a.group_id;   -- cascades to links + records
end $$;

-- ---- expose ONLY the public RPCs to the anon key -------------------------------------------
revoke all on function public._sb_rate(text,int,int), public._sb_ip(), public._sb_auth(text) from public, anon, authenticated;
revoke all on function public.sb_create_group(text,text,jsonb,jsonb), public.sb_redeem(text), public.sb_pull(text,text),
  public.sb_push(text,jsonb), public.sb_create_link(text,text,text,int), public.sb_revoke_link(text,uuid),
  public.sb_list_links(text), public.sb_delete_group(text) from public;
grant execute on function public.sb_create_group(text,text,jsonb,jsonb), public.sb_redeem(text), public.sb_pull(text,text),
  public.sb_push(text,jsonb), public.sb_create_link(text,text,text,int), public.sb_revoke_link(text,uuid),
  public.sb_list_links(text), public.sb_delete_group(text) to anon, authenticated;
