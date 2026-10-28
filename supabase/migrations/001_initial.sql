-- SOLVER baseline schema. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text not null default 'Player',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format check (username is null or username ~ '^[A-Za-z0-9_]{3,24}$')
);

create table if not exists public.connection_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint no_self_request check (sender_id <> receiver_id),
  constraint unique_connection_request unique (sender_id, receiver_id)
);
create index if not exists connection_requests_receiver_status_idx on public.connection_requests(receiver_id, status);

create table if not exists public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  host_id uuid references public.profiles(id) on delete set null,
  mode text not null check (mode in ('duo_free','duo_race','trio_free','trio_race')),
  difficulty text not null default 'easy' check (difficulty in ('easy','medium','hard')),
  status text not null default 'lobby' check (status in ('lobby','active','finished','abandoned')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  mode text not null check (mode in ('duo_free','duo_race','trio_free','trio_race')),
  difficulty text not null check (difficulty in ('easy','medium','hard')),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms integer not null check (duration_ms >= 0 and duration_ms <= 60000),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists matches_finished_at_idx on public.matches(finished_at desc);

create table if not exists public.match_participants (
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null,
  score integer not null default 0 check (score >= 0),
  correct integer not null default 0 check (correct >= 0),
  attempts integer not null default 0 check (attempts >= correct),
  accuracy numeric(5,2) not null default 0 check (accuracy >= 0 and accuracy <= 100),
  rank integer not null check (rank > 0),
  primary key (match_id, player_id)
);
create index if not exists match_participants_player_idx on public.match_participants(player_id, match_id);

create table if not exists public.question_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  question_id text not null,
  player_id uuid not null,
  expression text not null,
  expected_answer text not null,
  created_at timestamptz not null default now(),
  unique (match_id, question_id, player_id)
);

create table if not exists public.answer_attempts (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null,
  question_id text not null,
  submitted_answer text not null,
  is_correct boolean not null,
  response_ms integer not null check (response_ms >= 0),
  created_at timestamptz not null default now()
);
create index if not exists answer_attempts_match_player_idx on public.answer_attempts(match_id, player_id, created_at);

create table if not exists public.scoring_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null,
  question_id text not null,
  points integer not null check (points >= 0),
  created_at timestamptz not null default now(),
  unique (match_id, question_id)
);

alter table public.profiles enable row level security;
alter table public.connection_requests enable row level security;
alter table public.game_rooms enable row level security;
alter table public.matches enable row level security;
alter table public.match_participants enable row level security;
alter table public.question_events enable row level security;
alter table public.answer_attempts enable row level security;
alter table public.scoring_events enable row level security;

drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable" on public.profiles for select using (true);
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile" on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "participants can read own match rows" on public.match_participants;
create policy "participants can read own match rows" on public.match_participants for select using (auth.uid() = player_id);
drop policy if exists "participants can read own matches" on public.matches;
create policy "participants can read own matches" on public.matches for select using (
  exists (select 1 from public.match_participants mp where mp.match_id = matches.id and mp.player_id = auth.uid())
);
drop policy if exists "users read requests involving them" on public.connection_requests;
create policy "users read requests involving them" on public.connection_requests for select using (auth.uid() = sender_id or auth.uid() = receiver_id);
drop policy if exists "users create own requests" on public.connection_requests;
create policy "users create own requests" on public.connection_requests for insert with check (auth.uid() = sender_id);
drop policy if exists "users update requests involving them" on public.connection_requests;
create policy "users update requests involving them" on public.connection_requests for update using (auth.uid() = sender_id or auth.uid() = receiver_id) with check (auth.uid() = sender_id or auth.uid() = receiver_id);

-- No client insert/update policies for matches, room state, answers, or scoring.
-- Trusted writes must be made by a protected server-side credential or a narrowly scoped RPC.
