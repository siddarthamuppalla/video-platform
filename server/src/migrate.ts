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
