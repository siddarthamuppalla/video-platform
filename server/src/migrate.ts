import { pathToFileURL } from "node:url";
import { pool } from "./db.js";

// One idempotent schema. A real project would use numbered migrations; this keeps the moving parts visible.
const schema = `
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'uploading'
                   CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed')),
  progress         integer NOT NULL DEFAULT 0,
  stage            text,
  error            text,
  duration_seconds double precision,
  width            integer,
  height           integer,
  renditions       jsonb NOT NULL DEFAULT '[]',
  views            integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz
);
CREATE INDEX IF NOT EXISTS videos_status_created ON videos (status, created_at DESC);
-- When the first (smallest) rendition was published. A video is watchable from then on, while larger ones encode.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS playable_at timestamptz;
UPDATE videos SET playable_at = ready_at WHERE playable_at IS NULL AND ready_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id     uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  size         bigint NOT NULL,
  chunk_size   integer NOT NULL,
  total_chunks integer NOT NULL,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- What the planner decided for a video: renditions, encode tiers, the chunk index and the probe. Every chunk
-- task reads it, so workers never re-probe the source.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS encode_plan jsonb;

-- One row per encode task: a video tier for one chunk (tier 0 = the smallest rendition, tier 1 = the rest), or the
-- video's audio. The queue says what to run next; this table is the durable record the publisher checks, and it
-- survives restarts and retries.
CREATE TABLE IF NOT EXISTS encode_tasks (
  video_id         uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('video', 'audio')),
  tier             integer NOT NULL,
  chunk            integer NOT NULL,
  renditions       jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  duration_seconds double precision,
  bytes            bigint,
  worker           text,
  error            text,
  started_at       timestamptz,
  finished_at      timestamptz,
  PRIMARY KEY (video_id, kind, tier, chunk)
);

-- One row per chunk that has landed on disk. Resuming an upload means asking which indexes are missing.
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  idx       integer NOT NULL,
  size      integer NOT NULL,
  PRIMARY KEY (upload_id, idx)
);
`;

export async function migrate() {
  await pool.query(schema);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => {
      console.log("schema up to date");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
