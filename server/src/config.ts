import path from "node:path";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const config = {
  port: Number(env("PORT", "4000")),
  databaseUrl: env("DATABASE_URL", "postgres://reel:reel@localhost:5432/reel"),
  redisUrl: env("REDIS_URL", "redis://localhost:6379"),
  // Everything on disk lives under one directory: in-progress chunks, sources and HLS output.
  storageDir: path.resolve(env("STORAGE_DIR", "./data")),
  // 5 MB chunks: small enough that a dropped connection only costs one chunk.
  chunkSize: Number(env("CHUNK_SIZE", String(5 * 1024 * 1024))),
  maxUploadBytes: Number(env("MAX_UPLOAD_BYTES", String(2 * 1024 * 1024 * 1024))),
  sessionDays: 30,
  cookieSecure: env("COOKIE_SECURE", "false") === "true",
};

export const paths = {
  uploadDir: (uploadId: string) => path.join(config.storageDir, "uploads", uploadId),
  chunk: (uploadId: string, index: number) =>
    path.join(config.storageDir, "uploads", uploadId, `${String(index).padStart(6, "0")}.part`),
  videoDir: (videoId: string) => path.join(config.storageDir, "videos", videoId),
  mediaRoot: () => path.join(config.storageDir, "videos"),
};
