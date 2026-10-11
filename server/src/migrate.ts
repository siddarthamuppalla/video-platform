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

-- One row per chunk that has landed on disk. Resuming an upload means asking which indexes are missing.
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  idx       integer NOT NULL,
  size      integer NOT NULL,
  PRIMARY KEY (upload_id, idx)
);

-- Every step a video takes through the pipeline, in order: chunks arriving, assembly, each rendition's
-- segments, publishing. The dashboard animates these live and replays them afterwards (see events.ts).
CREATE TABLE IF NOT EXISTS pipeline_events (
  id       bigserial PRIMARY KEY,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind     text NOT NULL,
  data     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS pipeline_events_video ON pipeline_events (video_id, id);

-- The worker and the API record events, and the API streams them: NOTIFY tells it which video has new ones.
CREATE OR REPLACE FUNCTION notify_pipeline_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pipeline_events', NEW.video_id::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER pipeline_events_notify AFTER INSERT ON pipeline_events
  FOR EACH ROW EXECUTE FUNCTION notify_pipeline_event();
`;

export async function migrate() {
  // The API and the worker both migrate on start. The lock keeps them from replacing the same function at once.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7231)");
    await client.query(schema);
  } finally {
    await client.query("SELECT pg_advisory_unlock(7231)").catch(() => {});
    client.release();
  }
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
