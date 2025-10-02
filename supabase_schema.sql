-- Supabase SQL: run in SQL editor
create table if not exists tickets (
  id bigserial primary key,
  created_at timestamptz default now(),
  asset_type text check (asset_type in ('truck','trailer','unspecified')) not null default 'unspecified',
  asset_id text,
  problem text,
  plan text,
  eta timestamptz,
  status text not null default 'new',
  owner_user_id text,
  snooze_until timestamptz,
  last_reminded_at timestamptz,
  needs_photos boolean not null default false,
  closed_at timestamptz,
  closed_by_user_id text
);

create table if not exists photos (
  id bigserial primary key,
  ticket_id bigint references tickets(id) on delete cascade,
  file_id text not null,
  is_final boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists events (
  id bigserial primary key,
  ticket_id bigint references tickets(id) on delete cascade,
  at timestamptz default now(),
  by_user_id text,
  action text not null,
  payload jsonb
);

create table if not exists sessions (
  user_id text primary key,
  state text,
  data jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);
