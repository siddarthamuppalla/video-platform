import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

/** One job per video: probe it, plan its renditions and chunks, and fan the chunk tasks out to CHUNK_QUEUE. */
export const QUEUE_NAME = "transcode";
export type TranscodeJob = { videoId: string };

/** One job per encode task: a tier of one chunk, or a video's audio. Any number of workers can take these. */
export const CHUNK_QUEUE_NAME = "encode-chunk";
export type TaskKind = "video" | "audio";
export type ChunkJob = { videoId: string; kind: TaskKind; tier: number; chunk: number };

// BullMQ needs its own ioredis client; workers block on Redis, so retries must be unlimited.
export function redisConnection() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

let queue: Queue<TranscodeJob> | undefined;
let chunkQueue: Queue<ChunkJob> | undefined;
let connections: Redis[] = [];

function connect() {
  const c = redisConnection();
  connections.push(c);
  return c;
}

export function transcodeQueue() {
  queue ??= new Queue<TranscodeJob>(QUEUE_NAME, { connection: connect() });
  return queue;
}

export function encodeChunkQueue() {
  chunkQueue ??= new Queue<ChunkJob>(CHUNK_QUEUE_NAME, { connection: connect() });
  return chunkQueue;
}

export async function closeQueues() {
  await Promise.all([queue?.close(), chunkQueue?.close()]);
  // A queue doesn't close a connection it was handed.
  await Promise.all(connections.map((c) => c.quit()));
  queue = chunkQueue = undefined;
  connections = [];
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

export const taskJobId = (t: ChunkJob) => `${t.videoId}-${t.kind}-${t.tier}-${t.chunk}`;

/**
 * Lower runs first. Audio and the smallest rendition's chunks go ahead of everything else, across all videos,
 * so every new video becomes watchable before any video's bigger renditions take the workers. Within a priority,
 * jobs run in the order they were added: chunk 0, then chunk 1, and so on.
 */
export const priorityFor = (t: Pick<ChunkJob, "kind" | "tier">) => (t.kind === "audio" ? 1 : t.tier + 1);

export async function enqueueTasks(tasks: ChunkJob[]) {
  const q = encodeChunkQueue();
  // A task that failed for good keeps its job id in the failed set, where a re-add would be ignored. A retry of
  // the whole video re-queues it, so clear that record first.
  for (const t of tasks) {
    const old = await q.getJob(taskJobId(t));
    if (old && (await old.isFailed())) await old.remove();
  }
  await q.addBulk(
    tasks.map((t) => ({
      name: t.kind,
      data: t,
      opts: {
        jobId: taskJobId(t),
        priority: priorityFor(t),
        attempts: 3,
        backoff: { type: "fixed", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    })),
  );
}
