import { formatBytes } from "./format";

/**
 * The pipeline dashboard's model. The server records every step a video takes (see server/src/events.ts);
 * `pipelineState` folds the first `count` of those events into what the dashboard draws, so the live view
 * and the replay are the same function at different points in time.
 */
export type PipelineEvent = { id: number; at: string; kind: string; data: any };

export type ChunkState = 0 | 1 | 2; // waiting, received, merged into the source file
export type Lane = {
  name: string;
  width: number;
  height: number;
  videoKbps: number;
  bandwidth: number;
  codecs: string;
  /** The ffmpeg run that encodes it, smallest first (0 runs at full priority); -1 was kept from an earlier attempt. */
  group: number;
  nice: number | null;
  fraction: number;
  /** Bytes of each finished segment, or null while it is still being written. */
  segments: (number | null)[];
  /** When each segment finished (ms since epoch). */
  segmentAt: (number | null)[];
  /** When this rendition's encode began: the plan that scheduled it. */
  startedAt: number | null;
  segmentsDone: number;
  publishedAt: number | null;
};
export type Stage = "upload" | "assemble" | "queue" | "probe" | "encode" | "ready" | "failed";
export const STAGES: { id: Stage; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "assemble", label: "Assemble" },
  { id: "queue", label: "Queue" },
  { id: "probe", label: "Inspect" },
  { id: "encode", label: "Encode" },
  { id: "ready", label: "Ready" },
];

export type PipelineState = {
  stage: Stage | null;
  /** ms since epoch of the first and the latest applied event. */
  startedAt: number | null;
  now: number | null;
  upload: null | {
    size: number;
    chunkSize: number;
    totalChunks: number;
    chunks: ChunkState[];
    /** Server time spent on each chunk's PUT, in ms (the latest attempt). */
    chunkMs: (number | null)[];
    /** When each chunk first arrived (ms since epoch). */
    chunkAt: (number | null)[];
    requests: number;
    received: number;
    bytes: number;
    resent: number;
    lastIndex: number | null;
    startedAt: number;
    lastAt: number;
  };
  assembly: null | { startedAt: number; doneAt: number | null; size: number };
  queuedAt: number | null;
  job: null | { queue: string; jobId: string; maxAttempts: number; backoffMs: number; attempt: number; pid: number | null; source: string | null };
  /** The ffmpeg runs of the latest plan, with their exact arguments. */
  groups: { renditions: string[]; nice: number; command: string[] }[];
  attempts: number;
  encodeStartedAt: number | null;
  plannedAt: number | null;
  probe: null | { width: number; height: number; durationSeconds: number; hasAudio: boolean };
  thumbnail: boolean;
  segmentSeconds: number;
  segmentCount: number;
  lanes: Lane[];
  playableAt: number | null;
  readyAt: number | null;
  failed: null | { error: string; final: boolean; at: number };
  /** Index of the latest encode_progress event applied, for interpolating between progress reports. */
  lastProgress: number;
};

const empty = (): PipelineState => ({
  stage: null,
  startedAt: null,
  now: null,
  upload: null,
  assembly: null,
  queuedAt: null,
  job: null,
  groups: [],
  attempts: 0,
  encodeStartedAt: null,
  plannedAt: null,
  probe: null,
  thumbnail: false,
  segmentSeconds: 6,
  segmentCount: 0,
  lanes: [],
  playableAt: null,
  readyAt: null,
  failed: null,
  lastProgress: -1,
});

export function pipelineState(events: PipelineEvent[], count = events.length): PipelineState {
  const s = empty();
  for (let i = 0; i < Math.min(count, events.length); i++) apply(s, events[i], i);
  return s;
}

function apply(s: PipelineState, e: PipelineEvent, i: number) {
  const at = new Date(e.at).getTime();
  s.startedAt ??= at;
  s.now = at;
  const d = e.data ?? {};
  switch (e.kind) {
    case "upload_started":
      s.stage = "upload";
      s.upload = {
        size: d.size,
        chunkSize: d.chunkSize,
        totalChunks: d.totalChunks,
        chunks: Array.from({ length: d.totalChunks }, () => 0 as ChunkState),
        chunkMs: Array.from({ length: d.totalChunks }, () => null),
        chunkAt: Array.from({ length: d.totalChunks }, () => null),
        requests: 0,
        received: 0,
        bytes: 0,
        resent: 0,
        lastIndex: null,
        startedAt: at,
        lastAt: at,
      };
      break;
    case "chunk_received": {
      const u = s.upload;
      if (!u || d.index < 0 || d.index >= u.totalChunks) break;
      if (u.chunks[d.index] === 0) {
        u.chunks[d.index] = 1;
        u.chunkAt[d.index] = at;
        u.bytes += d.size;
      } else {
        u.resent++;
      }
      u.received = d.received;
      u.requests++;
      if (typeof d.serverMs === "number") u.chunkMs[d.index] = d.serverMs;
      u.lastIndex = d.index;
      u.lastAt = at;
      break;
    }
    case "assembly_started":
      s.stage = "assemble";
      s.assembly = { startedAt: at, doneAt: null, size: d.size };
      break;
    case "assembled":
      if (s.assembly) s.assembly.doneAt = at;
      if (s.upload) s.upload.chunks.fill(2);
      break;
    case "queued":
      s.stage = "queue";
      s.queuedAt = at;
      s.job = { queue: d.queue ?? "transcode", jobId: d.jobId ?? "", maxAttempts: d.attempts ?? 1, backoffMs: d.backoffMs ?? 0, attempt: 0, pid: null, source: null };
      break;
    case "encode_started":
      s.stage = "probe";
      s.attempts++;
      s.encodeStartedAt = at;
      if (s.job) Object.assign(s.job, { attempt: d.attempt ?? s.attempts, pid: d.pid ?? null, source: d.source ?? null });
      s.failed = null;
      break;
    case "probed":
      s.probe = { width: d.width, height: d.height, durationSeconds: d.durationSeconds, hasAudio: d.hasAudio };
      break;
    case "thumbnail":
      s.thumbnail = true;
      break;
    case "planned": {
      s.stage = "encode";
      s.plannedAt = at;
      s.segmentSeconds = d.segmentSeconds;
      s.segmentCount = d.segments;
      s.groups = d.groups ?? [];
      const previous = new Map(s.lanes.map((l) => [l.name, l]));
      s.lanes = (d.renditions as any[])
        .map((r): Lane => {
          const kept = r.group < 0;
          const before = previous.get(r.name);
          return {
            name: r.name,
            width: r.width,
            height: r.height,
            videoKbps: r.videoKbps,
            bandwidth: r.bandwidth ?? 0,
            codecs: r.codecs ?? "",
            group: r.group,
            nice: r.nice,
            fraction: kept ? 1 : 0,
            // A kept rendition's segments are all on disk already; keep their sizes if this replay saw them.
            segments: kept
              ? Array.from({ length: d.segments }, (_, k) => before?.segments[k] ?? 0)
              : Array.from({ length: d.segments }, () => null),
            segmentAt: kept
              ? Array.from({ length: d.segments }, (_, k) => before?.segmentAt[k] ?? null)
              : Array.from({ length: d.segments }, () => null),
            startedAt: kept ? (before?.startedAt ?? null) : at,
            segmentsDone: kept ? d.segments : 0,
            publishedAt: kept ? (before?.publishedAt ?? null) : null,
          };
        })
        // Smallest first: that is the order they finish in.
        .sort((a, b) => a.width * a.height - b.width * b.height);
      break;
    }
    case "encode_progress":
      for (const lane of s.lanes) {
        const f = d.fractions?.[lane.name];
        if (typeof f === "number") lane.fraction = Math.max(lane.fraction, f);
      }
      s.lastProgress = i;
      break;
    case "segment": {
      const lane = s.lanes.find((l) => l.name === d.rendition);
      if (!lane || d.index < 0 || d.index >= lane.segments.length) break;
      if (lane.segments[d.index] === null) lane.segmentsDone++;
      lane.segments[d.index] = d.bytes ?? 0;
      lane.segmentAt[d.index] = at;
      break;
    }
    case "published":
      for (const name of d.added as string[]) {
        const lane = s.lanes.find((l) => l.name === name);
        if (!lane) continue;
        lane.fraction = 1;
        lane.publishedAt ??= at;
      }
      s.playableAt ??= at;
      break;
    case "ready":
      s.stage = "ready";
      s.readyAt = at;
      break;
    case "failed":
      s.failed = { error: d.error, final: d.final, at };
      if (d.final) s.stage = "failed";
      break;
  }
}

/**
 * How a lane is doing, from what has been recorded: how fast ffmpeg is going relative to the video's own
 * length, and the bitrate the written segments actually came out at versus the rung's target.
 */
export function laneMetrics(lane: Lane, fraction: number, durationSeconds: number, segmentSeconds: number, now: number | null) {
  const end = lane.publishedAt ?? now;
  const elapsed = lane.startedAt !== null && end !== null ? (end - lane.startedAt) / 1000 : 0;
  const speed = elapsed > 0 && lane.group >= 0 ? (fraction * durationSeconds) / elapsed : null;
  let bytes = 0;
  let seconds = 0;
  lane.segments.forEach((b, k) => {
    if (b === null || b === 0) return;
    bytes += b;
    // Every segment is segmentSeconds long except the last, which holds the remainder.
    seconds += k === lane.segments.length - 1 ? durationSeconds - k * segmentSeconds : segmentSeconds;
  });
  const kbps = seconds > 0 ? (bytes * 8) / seconds / 1000 : null;
  return { speed, kbps, bytes };
}

/** The renditions in the master playlist so far, listed the way the server writes it (largest first). */
export function masterPlaylistLines(lanes: Lane[]) {
  const published = lanes.filter((l) => l.publishedAt !== null).sort((a, b) => b.width * b.height - a.width * a.height);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const l of published) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${l.bandwidth},RESOLUTION=${l.width}x${l.height},CODECS="${l.codecs}",NAME="${l.name}"`,
      `${l.name}/index.m3u8`,
    );
  }
  return lines;
}

/**
 * Where each event sits on the replay clock, in ms from the first event. With `maxGap`, quiet stretches
 * (waiting in the queue, a paused upload) are shortened to that many ms so the replay keeps moving.
 */
export function replayTimes(events: PipelineEvent[], maxGap = Infinity) {
  const times: number[] = [];
  let t = 0;
  let prev: number | null = null;
  for (const e of events) {
    const at = new Date(e.at).getTime();
    if (prev !== null) t += Math.min(Math.max(0, at - prev), maxGap);
    times.push(t);
    prev = at;
  }
  return times;
}

/** How many events have happened by replay time `t`: the first index whose time is after `t`. */
export function eventsBy(times: number[], t: number) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Encode progress is reported about once a second. During a replay, ease each lane between the report
 * before `t` and the next one, so bars move smoothly instead of jumping.
 */
export function interpolatedFractions(state: PipelineState, events: PipelineEvent[], times: number[], count: number, t: number) {
  const out = new Map(state.lanes.map((l) => [l.name, l.fraction]));
  if (count === 0 || count >= events.length) return out;
  let next = count;
  while (next < events.length && events[next].kind !== "encode_progress" && events[next].kind !== "published") next++;
  if (next >= events.length || events[next].kind !== "encode_progress") return out;
  const from = state.lastProgress >= 0 ? times[state.lastProgress] : times[count - 1];
  const span = times[next] - from;
  const k = span > 0 ? Math.min(1, Math.max(0, (t - from) / span)) : 1;
  for (const lane of state.lanes) {
    const target = events[next].data.fractions?.[lane.name];
    if (typeof target === "number" && target > lane.fraction) out.set(lane.name, lane.fraction + (target - lane.fraction) * k);
  }
  return out;
}

/** One line for the event log, in the words the rest of the app uses. */
export function describeEvent(e: PipelineEvent, totalChunks?: number): string | null {
  const d = e.data ?? {};
  switch (e.kind) {
    case "upload_started":
      return `Upload started: ${d.totalChunks} chunks of ${formatBytes(d.chunkSize)}`;
    case "chunk_received":
      return `Chunk ${d.index} received (${d.received}${totalChunks ? ` / ${totalChunks}` : ""})`;
    case "assembly_started":
      return `Stitching ${d.totalChunks} chunks into one file`;
    case "assembled":
      return `Source file reassembled, ${formatBytes(d.size)}`;
    case "queued":
      return "Queued for the encoder";
    case "encode_started":
      return "Encoder picked up the video";
    case "probed":
      return `Read the file: ${d.width}×${d.height}, ${d.durationSeconds.toFixed(1)} s${d.hasAudio ? ", with audio" : ", no audio"}`;
    case "thumbnail":
      return "Thumbnail captured";
    case "planned": {
      const fresh = (d.renditions as any[]).filter((r) => r.group >= 0).map((r) => r.name);
      const kept = (d.renditions as any[]).filter((r) => r.group < 0).map((r) => r.name);
      return [fresh.length ? `Encoding ${fresh.join(", ")}` : "", kept.length ? `keeping ${kept.join(", ")}` : ""].filter(Boolean).join("; ") +
        ` in ${d.segments} segment${d.segments === 1 ? "" : "s"} each`;
    }
    case "segment":
      return `${d.rendition} segment ${d.index} written${d.bytes ? `, ${formatBytes(d.bytes)}` : ""}`;
    case "published":
      return `${(d.added as string[]).join(", ")} published. ${d.renditions.length === d.added.length ? "The video can play now." : `Qualities: ${d.renditions.join(", ")}.`}`;
    case "ready":
      return "Every quality is encoded";
    case "failed":
      return `Encoding failed: ${d.error}${d.final ? "" : " Retrying."}`;
    default:
      return null;
  }
}

/** Elapsed time for timecodes: 0.84 s, 12.3 s, 4:05. */
export function formatElapsed(ms: number) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
