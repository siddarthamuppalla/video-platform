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

export async function enqueueTranscode(videoId: string) {
  // jobId = videoId makes enqueueing idempotent: completing an upload twice can't encode twice.
  await transcodeQueue().add("transcode", { videoId }, {
    jobId: videoId,
    attempts: 2,
    backoff: { type: "fixed", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}
