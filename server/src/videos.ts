import fsp from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { paths } from "./config.js";
import { query } from "./db.js";
import { HttpError } from "./errors.js";
import { requireUser } from "./auth.js";

export type Rendition = { name: string; width: number; height: number; bandwidth: number };

type VideoRow = {
  id: string;
  user_id: string;
  username: string;
  title: string;
  description: string;
  status: string;
  progress: number;
  stage: string | null;
  error: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  renditions: Rendition[];
  views: number;
  created_at: Date;
};

const SELECT = `SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id`;

function present(v: VideoRow) {
  const ready = v.status === "ready";
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    status: v.status,
    progress: v.progress,
    stage: v.stage,
    error: v.error,
    durationSeconds: v.duration_seconds,
    width: v.width,
    height: v.height,
    renditions: v.renditions,
    views: v.views,
    createdAt: v.created_at,
    owner: { id: v.user_id, username: v.username },
    thumbnailUrl: ready ? `/media/${v.id}/thumbnail.jpg` : null,
    hlsUrl: ready ? `/media/${v.id}/master.m3u8` : null,
  };
}

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;

async function findVideo(id: string) {
  if (!isUuid(id)) return undefined;
  const { rows } = await query<VideoRow>(`${SELECT} WHERE v.id = $1`, [id]);
  return rows[0];
}

export const videosRouter = Router();

// Public list: only finished videos, newest first, with optional title search.
videosRouter.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const { rows } = await query<VideoRow>(
    `${SELECT} WHERE v.status = 'ready' AND ($1 = '' OR v.title ILIKE '%' || $1 || '%')
     ORDER BY v.ready_at DESC NULLS LAST, v.created_at DESC LIMIT 60`,
    [q],
  );
  res.json({ videos: rows.map(present) });
});

// The signed-in person's uploads in every state, so the UI can poll processing progress.
videosRouter.get("/mine", requireUser, async (req, res) => {
  const { rows } = await query<VideoRow>(`${SELECT} WHERE v.user_id = $1 ORDER BY v.created_at DESC`, [
    req.user!.id,
  ]);
  res.json({ videos: rows.map(present) });
});

videosRouter.get("/:id", async (req, res) => {
  const v = await findVideo(String(req.params.id));
  if (!v || (v.status !== "ready" && v.user_id !== req.user?.id)) throw new HttpError(404, "Video not found.");
  res.json({ video: present(v) });
});

videosRouter.post("/:id/view", async (req, res) => {
  if (!isUuid(String(req.params.id))) throw new HttpError(404, "Video not found.");
  const { rows } = await query<{ views: number }>(
    "UPDATE videos SET views = views + 1 WHERE id = $1 AND status = 'ready' RETURNING views",
    [req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "Video not found.");
  res.json({ views: rows[0].views });
});

const patchBody = z.object({
  title: z.string().trim().min(1, "Give the video a title.").max(120).optional(),
  description: z.string().trim().max(5000).optional(),
});

videosRouter.patch("/:id", requireUser, async (req, res) => {
  const body = patchBody.parse(req.body);
  const v = await findVideo(String(req.params.id));
  if (!v || v.user_id !== req.user!.id) throw new HttpError(404, "Video not found.");
  await query("UPDATE videos SET title = COALESCE($2, title), description = COALESCE($3, description) WHERE id = $1", [
    v.id,
    body.title ?? null,
    body.description ?? null,
  ]);
  res.json({ video: present((await findVideo(v.id))!) });
});

videosRouter.delete("/:id", requireUser, async (req, res) => {
  const v = await findVideo(String(req.params.id));
  if (!v || v.user_id !== req.user!.id) throw new HttpError(404, "Video not found.");
  await query("DELETE FROM videos WHERE id = $1", [v.id]);
  await fsp.rm(paths.videoDir(v.id), { recursive: true, force: true });
  res.status(204).end();
});
