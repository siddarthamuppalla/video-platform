import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import express, { Router } from "express";
import { z } from "zod";
import { config, paths } from "./config.js";
import { query, pool } from "./db.js";
import { HttpError } from "./errors.js";
import { requireUser } from "./auth.js";
import { enqueueTranscode } from "./queue.js";

type UploadRow = {
  id: string;
  user_id: string;
  video_id: string;
  filename: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  completed_at: Date | null;
};

const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

const createBody = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  title: z.string().trim().max(120).optional(),
  description: z.string().trim().max(5000).optional(),
});

/** Byte length the chunk at `index` must have: every chunk is full except possibly the last. */
export function expectedChunkSize(size: number, chunkSize: number, index: number) {
  const total = Math.ceil(size / chunkSize);
  if (index < 0 || index >= total) return -1;
  return index === total - 1 ? size - chunkSize * (total - 1) : chunkSize;
}

async function loadUpload(id: string, userId: string) {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "Upload not found.");
  const { rows } = await query<UploadRow>("SELECT * FROM uploads WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!rows[0]) throw new HttpError(404, "Upload not found.");
  return rows[0];
}

async function receivedChunks(uploadId: string) {
  const { rows } = await query<{ idx: number }>(
    "SELECT idx FROM upload_chunks WHERE upload_id = $1 ORDER BY idx",
    [uploadId],
  );
  return rows.map((r) => r.idx);
}

function describe(u: UploadRow, received: number[]) {
  return {
    uploadId: u.id,
    videoId: u.video_id,
    filename: u.filename,
    size: u.size,
    chunkSize: u.chunk_size,
    totalChunks: u.total_chunks,
    received,
    completed: u.completed_at !== null,
  };
}

export const uploadsRouter = Router();
uploadsRouter.use(requireUser);

// Step 1: announce the file. The server decides the chunk size and creates the video row up front,
// so the client can show it in "Your uploads" while bytes are still arriving.
uploadsRouter.post("/", async (req, res) => {
  const body = createBody.parse(req.body);
  const ext = path.extname(body.filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new HttpError(400, "Upload an MP4, MOV, MKV, WebM, AVI or M4V file.");
  }
  if (body.size > config.maxUploadBytes) {
    throw new HttpError(413, `Videos can be up to ${Math.round(config.maxUploadBytes / 1024 ** 3)} GB.`);
  }
  const title = body.title || path.basename(body.filename, ext).replace(/[-_]+/g, " ").trim() || "Untitled video";
  const totalChunks = Math.ceil(body.size / config.chunkSize);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const video = await client.query<{ id: string }>(
      "INSERT INTO videos (user_id, title, description) VALUES ($1, $2, $3) RETURNING id",
      [req.user!.id, title, body.description ?? ""],
    );
    const upload = await client.query<UploadRow>(
      `INSERT INTO uploads (user_id, video_id, filename, size, chunk_size, total_chunks)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user!.id, video.rows[0].id, body.filename, body.size, config.chunkSize, totalChunks],
    );
    await client.query("COMMIT");
    await fsp.mkdir(paths.uploadDir(upload.rows[0].id), { recursive: true });
    res.status(201).json(describe(upload.rows[0], []));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Resuming: the client asks which chunks already landed and sends only the rest.
uploadsRouter.get("/:id", async (req, res) => {
  const upload = await loadUpload(String(req.params.id), req.user!.id);
  res.json(describe(upload, await receivedChunks(upload.id)));
});

// Step 2: send each chunk as raw bytes. Re-sending a chunk overwrites it, so retries are safe.
uploadsRouter.put(
  "/:id/chunks/:index",
  express.raw({ type: () => true, limit: config.chunkSize + 1024 }),
  async (req, res) => {
    const upload = await loadUpload(String(req.params.id), req.user!.id);
    if (upload.completed_at) throw new HttpError(409, "This upload is already complete.");
    const index = Number(req.params.index);
    const expected = expectedChunkSize(upload.size, upload.chunk_size, Number.isInteger(index) ? index : -1);
    if (expected < 0) throw new HttpError(400, `Chunk index must be between 0 and ${upload.total_chunks - 1}.`);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length !== expected) {
      throw new HttpError(400, `Chunk ${index} should be ${expected} bytes but was ${body?.length ?? 0}.`);
    }
    // Write to a temp name and rename, so a half-written chunk is never mistaken for a whole one.
    const final = paths.chunk(upload.id, index);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, final);
    await query(
      `INSERT INTO upload_chunks (upload_id, idx, size) VALUES ($1, $2, $3)
       ON CONFLICT (upload_id, idx) DO UPDATE SET size = EXCLUDED.size`,
      [upload.id, index, body.length],
    );
    const { rows } = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM upload_chunks WHERE upload_id = $1",
      [upload.id],
    );
    res.json({ index, received: rows[0].count, totalChunks: upload.total_chunks });
  },
);

// Step 3: stitch the chunks back into one file in order, then hand the video to the encoder.
uploadsRouter.post("/:id/complete", async (req, res) => {
  const upload = await loadUpload(String(req.params.id), req.user!.id);
  if (upload.completed_at) {
    res.json({ videoId: upload.video_id, status: "queued" });
    return;
  }
  const received = await receivedChunks(upload.id);
  if (received.length !== upload.total_chunks) {
    const have = new Set(received);
    const missing = Array.from({ length: upload.total_chunks }, (_, i) => i).filter((i) => !have.has(i));
    throw new HttpError(409, `Still missing ${missing.length} chunk(s), starting with chunk ${missing[0]}.`);
  }

  const videoDir = paths.videoDir(upload.video_id);
  await fsp.mkdir(videoDir, { recursive: true });
  const ext = path.extname(upload.filename).toLowerCase();
  const sourcePath = path.join(videoDir, `source${ext}`);
  const out = fs.createWriteStream(sourcePath);
  for (let i = 0; i < upload.total_chunks; i++) {
    await pipeline(fs.createReadStream(paths.chunk(upload.id, i)), out, { end: false });
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

  const { size } = await fsp.stat(sourcePath);
  if (size !== upload.size) {
    throw new HttpError(500, `Reassembled file is ${size} bytes, expected ${upload.size}.`);
  }

  await query("UPDATE uploads SET completed_at = now() WHERE id = $1", [upload.id]);
  await query("UPDATE videos SET status = 'queued', stage = 'Waiting for encoder' WHERE id = $1", [upload.video_id]);
  await fsp.rm(paths.uploadDir(upload.id), { recursive: true, force: true });
  await query("DELETE FROM upload_chunks WHERE upload_id = $1", [upload.id]);
  await enqueueTranscode(upload.video_id);
  res.json({ videoId: upload.video_id, status: "queued" });
});
