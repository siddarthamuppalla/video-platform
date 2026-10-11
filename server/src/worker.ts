import os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { query } from "./db.js";
import { recordEvent } from "./events.js";
import { migrate } from "./migrate.js";
import { planVideo, runTask, taskFailed } from "./pipeline.js";
import { CHUNK_QUEUE_NAME, QUEUE_NAME, redisConnection, type ChunkJob, type TranscodeJob } from "./queue.js";

const finalAttempt = (job: Job) => job.attemptsMade >= (job.opts.attempts ?? 1);

/**
 * Start consuming both queues in this process. Every worker process takes planning jobs and chunk tasks alike, so
 * running more of them, on this machine or others sharing the storage, spreads one video's chunks across all of them.
 */
export function startWorkers(opts: { concurrency?: number; log?: boolean } = {}) {
  const concurrency = opts.concurrency ?? config.encodeConcurrency;
  // Split the cores between the encodes running at once, so they don't fight over them.
  const threads = Math.max(1, Math.floor(os.availableParallelism() / concurrency));
  const log = opts.log === false ? () => {} : console.log;
  const connections = [redisConnection(), redisConnection()];

  // Planning is a probe and a thumbnail, so it barely touches the CPU.
  const planner = new Worker<TranscodeJob>(
    QUEUE_NAME,
    async (job) => {
      log(`planning ${job.data.videoId} (attempt ${job.attemptsMade + 1})`);
      const tasks = await planVideo(job.data.videoId, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 });
      log(`queued ${tasks.length} encode tasks for ${job.data.videoId}`);
    },
    { connection: connections[0], concurrency: 2 },
  );
  planner.on("failed", async (job, err) => {
    if (!job) return;
    console.error(`planning failed ${job.data.videoId}: ${err.message}`);
    const final = finalAttempt(job);
    // A video with published renditions stays watchable: a retry keeps them, and if the last attempt fails
    // it is marked ready with the qualities it has, keeping the error for its owner.
    await query(
      `UPDATE videos SET error = $3, stage = NULL,
         status = CASE WHEN jsonb_array_length(renditions) > 0 THEN (CASE WHEN $2::boolean THEN 'ready' ELSE 'processing' END)
                       WHEN $2::boolean THEN 'failed' ELSE 'queued' END
       WHERE id = $1`,
      [job.data.videoId, final, err.message.slice(0, 500)],
    );
    await recordEvent(job.data.videoId, "failed", { error: err.message.slice(0, 500), final });
  });

  const encoder = new Worker<ChunkJob>(
    CHUNK_QUEUE_NAME,
    async (job) => {
      const t = job.data;
      const started = Date.now();
      await runTask(t, { threads, attempt: job.attemptsMade + 1 });
      log(`encoded ${t.videoId} ${t.kind === "audio" ? "audio" : `tier ${t.tier} chunk ${t.chunk}`} in ${Date.now() - started} ms`);
    },
    { connection: connections[1], concurrency },
  );
  encoder.on("failed", async (job, err) => {
    if (!job) return;
    console.error(`encode task failed ${job.id}: ${err.message}`);
    await taskFailed(job.data, err.message, finalAttempt(job)).catch((e) => console.error(e));
  });

  return {
    async close() {
      await Promise.all([planner.close(), encoder.close()]);
      // Workers don't close a connection they were handed, so do it here or the process never exits.
      await Promise.all(connections.map((c) => c.quit()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate();
  startWorkers();
  console.log(`worker waiting for jobs (${config.encodeConcurrency} chunk tasks at a time)`);
}
