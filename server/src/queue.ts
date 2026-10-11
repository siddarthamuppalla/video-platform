import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

export const QUEUE_NAME = "transcode";
export type TranscodeJob = { videoId: string };

// BullMQ needs its own ioredis client; workers block on Redis, so retries must be unlimited.
export function redisConnection() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

let queue: Queue<TranscodeJob> | undefined;

export function transcodeQueue() {
  queue ??= new Queue<TranscodeJob>(QUEUE_NAME, { connection: redisConnection() });
  return queue;
}

export const JOB_ATTEMPTS = 2;
export const JOB_BACKOFF_MS = 5000;

export async function enqueueTranscode(videoId: string) {
  // jobId = videoId makes enqueueing idempotent: completing an upload twice can't encode twice.
  await transcodeQueue().add("transcode", { videoId }, {
    jobId: videoId,
    attempts: JOB_ATTEMPTS,
    backoff: { type: "fixed", delay: JOB_BACKOFF_MS },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}
