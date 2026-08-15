-- Supabase schema for ephemeral 1:1 chat

-- Enable UUID extension if not present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  nickname text,
  joined_at timestamptz DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid,
  nickname text,
  content text,
  created_at timestamptz DEFAULT now()
);

-- waiting queue for pairing
CREATE TABLE waiting (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid UNIQUE NOT NULL,
  nickname text,
  enqueued_at timestamptz DEFAULT now()
);

-- RPC to atomically match a caller with another waiting user; returns room_id if matched, otherwise NULL
CREATE OR REPLACE FUNCTION public.match_pair(p_user_id uuid, p_nickname text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  other_row waiting%ROWTYPE;
  new_room uuid;
BEGIN
  -- try to find another waiting user and lock it (skip locked avoids contention)
  SELECT * INTO other_row FROM waiting WHERE user_id <> p_user_id LIMIT 1 FOR UPDATE SKIP LOCKED;

  IF FOUND THEN
    -- remove the other waiting row
    DELETE FROM waiting WHERE id = other_row.id;
    -- create a room and participants
    INSERT INTO rooms DEFAULT VALUES RETURNING id INTO new_room;
    INSERT INTO participants (room_id, user_id, nickname) VALUES (new_room, p_user_id, p_nickname), (new_room, other_row.user_id, other_row.nickname);
    RETURN new_room;
  ELSE
    -- no match: ensure caller is enqueued (insert or ignore)
    INSERT INTO waiting (user_id, nickname) VALUES (p_user_id, p_nickname) ON CONFLICT (user_id) DO UPDATE SET nickname = EXCLUDED.nickname, enqueued_at = now();
    RETURN NULL;
  END IF;
END;
$$;

-- Trigger: when a participant is deleted, if room has no participants left, delete room (messages cascade)
CREATE OR REPLACE FUNCTION public.clean_empty_room() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM participants WHERE room_id = OLD.room_id LIMIT 1;
  IF NOT FOUND THEN
    DELETE FROM rooms WHERE id = OLD.room_id;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_clean_room AFTER DELETE ON participants FOR EACH ROW EXECUTE PROCEDURE public.clean_empty_room();

-- Note: enable RLS and create tight policies before going public. Keep anon key limited by policies.