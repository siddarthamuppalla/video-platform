import { Worker, type Job } from "bullmq";
import { query } from "./db.js";
import { migrate } from "./migrate.js";
import { processVideo } from "./pipeline.js";
import { QUEUE_NAME, redisConnection, type TranscodeJob } from "./queue.js";

async function handle(job: Job<TranscodeJob>) {
  console.log(`encoding ${job.data.videoId} (attempt ${job.attemptsMade + 1})`);
  await processVideo(job.data.videoId);
  console.log(`ready ${job.data.videoId}`);
}

await migrate();
const worker = new Worker<TranscodeJob>(QUEUE_NAME, handle, {
  connection: redisConnection(),
  // ffmpeg already uses every core; one job at a time keeps each encode fast.
  concurrency: 1,
});

worker.on("failed", async (job, err) => {
  if (!job) return;
  console.error(`failed ${job.data.videoId}: ${err.message}`);
  const final = job.attemptsMade >= (job.opts.attempts ?? 1);
  // A video with published renditions stays watchable: a retry keeps them, and if the last attempt fails
  // it is marked ready with the qualities it has, keeping the error for its owner.
  await query(
    `UPDATE videos SET error = $3, stage = NULL,
       status = CASE WHEN jsonb_array_length(renditions) > 0 THEN (CASE WHEN $2::boolean THEN 'ready' ELSE 'processing' END)
                     WHEN $2::boolean THEN 'failed' ELSE 'queued' END
     WHERE id = $1`,
    [job.data.videoId, final, err.message.slice(0, 500)],
  );
});

console.log("worker waiting for jobs");
