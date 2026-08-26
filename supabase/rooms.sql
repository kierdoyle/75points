-- Road to 75 -- multiplayer draft rooms.
--
-- Run once in the Supabase SQL editor, after schema.sql.
--
-- Design notes
-- ------------
-- Same threat model as schema.sql: the publishable key ships in the JS bundle,
-- so the database cannot trust the caller. Every table is behind RLS with no
-- policies, and the only reachable surface is the SECURITY DEFINER functions
-- below. Each one re-derives the game state from stored rows rather than
-- believing anything the client says about it.
--
-- What the client is trusted with, and why that is safe:
--
--   * Which club-season a round is drafted from. Any member may propose one;
--     the first write for a round wins and everyone else reads it back. Two
--     honest clients propose the same board anyway (same seed, same state), so
--     first-write-wins costs nothing and removes any chance of the room
--     splitting onto different boards.
--   * The auto-pick when someone's clock runs out. Only accepted once the
--     clock has actually expired, which the database checks against its own
--     now(). Before that, only the seat on the clock can pick.
--
-- What it is never trusted with: whose turn it is, whether a player is still
-- available, or how many picks a seat has made. Turn order is computed here
-- from pick_no, and exclusivity is a unique index -- a second claim on a
-- player loses to the first no matter what the caller believes.
--
-- Nothing is readable except through get_room(code): knowing the room code is
-- the entire capability. Rooms are disposable and expire on their own.

-- ---------------------------------------------------------------- tables

create table if not exists public.rooms (
  code            text primary key check (code ~ '^[A-Z]{4}$'),
  host_client     uuid not null,
  league          text not null check (league in ('mls', 'nwsl')),
  difficulty      text not null check (difficulty in ('easy', 'normal', 'hard', 'max')),
  -- Drives every random draw the room makes: the boards, the coach shortlists
  -- and the season itself. Shared so all clients simulate the same season
  -- without the season ever being sent anywhere.
  seed            bigint not null,
  phase           text not null default 'lobby'
                    check (phase in ('lobby', 'draft', 'coach', 'season', 'playoffs')),
  -- Global pick counter, 0-based. Everything about whose turn it is derives
  -- from this and the seat count -- see seat_on_clock().
  pick_no         int not null default 0 check (pick_no >= 0),
  -- boards[i] is the club-season ('teamId|season') drafted in round i+1.
  boards          text[] not null default '{}',
  -- Seats in the order they pick, shuffled when the draft starts. Without it
  -- seat 0 -- always the host, since seats are handed out on arrival -- would
  -- open every single draft.
  draft_order     int[],
  pick_seconds    int not null default 60 check (pick_seconds between 15 and 300),
  -- Which pool file the room drafted from. A room is only coherent against
  -- the data it started on, so a client on a different build is turned away
  -- rather than shown a draft it would mis-render.
  data_version    text check (length(data_version) <= 32),
  turn_started_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '12 hours'
);

create table if not exists public.room_members (
  code        text not null references public.rooms(code) on delete cascade,
  seat        int  not null check (seat between 0 and 7),
  client_id   uuid not null,
  name        text not null check (length(name) between 1 and 20),
  formation   text check (length(formation) <= 12),
  conference  text check (conference in ('East', 'West', 'League')),
  coach_id    text check (length(coach_id) <= 32),
  -- Set once a member has locked in their XI and coach and is waiting on the
  -- room.
  ready       boolean not null default false,
  -- {slot_id: player_id} for a squad that has been rearranged after the draft.
  -- Only the arrangement is stored; who was drafted is still the pick list.
  lineup      jsonb,
  seen_at     timestamptz not null default now(),
  primary key (code, seat),
  unique (code, client_id)
);

create table if not exists public.room_picks (
  code        text not null references public.rooms(code) on delete cascade,
  pick_no     int  not null check (pick_no >= 0),
  round       int  not null check (round between 0 and 13),
  seat        int  not null check (seat between 0 and 7),
  player_id   text not null check (length(player_id) <= 32),
  slot_id     text not null check (length(slot_id) <= 16),
  -- Normally null: the pick came from the round's shared board. Set when the
  -- shared board had nothing legal left for this seat and it drew a
  -- replacement of its own -- see personalBoard() in roomdraft.js.
  board_key   text check (length(board_key) <= 40),
  -- True when the clock ran out and another client submitted on this seat's
  -- behalf. Surfaced in the UI so a timed-out pick is never a mystery.
  auto        boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (code, pick_no),
  -- The whole point of a shared draft: one player, one squad, room-wide.
  -- Enforced here rather than in the client, so a race between two clients
  -- resolves to exactly one winner.
  unique (code, player_id),
  -- A slot can only be filled once per seat.
  unique (code, seat, slot_id)
);

create index if not exists rooms_expiry_idx on public.rooms (expires_at);

-- Migrations, so this file can be re-run over an earlier install.
alter table public.rooms        add column if not exists draft_order int[];
alter table public.room_members add column if not exists lineup jsonb;
alter table public.room_picks   add column if not exists board_key text;
alter table public.rooms        drop constraint if exists rooms_phase_check;
alter table public.rooms        add  constraint rooms_phase_check
  check (phase in ('lobby', 'draft', 'coach', 'season', 'playoffs'));

-- ---------------------------------------------------------------- lockdown

alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.room_picks   enable row level security;

revoke all on public.rooms        from anon, authenticated;
revoke all on public.room_members from anon, authenticated;
revoke all on public.room_picks   from anon, authenticated;

-- ---------------------------------------------------------------- helpers

/**
 * Which *position* in the draft order is on the clock.
 *
 * Snake order: 0,1,2 then 2,1,0 then 0,1,2. Odd rounds run backwards, which
 * is what stops whoever picks first compounding that advantage over 14 rounds.
 *
 * A position is not a seat. Seats are handed out in join order, so mapping
 * straight to them would hand the host the first pick of every draft; the
 * room's draft_order is the shuffle in between.
 */
create or replace function public.seat_on_clock(p_pick_no int, p_seats int)
returns int
language sql
immutable
as $$
  select case when (p_pick_no / p_seats) % 2 = 0
              then p_pick_no % p_seats
              else p_seats - 1 - (p_pick_no % p_seats)
         end;
$$;

/** Drop rooms nobody can still be playing. Called on room creation. */
create or replace function public.sweep_rooms()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.rooms where expires_at < now();
$$;

-- ---------------------------------------------------------------- read path

/**
 * The whole room, as one JSON blob. Clients poll this.
 *
 * Everything else in the game is derived: the squads come from replaying
 * picks against the pool, and the season comes from the seed. So this is the
 * only read the game ever makes.
 */
create or replace function public.get_room(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_out  jsonb;
begin
  select * into v_room from public.rooms where code = upper(p_code);
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select jsonb_build_object(
    'code', v_room.code,
    'league', v_room.league,
    'difficulty', v_room.difficulty,
    'seed', v_room.seed,
    'phase', v_room.phase,
    'pick_no', v_room.pick_no,
    'boards', to_jsonb(v_room.boards),
    'draft_order', to_jsonb(v_room.draft_order),
    'pick_seconds', v_room.pick_seconds,
    'data_version', v_room.data_version,
    'host_client', v_room.host_client,
    'turn_started_at', v_room.turn_started_at,
    'server_time', now(),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'seat', m.seat, 'client_id', m.client_id, 'name', m.name,
        'formation', m.formation, 'conference', m.conference,
        'coach_id', m.coach_id, 'ready', m.ready, 'lineup', m.lineup
      ) order by m.seat)
      from public.room_members m where m.code = v_room.code
    ), '[]'::jsonb),
    'picks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'pick_no', k.pick_no, 'round', k.round, 'seat', k.seat,
        'player_id', k.player_id, 'slot_id', k.slot_id, 'auto', k.auto,
        'board_key', k.board_key
      ) order by k.pick_no)
      from public.room_picks k where k.code = v_room.code
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------- write path

/** Open a room and seat the host. Returns the generated code. */
create or replace function public.create_room(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- No I, O, Q or U: the first three misread as 1/0, and dropping U keeps the
  -- generator from spelling anything anyone has to read out to a friend.
  v_alpha text := 'ABCDEFGHJKLMNPRSTVWXYZ';
  v_code  text;
  v_host  uuid := (payload->>'client_id')::uuid;
  v_name  text := left(coalesce(nullif(trim(payload->>'name'), ''), 'Host'), 20);
begin
  if v_host is null then
    raise exception 'client_id is required';
  end if;

  perform public.sweep_rooms();

  for attempt in 1..20 loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = v_code);
    v_code := null;
  end loop;
  if v_code is null then
    raise exception 'could not allocate a room code';
  end if;

  insert into public.rooms (code, host_client, league, difficulty, seed,
                            pick_seconds, data_version)
  values (
    v_code, v_host,
    coalesce(payload->>'league', 'mls'),
    coalesce(payload->>'difficulty', 'normal'),
    coalesce((payload->>'seed')::bigint, (random() * 2147483647)::bigint),
    coalesce((payload->>'pick_seconds')::int, 60),
    payload->>'data_version'
  );

  insert into public.room_members (code, seat, client_id, name, formation, conference)
  values (v_code, 0, v_host, v_name, payload->>'formation', payload->>'conference');

  return public.get_room(v_code);
end;
$$;

/** Take the next free seat. Rooms are closed once the draft starts. */
create or replace function public.join_room(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code   text := upper(payload->>'code');
  v_client uuid := (payload->>'client_id')::uuid;
  v_name   text := left(coalesce(nullif(trim(payload->>'name'), ''), 'Player'), 20);
  v_room   public.rooms;
  v_seat   int;
begin
  select * into v_room from public.rooms where code = v_code for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_room.expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;

  -- Rejoining from the same device is always allowed: that is how someone
  -- who reloaded mid-draft gets back to their seat.
  if exists (select 1 from public.room_members
             where code = v_code and client_id = v_client) then
    update public.room_members set seen_at = now()
      where code = v_code and client_id = v_client;
    return public.get_room(v_code);
  end if;

  if v_room.phase <> 'lobby' then
    return jsonb_build_object('error', 'in_progress');
  end if;
  if v_room.data_version is not null
     and payload->>'data_version' is not null
     and v_room.data_version <> payload->>'data_version' then
    return jsonb_build_object('error', 'version_mismatch');
  end if;

  select coalesce(min(s.seat), -1) into v_seat
  from generate_series(0, 7) s(seat)
  where not exists (
    select 1 from public.room_members m where m.code = v_code and m.seat = s.seat
  );
  if v_seat < 0 then
    return jsonb_build_object('error', 'full');
  end if;

  insert into public.room_members (code, seat, client_id, name, formation, conference)
  values (v_code, v_seat, v_client, v_name, payload->>'formation', payload->>'conference');

  update public.rooms set updated_at = now() where code = v_code;
  return public.get_room(v_code);
end;
$$;

/** A member's own settings: formation, conference, coach, ready flag. */
create or replace function public.update_member(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code   text := upper(payload->>'code');
  v_client uuid := (payload->>'client_id')::uuid;
begin
  update public.room_members set
    name       = coalesce(left(nullif(trim(payload->>'name'), ''), 20), name),
    formation  = coalesce(payload->>'formation', formation),
    conference = coalesce(payload->>'conference', conference),
    coach_id   = coalesce(payload->>'coach_id', coach_id),
    lineup     = coalesce(payload->'lineup', lineup),
    ready      = coalesce((payload->>'ready')::boolean, ready),
    seen_at    = now()
  where code = v_code and client_id = v_client;

  if not found then
    return jsonb_build_object('error', 'not_seated');
  end if;

  -- Once every seat has appointed a coach the room moves itself on, so the
  -- last person to choose does not have to also press start.
  update public.rooms r set phase = 'season', updated_at = now()
  where r.code = v_code and r.phase = 'coach'
    and not exists (
      select 1 from public.room_members m where m.code = v_code and not m.ready
    );

  return public.get_room(v_code);
end;
$$;

/** Host closes the lobby and puts the first seat on the clock. */
create or replace function public.start_draft(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code   text := upper(payload->>'code');
  v_client uuid := (payload->>'client_id')::uuid;
  v_room   public.rooms;
  v_order  int[];
begin
  select * into v_room from public.rooms where code = v_code for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_room.host_client <> v_client then
    return jsonb_build_object('error', 'not_host');
  end if;
  if v_room.phase <> 'lobby' then
    return public.get_room(v_code);
  end if;
  if exists (select 1 from public.room_members
             where code = v_code and formation is null) then
    return jsonb_build_object('error', 'not_everyone_ready');
  end if;

  -- The shuffle happens here rather than at creation because the room is only
  -- now closed: everyone who is going to draft has arrived.
  select array_agg(seat order by random())
    into v_order
    from public.room_members
   where code = v_code;

  update public.rooms
     set phase = 'draft', turn_started_at = now(), updated_at = now(),
         draft_order = v_order,
         expires_at = now() + interval '12 hours'
   where code = v_code;

  return public.get_room(v_code);
end;
$$;

/**
 * Record the club-season a round is drafted from.
 *
 * First write wins. Any member may propose, so a host who closes their laptop
 * cannot stall the room, and a late proposal is silently ignored rather than
 * overwriting a board people are already picking from.
 */
create or replace function public.set_board(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code  text := upper(payload->>'code');
  v_round int  := (payload->>'round')::int;
  v_key   text := payload->>'spin_key';
begin
  if v_key is null or length(v_key) > 40 then
    raise exception 'spin_key is required';
  end if;

  update public.rooms
     set boards = boards || v_key, updated_at = now()
   where code = v_code
     and phase = 'draft'
     -- Appends only, and only the round that is actually next. Anything else
     -- is a client that fell behind.
     and coalesce(array_length(boards, 1), 0) = v_round;

  return public.get_room(v_code);
end;
$$;

/**
 * Make the pick that is on the clock.
 *
 * The caller says which player and which slot; the database decides whether
 * they were entitled to. Turn order comes from pick_no, availability from the
 * unique index, and the expiry check from now() -- none of it from the
 * payload.
 */
create or replace function public.make_pick(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code    text := upper(payload->>'code');
  v_client  uuid := (payload->>'client_id')::uuid;
  v_player  text := payload->>'player_id';
  v_slot    text := payload->>'slot_id';
  v_expect  int  := (payload->>'pick_no')::int;
  v_room    public.rooms;
  v_seats   int;
  v_pos     int;
  v_seat    int;
  v_owner   uuid;
  v_expired boolean;
begin
  select * into v_room from public.rooms where code = v_code for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_room.phase <> 'draft' then
    return jsonb_build_object('error', 'not_drafting');
  end if;

  -- A pick aimed at a pick number that has already been made is a client that
  -- fell behind, not an error worth shouting about: hand back the room and
  -- let it re-render.
  if v_expect is not null and v_expect <> v_room.pick_no then
    return public.get_room(v_code);
  end if;

  select count(*) into v_seats from public.room_members where code = v_code;
  v_pos := public.seat_on_clock(v_room.pick_no, v_seats);
  -- Position through the shuffle to a seat. Rooms opened before draft_order
  -- existed fall back to seat order.
  if v_room.draft_order is not null
     and coalesce(array_length(v_room.draft_order, 1), 0) = v_seats then
    v_seat := v_room.draft_order[v_pos + 1];
  else
    v_seat := v_pos;
  end if;
  select client_id into v_owner
    from public.room_members where code = v_code and seat = v_seat;

  v_expired := v_room.turn_started_at is not null
    and now() > v_room.turn_started_at + make_interval(secs => v_room.pick_seconds);

  -- Your turn, or anyone's turn once the clock has run out on it.
  if v_owner <> v_client and not v_expired then
    return jsonb_build_object('error', 'not_your_turn');
  end if;

  begin
    insert into public.room_picks (code, pick_no, round, seat, player_id, slot_id,
                                   auto, board_key)
    values (v_code, v_room.pick_no, v_room.pick_no / v_seats, v_seat,
            v_player, v_slot, v_owner <> v_client, payload->>'board_key');
  exception
    when unique_violation then
      -- Someone else took this player, or this seat, first. The room state
      -- that comes back tells the client what actually happened.
      return public.get_room(v_code);
  end;

  update public.rooms
     set pick_no = pick_no + 1,
         turn_started_at = now(),
         updated_at = now(),
         -- 14 rounds, then everyone appoints a coach.
         phase = case when pick_no + 1 >= v_seats * 14 then 'coach' else 'draft' end
   where code = v_code;

  return public.get_room(v_code);
end;
$$;

/**
 * Host sends the room from the finished regular season into the playoffs.
 *
 * The bracket is already decided -- every client derived it from the seed the
 * moment the draft ended -- so this settles *when* everyone watches it, not
 * what happens. It exists so a room can sit on the final table and argue about
 * it before anyone starts the knockouts.
 */
create or replace function public.start_playoffs(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code   text := upper(payload->>'code');
  v_client uuid := (payload->>'client_id')::uuid;
  v_room   public.rooms;
begin
  select * into v_room from public.rooms where code = v_code for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_room.host_client <> v_client then
    return jsonb_build_object('error', 'not_host');
  end if;
  if v_room.phase = 'season' then
    update public.rooms set phase = 'playoffs', updated_at = now() where code = v_code;
  end if;
  return public.get_room(v_code);
end;
$$;

-- ---------------------------------------------------------------- grants

revoke all on function public.create_room(jsonb)   from public;
revoke all on function public.join_room(jsonb)     from public;
revoke all on function public.update_member(jsonb) from public;
revoke all on function public.start_draft(jsonb)   from public;
revoke all on function public.set_board(jsonb)     from public;
revoke all on function public.make_pick(jsonb)     from public;
revoke all on function public.start_playoffs(jsonb) from public;
revoke all on function public.get_room(text)       from public;

grant execute on function public.create_room(jsonb)   to anon;
grant execute on function public.join_room(jsonb)     to anon;
grant execute on function public.update_member(jsonb) to anon;
grant execute on function public.start_draft(jsonb)   to anon;
grant execute on function public.set_board(jsonb)     to anon;
grant execute on function public.make_pick(jsonb)     to anon;
grant execute on function public.start_playoffs(jsonb) to anon;
grant execute on function public.get_room(text)       to anon;
