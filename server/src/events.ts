import pg from "pg";
import { config } from "./config.js";
import { query } from "./db.js";

/**
 * Every step a video takes through the pipeline is stored as one row in pipeline_events, in order.
 * The same rows drive the live dashboard (streamed as they land) and the replay afterwards.
 *
 *   upload_started    { size, chunkSize, totalChunks }
 *   chunk_received    { index, size, received, offset, serverMs }   one per chunk PUT, so a re-sent chunk shows twice
 *   assembly_started  { totalChunks, size }
 *   assembled         { size, file }
 *   queued            { queue, jobId, attempts, backoffMs }
 *   encode_started    { queue, jobId, attempt, maxAttempts, source, pid }   once per attempt
 *   probed            { width, height, durationSeconds, hasAudio }
 *   thumbnail         {}
 *   planned           { renditions: [{ name, width, height, videoKbps, bandwidth, codecs, group, nice }], segments, segmentSeconds }
 *                     group is the rendition's encode group (one per rendition, 0 is the smallest and runs at
 *                     full priority), or -1 if a retry kept it;
 *                     groups: [{ renditions, nice, command }] is each ffmpeg run's exact arguments
 *   encode_progress   { fractions: { [rendition]: 0..1 } }   at most once a second
 *   segment           { rendition, index, bytes }         an HLS segment finished writing
 *   published         { renditions, added }               these renditions joined the master playlist
 *   ready             {}
 *   failed            { error, final }
 */
export type PipelineEvent = { id: number; at: Date; kind: string; data: Record<string, unknown> };

/** Recording is best effort: a failed write is logged and never fails the upload or encode it describes. */
export async function recordEvent(videoId: string, kind: string, data: Record<string, unknown> = {}) {
  try {
    await query("INSERT INTO pipeline_events (video_id, kind, data) VALUES ($1, $2, $3)", [videoId, kind, JSON.stringify(data)]);
  } catch (err) {
    console.error(`couldn't record ${kind} for ${videoId}: ${(err as Error).message}`);
  }
}

export async function eventsAfter(videoId: string, afterId = 0, limit = 5000) {
  const { rows } = await query<PipelineEvent>(
    "SELECT id, at, kind, data FROM pipeline_events WHERE video_id = $1 AND id > $2 ORDER BY id LIMIT $3",
    [videoId, afterId, limit],
  );
  return rows;
}

// Live updates: an insert trigger sends NOTIFY pipeline_events with the video id. The API holds one
// LISTEN connection and wakes the streams watching that video, which then read the new rows.
type Subscriber = { onEvent: () => void; onClose: () => void };
const subscribers = new Map<string, Set<Subscriber>>();
let listener: Promise<pg.Client> | undefined;

function listen() {
  listener ??= (async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    const drop = () => {
      // The connection is gone, so notifications would be missed. Close every stream; browsers reconnect
      // on their own and resume from the last event they saw.
      if (listener === undefined) return;
      listener = undefined;
      client.removeAllListeners();
      client.on("error", () => {});
      client.end().catch(() => {});
      for (const subs of subscribers.values()) for (const s of subs) s.onClose();
      subscribers.clear();
    };
    client.on("notification", (msg) => {
      for (const s of subscribers.get(msg.payload ?? "") ?? []) s.onEvent();
    });
    client.on("error", drop);
    client.on("end", drop);
    await client.connect();
    await client.query("LISTEN pipeline_events");
    return client;
  })().catch((err) => {
    listener = undefined;
    throw err;
  });
  return listener;
}

/** Call `onEvent` whenever a new event for this video is recorded. Returns the unsubscribe function. */
export async function subscribe(videoId: string, onEvent: () => void, onClose: () => void) {
  await listen();
  const sub = { onEvent, onClose };
  const subs = subscribers.get(videoId) ?? new Set();
  subs.add(sub);
  subscribers.set(videoId, subs);
  return () => {
    subs.delete(sub);
    if (subs.size === 0 && subscribers.get(videoId) === subs) subscribers.delete(videoId);
  };
}

export async function closeListener() {
  const pending = listener;
  listener = undefined;
  subscribers.clear();
  if (pending) await (await pending.catch(() => undefined))?.end();
}
