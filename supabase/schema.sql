-- Road to 75 -- play logging schema.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- Design notes
-- ------------
-- The browser writes directly to Postgres with the publishable key, so the
-- database has to defend itself: the key is in the JS bundle and anyone can
-- read it. Two things make that safe.
--
-- 1. The anon role has NO direct access to either table -- not insert, not
--    select. Everything goes through log_play(), a SECURITY DEFINER function
--    that is the only writable surface. A caller can do exactly one thing:
--    submit a well-formed play.
-- 2. Every field is range-checked, in the function and again as table
--    constraints, so a hand-crafted request cannot store nonsense.
--
-- Nothing can be read back through the API at all -- there is no select
-- policy and no select grant. Read your data from the SQL editor or with a
-- secret key server-side.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tables

create table if not exists public.plays (
  id             uuid primary key,
  client_id      uuid not null,
  -- 'started' rows come from the draft beginning; they become 'finished' when
  -- the season ends. Abandoned drafts stay 'started', which is the only way to
  -- measure drop-off -- without them the data is survivorship-biased.
  status         text not null default 'started'
                   check (status in ('started', 'finished')),
  league         text not null check (league in ('mls', 'nwsl')),
  mode           text not null check (mode in ('free', 'daily')),
  daily_date     date,
  difficulty     text check (difficulty in ('easy', 'normal', 'hard', 'max')),
  formation      text check (length(formation) <= 12),
  conference     text check (conference in ('East', 'West', 'League')),
  -- The content hash of the pool file this play was drafted from. Board sets
  -- are only reproducible against the same data, so a play is uninterpretable
  -- without it.
  data_version   text check (length(data_version) <= 32),
  seed           bigint,

  started_at     timestamptz not null default now(),
  finished_at    timestamptz,

  coach_name     text check (length(coach_name) <= 80),
  points         int  check (points between 0 and 102),
  wins           int  check (wins between 0 and 34),
  draws          int  check (draws between 0 and 34),
  losses         int  check (losses between 0 and 34),
  made_playoffs  boolean,
  playoff_seed   int  check (playoff_seed between 1 and 16),
  won_cup        boolean,
  won            boolean,
  squad_strength real check (squad_strength between -200 and 200),
  efficiency_pct real check (efficiency_pct between 0 and 100),
  percentile     real check (percentile between 0 and 100),
  rerolls_used   int  check (rerolls_used between 0 and 10),
  achievements   text[],

  created_at     timestamptz not null default now(),

  -- A daily play must say which day; a free play must not claim one.
  constraint daily_has_date check (
    (mode = 'daily' and daily_date is not null)
    or (mode = 'free' and daily_date is null)
  )
);

create table if not exists public.picks (
  play_id          uuid not null references public.plays(id) on delete cascade,
  pick_no          int  not null check (pick_no between 1 and 14),
  player_id        text not null check (length(player_id) <= 32),
  player_name      text check (length(player_name) <= 80),
  player_season    text check (length(player_season) <= 8),
  team_id          text check (length(team_id) <= 32),
  team_abbr        text check (length(team_abbr) <= 8),
  position         text check (length(position) <= 8),
  slot             text check (length(slot) <= 8),
  starter          boolean,
  score            real check (score between -50 and 50),
  is_dp            boolean,
  salary           int check (salary >= 0),
  -- What the best legal pick on that board was worth, and what this one was.
  -- The gap is the interesting column: it is the decision, isolated.
  board_best_value real,
  taken_value      real,
  primary key (play_id, pick_no)
);

create index if not exists plays_daily_idx   on public.plays (league, daily_date)
  where mode = 'daily';
create index if not exists plays_created_idx on public.plays (created_at desc);
create index if not exists plays_client_idx  on public.plays (client_id);

-- ---------------------------------------------------------------- lockdown

alter table public.plays enable row level security;
alter table public.picks enable row level security;

-- No policies are defined on purpose. RLS with zero policies denies
-- everything, and the SECURITY DEFINER function below is the only way in.
revoke all on public.plays from anon, authenticated;
revoke all on public.picks from anon, authenticated;

-- ---------------------------------------------------------------- write path

create or replace function public.log_play(payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid := (payload->>'play_id')::uuid;
  v_client  uuid := (payload->>'client_id')::uuid;
  v_status  text := coalesce(payload->>'status', 'started');
  v_pick    jsonb;
  v_count   int;
begin
  if v_id is null or v_client is null then
    raise exception 'play_id and client_id are required';
  end if;

  -- At most 14 picks, and only on a finished play.
  v_count := coalesce(jsonb_array_length(payload->'picks'), 0);
  if v_count > 14 then
    raise exception 'too many picks: %', v_count;
  end if;

  insert into public.plays as p (
    id, client_id, status, league, mode, daily_date, difficulty, formation,
    conference, data_version, seed, started_at, finished_at, coach_name,
    points, wins, draws, losses, made_playoffs, playoff_seed, won_cup, won,
    squad_strength, efficiency_pct, percentile, rerolls_used, achievements
  ) values (
    v_id,
    v_client,
    v_status,
    payload->>'league',
    payload->>'mode',
    (payload->>'daily_date')::date,
    payload->>'difficulty',
    payload->>'formation',
    payload->>'conference',
    payload->>'data_version',
    (payload->>'seed')::bigint,
    coalesce((payload->>'started_at')::timestamptz, now()),
    (payload->>'finished_at')::timestamptz,
    payload->>'coach_name',
    (payload->>'points')::int,
    (payload->>'wins')::int,
    (payload->>'draws')::int,
    (payload->>'losses')::int,
    (payload->>'made_playoffs')::boolean,
    (payload->>'playoff_seed')::int,
    (payload->>'won_cup')::boolean,
    (payload->>'won')::boolean,
    (payload->>'squad_strength')::real,
    (payload->>'efficiency_pct')::real,
    (payload->>'percentile')::real,
    (payload->>'rerolls_used')::int,
    case when payload ? 'achievements'
      then array(select jsonb_array_elements_text(payload->'achievements'))
      else null end
  )
  on conflict (id) do update set
    -- A finished result supersedes the start row. Never the other way round,
    -- so a retried start cannot wipe a completed play.
    status         = excluded.status,
    finished_at    = excluded.finished_at,
    coach_name     = excluded.coach_name,
    points         = excluded.points,
    wins           = excluded.wins,
    draws          = excluded.draws,
    losses         = excluded.losses,
    made_playoffs  = excluded.made_playoffs,
    playoff_seed   = excluded.playoff_seed,
    won_cup        = excluded.won_cup,
    won            = excluded.won,
    squad_strength = excluded.squad_strength,
    efficiency_pct = excluded.efficiency_pct,
    percentile     = excluded.percentile,
    rerolls_used   = excluded.rerolls_used,
    achievements   = excluded.achievements
  where p.status = 'started';

  if v_count > 0 then
    for v_pick in select * from jsonb_array_elements(payload->'picks') loop
      insert into public.picks (
        play_id, pick_no, player_id, player_name, player_season, team_id,
        team_abbr, position, slot, starter, score, is_dp, salary,
        board_best_value, taken_value
      ) values (
        v_id,
        (v_pick->>'pick_no')::int,
        v_pick->>'player_id',
        v_pick->>'player_name',
        v_pick->>'player_season',
        v_pick->>'team_id',
        v_pick->>'team_abbr',
        v_pick->>'position',
        v_pick->>'slot',
        (v_pick->>'starter')::boolean,
        (v_pick->>'score')::real,
        (v_pick->>'is_dp')::boolean,
        (v_pick->>'salary')::int,
        (v_pick->>'board_best_value')::real,
        (v_pick->>'taken_value')::real
      )
      on conflict (play_id, pick_no) do nothing;
    end loop;
  end if;
end;
$$;

-- The only privilege the public key carries.
revoke all on function public.log_play(jsonb) from public;
grant execute on function public.log_play(jsonb) to anon;
