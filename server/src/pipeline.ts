import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paths } from "./config.js";
import { pool, query } from "./db.js";
import { recordEvent } from "./events.js";
import { CHUNK_QUEUE_NAME, enqueueTasks, QUEUE_NAME, type ChunkJob } from "./queue.js";
import {
  audioArgs,
  bandwidthFor,
  chunkArgs,
  encodeAudio,
  encodeChunk,
  encodeGroups,
  makeThumbnail,
  masterPlaylist,
  mediaPlaylist,
  planChunks,
  planRenditions,
  probe,
  SEGMENT_SECONDS,
  type Chunk,
  type PlannedRendition,
  type Probe,
} from "./transcode.js";

/**
 * How a video is encoded, in three steps that can run on different machines:
 *
 * 1. planVideo (the `transcode` job): probe the source, cut its timeline into chunks, write one encode_tasks row
 *    per task and queue the tasks.
 * 2. runTask (an `encode-chunk` job): encode one tier of one chunk into one segment per rendition, or the audio.
 * 3. syncVideo (after every task): when every chunk of a rendition is done, write its playlist and add it to the
 *    master playlist, which makes it playable.
 *
 * Each step records pipeline events (see events.ts), which the dashboard animates live and replays afterwards.
 */

/** What the planner decided, stored on the video so chunk workers never have to re-probe the source. */
export type EncodePlan = {
  probe: Probe;
  renditions: PlannedRendition[]; // highest first, as in the master playlist
  tiers: string[][]; // rendition names per tier; tier 0 is encoded first
  chunks: Chunk[];
};

type TaskRow = {
  kind: "video" | "audio";
  tier: number;
  chunk: number;
  status: "queued" | "running" | "done" | "failed";
  duration_seconds: number | null;
  error: string | null;
};

async function sourcePath(videoId: string) {
  const dir = paths.videoDir(videoId);
  const source = (await fsp.readdir(dir).catch(() => [])).find((f) => f.startsWith("source."));
  if (!source) throw new Error("The uploaded file is missing.");
  return path.join(dir, source);
}

/** Write to a temp file and rename, so a player fetching the playlist never reads a half-written one. */
async function writeAtomic(file: string, contents: string) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, file);
}

const summary = (r: PlannedRendition, hasAudio: boolean) => ({
  name: r.name,
  width: r.width,
  height: r.height,
  bandwidth: bandwidthFor(r, hasAudio),
});

/**
 * Step 1. Plan the encode and queue its tasks. Safe to run again, as a retry does: tasks already done are kept and
 * not queued again, so the renditions they published stay up.
 */
export async function planVideo(videoId: string, job: { attempt?: number; maxAttempts?: number } = {}): Promise<ChunkJob[]> {
  const source = await sourcePath(videoId);
  const file = path.basename(source);
  const dir = paths.videoDir(videoId);
  await query("UPDATE videos SET status = 'processing', stage = 'Reading file', error = NULL WHERE id = $1", [videoId]);
  await recordEvent(videoId, "encode_started", {
    queue: QUEUE_NAME, jobId: videoId, attempt: job.attempt ?? 1, maxAttempts: job.maxAttempts ?? 1, source: file, pid: process.pid,
  });
  const info = await probe(source);
  await query("UPDATE videos SET duration_seconds = $2, width = $3, height = $4 WHERE id = $1", [
    videoId, info.durationSeconds, info.width, info.height,
  ]);
  await recordEvent(videoId, "probed", { ...info });
  await query("UPDATE videos SET stage = 'Making thumbnail' WHERE id = $1", [videoId]);
  await makeThumbnail(source, dir, info);
  await recordEvent(videoId, "thumbnail");

  const renditions = planRenditions(info.width, info.height);
  const tiers = encodeGroups(renditions).map((g) => g.map((r) => r.name));
  const plan: EncodePlan = { probe: info, renditions, tiers, chunks: planChunks(info.durationSeconds) };

  // Audio first, then the smallest rendition chunk by chunk, then the rest: the order the queue will run them in.
  const tasks: ChunkJob[] = [
    ...(info.hasAudio ? [{ videoId, kind: "audio" as const, tier: 0, chunk: 0 }] : []),
    ...tiers.flatMap((_, tier) => plan.chunks.map((c) => ({ videoId, kind: "video" as const, tier, chunk: c.index }))),
  ];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE videos SET encode_plan = $2, stage = 'Queued for encoding' WHERE id = $1", [videoId, JSON.stringify(plan)]);
    for (const t of tasks) {
      await client.query(
        `INSERT INTO encode_tasks (video_id, kind, tier, chunk, renditions) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (video_id, kind, tier, chunk) DO UPDATE SET status = 'queued', error = NULL
           WHERE encode_tasks.status <> 'done'`,
        [videoId, t.kind, t.tier, t.chunk, JSON.stringify(t.kind === "audio" ? [] : tiers[t.tier])],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await query<{ kind: "video" | "audio"; tier: number; chunk: number }>(
    "SELECT kind, tier, chunk FROM encode_tasks WHERE video_id = $1 AND status <> 'done'",
    [videoId],
  );
  const pending = tasks.filter((t) => rows.some((r) => r.kind === t.kind && r.tier === t.tier && r.chunk === t.chunk));
  const tierPending = (tier: number) => pending.some((t) => t.kind === "video" && t.tier === tier);
  // A rendition an earlier attempt already published is kept as it is.
  const published = new Set(
    (await query<{ renditions: { name: string }[] }>("SELECT renditions FROM videos WHERE id = $1", [videoId])).rows[0]?.renditions.map((r) => r.name),
  );
  const rungs = (tier: number) => renditions.filter((r) => tiers[tier].includes(r.name));
  await recordEvent(videoId, "planned", {
    renditions: renditions.map((r) => {
      const tier = tiers.findIndex((names) => names.includes(r.name));
      return {
        name: r.name, width: r.width, height: r.height, videoKbps: r.videoKbps, bandwidth: bandwidthFor(r, info.hasAudio),
        codecs: info.hasAudio ? `${r.codec},mp4a.40.2` : r.codec, group: published.has(r.name) ? -1 : tier,
      };
    }),
    segments: plan.chunks.length,
    segmentSeconds: SEGMENT_SECONDS,
    chunks: plan.chunks,
    tasks: pending.length,
    queue: CHUNK_QUEUE_NAME,
    // Each tier's ffmpeg command, shown for chunk 0 with paths relative to the video's folder; every chunk runs the same.
    groups: tiers
      .map((names, tier) => ({ tier, renditions: names, priority: tier + 1, command: ["ffmpeg", ...chunkArgs(file, "", plan.chunks[0], rungs(tier), info)] }))
      .filter((g) => tierPending(g.tier)),
    audio: info.hasAudio ? { command: ["ffmpeg", ...audioArgs(file, "")], pending: pending.some((t) => t.kind === "audio") } : null,
  });
  await enqueueTasks(pending);
  await syncVideo(videoId);
  return pending;
}

const workerName = `${os.hostname()}:${process.pid}`;

/** Step 2. Encode one task. Its row records who ran it, how long the chunk came out and how many bytes it wrote. */
export async function runTask(task: ChunkJob, opts: { threads?: number; signal?: AbortSignal; attempt?: number } = {}) {
  const { videoId, kind, tier, chunk } = task;
  const key = [videoId, kind, tier, chunk];
  const { rows } = await query<{ encode_plan: EncodePlan | null }>("SELECT encode_plan FROM videos WHERE id = $1", [videoId]);
  const plan = rows[0]?.encode_plan;
  if (!plan) return; // The video was deleted: nothing to do.
  const claimed = await query(
    `UPDATE encode_tasks SET status = 'running', attempts = attempts + 1, worker = $5, started_at = now(), error = NULL
     WHERE video_id = $1 AND kind = $2 AND tier = $3 AND chunk = $4 AND status <> 'done'`,
    [...key, workerName],
  );
  if (claimed.rowCount === 0) return; // Already done, or the video is gone.

  const source = await sourcePath(videoId);
  const dir = paths.videoDir(videoId);
  const names = kind === "audio" ? ["audio"] : plan.tiers[tier];
  await recordEvent(videoId, "task_started", { kind, tier, chunk, renditions: names, worker: workerName, attempt: opts.attempt ?? 1 });
  const started = performance.now();
  let result: { durationSeconds?: number; bytes: number; segments?: { rendition: string; bytes: number }[] };
  if (kind === "audio") {
    // If another run of this task already finished, keep its files rather than swapping in a second copy.
    const keep = async () =>
      (await query("SELECT 1 FROM encode_tasks WHERE video_id = $1 AND kind = $2 AND tier = $3 AND chunk = $4 AND status <> 'done'", key)).rowCount! > 0;
    const audio = await encodeAudio(source, dir, { ...opts, keep });
    if (!audio.kept) return;
    result = audio;
  } else {
    const rs = plan.renditions.filter((r) => plan.tiers[tier].includes(r.name));
    result = await encodeChunk(source, dir, plan.chunks[chunk], rs, plan.probe, opts);
  }
  const ms = Math.round(performance.now() - started);
  const done = await query(
    `UPDATE encode_tasks SET status = 'done', duration_seconds = $5, bytes = $6, finished_at = now()
     WHERE video_id = $1 AND kind = $2 AND tier = $3 AND chunk = $4`,
    [...key, result.durationSeconds ?? null, result.bytes],
  );
  if (done.rowCount === 0) {
    // The video was deleted while this chunk encoded; don't leave its files behind.
    await fsp.rm(dir, { recursive: true, force: true });
    return;
  }
  // A chunk's segments are finished files on disk now, one per rendition in its tier.
  for (const seg of result.segments ?? []) await recordEvent(videoId, "segment", { rendition: seg.rendition, index: chunk, bytes: seg.bytes });
  await recordEvent(videoId, "task_done", {
    kind, tier, chunk, renditions: names, worker: workerName, ms, bytes: result.bytes, durationSeconds: result.durationSeconds ?? null,
  });
  await syncVideo(videoId);
}

/** A task's attempt failed. On its last attempt it is marked failed for good and the video carries on without it. */
export async function taskFailed(task: ChunkJob, error: string, final: boolean) {
  await query(
    `UPDATE encode_tasks SET status = $5, error = $6, finished_at = now()
     WHERE video_id = $1 AND kind = $2 AND tier = $3 AND chunk = $4 AND status <> 'done'`,
    [task.videoId, task.kind, task.tier, task.chunk, final ? "failed" : "queued", error.slice(0, 500)],
  );
  const { rowCount } = await query("SELECT 1 FROM videos WHERE id = $1", [task.videoId]);
  if (rowCount === 0) {
    // The video was deleted while this task ran, and the encode may have recreated its folder; remove it again.
    await fsp.rm(paths.videoDir(task.videoId), { recursive: true, force: true });
    return;
  }
  await recordEvent(task.videoId, "task_failed", {
    kind: task.kind, tier: task.tier, chunk: task.chunk, error: error.slice(0, 500), final, worker: workerName,
  });
  if (final) await syncVideo(task.videoId);
}

const range = (names: string[]) => (names.length === 1 ? names[0] : `${names[0]}–${names[names.length - 1]}`);

/**
 * Step 3. Bring the video's playlists and status up to date with its tasks. Runs after every task, on whichever
 * worker finished it. The video's row is locked for the duration, so when two workers finish a rendition's last two
 * chunks at the same moment, exactly one of them sees the rendition complete and publishes it.
 */
export async function syncVideo(videoId: string) {
  // Events are recorded after the commit, so the dashboard never shows a rendition the database hasn't published.
  const events: [string, Record<string, unknown>][] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ encode_plan: EncodePlan | null; renditions: { name: string; bandwidth?: number }[]; status: string }>(
      "SELECT encode_plan, renditions, status FROM videos WHERE id = $1 FOR UPDATE",
      [videoId],
    );
    const plan = rows[0]?.encode_plan;
    if (!plan) {
      await client.query("COMMIT");
      return;
    }
    const tasks = (
      await client.query<TaskRow>(
        "SELECT kind, tier, chunk, status, duration_seconds, error FROM encode_tasks WHERE video_id = $1 ORDER BY chunk",
        [videoId],
      )
    ).rows;
    const tierTasks = (tier: number) => tasks.filter((t) => t.kind === "video" && t.tier === tier);
    const tierDone = (tier: number) => tierTasks(tier).length === plan.chunks.length && tierTasks(tier).every((t) => t.status === "done");
    const audioTask = tasks.find((t) => t.kind === "audio");
    // If the audio failed for good, the video is still published, without sound, rather than not at all.
    const withAudio = plan.probe.hasAudio && audioTask?.status !== "failed";
    const audioDone = !plan.probe.hasAudio || audioTask?.status === "done" || audioTask?.status === "failed";
    const tierOf = (name: string) => plan.tiers.findIndex((names) => names.includes(name));

    // A rendition is playable once all its chunks and the audio are encoded. Stitching is only writing its playlist.
    const complete = plan.renditions.filter((r) => audioDone && tierDone(tierOf(r.name)));
    const published = new Set(rows[0].renditions.map((r) => r.name));
    const added = complete.filter((r) => !published.has(r.name));
    const dir = paths.videoDir(videoId);
    for (const r of added) {
      const durations = tierTasks(tierOf(r.name)).map((t) => t.duration_seconds ?? 0);
      await writeAtomic(path.join(dir, r.name, "index.m3u8"), mediaPlaylist(durations));
    }
    const summaries = complete.map((r) => summary(r, withAudio));
    // Rewrite the master playlist when a rendition joins it, or when its audio changes (a retry fixed the sound).
    const variants = (rs: { name: string; bandwidth?: number }[]) => JSON.stringify(rs.map((r) => [r.name, r.bandwidth]));
    if (added.length > 0 || (complete.length > 0 && variants(summaries) !== variants(rows[0].renditions))) {
      await writeAtomic(path.join(dir, "master.m3u8"), masterPlaylist(complete, withAudio));
    }

    // Progress counts encoded pixels: a 1080p chunk is worth far more than its 360p chunk.
    const pixels = (tier: number) => plan.renditions.filter((r) => tierOf(r.name) === tier).reduce((s, r) => s + r.width * r.height, 0);
    const videoTasks = tasks.filter((t) => t.kind === "video");
    const total = videoTasks.reduce((s, t) => s + pixels(t.tier), 0) || 1;
    const encoded = videoTasks.filter((t) => t.status === "done").reduce((s, t) => s + pixels(t.tier), 0);
    const finished = tasks.every((t) => t.status === "done" || t.status === "failed");
    const failed = tasks.find((t) => t.status === "failed");

    let status = "processing";
    let stage: string | null;
    if (finished) {
      // A rendition missing a chunk can't be played, but the ones that finished can: keep them, with the error.
      status = complete.length > 0 ? "ready" : "failed";
      stage = null;
    } else {
      const left = [...plan.renditions].reverse().filter((r) => !complete.includes(r)).map((r) => r.name);
      const leftTasks = videoTasks.filter((t) => t.status !== "done" && t.status !== "failed").length;
      stage = leftTasks === 0 ? "Encoding audio" : `Encoding ${range(left)} (${videoTasks.length - leftTasks}/${videoTasks.length} chunks)`;
    }
    await client.query(
      `UPDATE videos SET
         renditions = $2, status = $3, stage = $4,
         progress = CASE WHEN $3 = 'ready' THEN 100 ELSE $5 END,
         error = CASE WHEN $6::text IS NOT NULL THEN $6 ELSE error END,
         playable_at = CASE WHEN jsonb_array_length($2::jsonb) > 0 THEN COALESCE(playable_at, now()) END,
         ready_at = CASE WHEN $3 = 'ready' THEN COALESCE(ready_at, now()) END
       WHERE id = $1`,
      [
        videoId,
        JSON.stringify(summaries),
        status,
        stage,
        Math.round(5 + (encoded / total) * 93),
        failed
          ? `${failed.kind === "audio" ? "Encoding the audio" : `Encoding chunk ${failed.chunk}`} failed: ${failed.error ?? "unknown error"}`
          : null,
      ],
    );
    await client.query("COMMIT");

    // Each rendition's share of its tier's chunks that are done, which the dashboard draws as its progress bar.
    const fractions = Object.fromEntries(
      plan.renditions.map((r) => {
        const tier = tierTasks(tierOf(r.name));
        return [r.name, Number((tier.filter((t) => t.status === "done").length / (plan.chunks.length || 1)).toFixed(4))];
      }),
    );
    events.push(["encode_progress", { fractions }]);
    if (added.length > 0) events.push(["published", { renditions: complete.map((r) => r.name), added: added.map((r) => r.name) }]);
    if (status === "ready" && rows[0].status !== "ready") events.push(["ready", {}]);
    if (status === "failed" && rows[0].status !== "failed") {
      events.push(["failed", { error: failed?.error ?? "Every rendition is missing a chunk.", final: true, allTasksFinished: true }]);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  for (const [kind, data] of events) await recordEvent(videoId, kind, data);
}
