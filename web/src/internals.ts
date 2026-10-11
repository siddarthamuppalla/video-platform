import { formatBytes } from "./format";
import type { PipelineEvent, PipelineState } from "./pipeline";

/**
 * What each recorded event means in terms of the system: which components it passed through, and the
 * concrete operations behind it (HTTP requests, SQL, files, queue calls, processes). The dashboard's
 * architecture diagram and "Under the hood" panel are drawn from this.
 */
export type NodeId = "browser" | "nginx" | "api" | "postgres" | "disk" | "redis" | "worker" | "ffmpeg";
export type EdgeId =
  | "browser-nginx"
  | "nginx-api"
  | "api-postgres"
  | "api-disk"
  | "api-redis"
  | "redis-worker"
  | "worker-postgres"
  | "worker-ffmpeg"
  | "ffmpeg-disk"
  | "worker-disk";
export type Layer = "HTTP" | "SQL" | "Disk" | "Queue" | "Process" | "Player";
export type Op = { layer: Layer; text: string };
export type Explanation = { nodes: NodeId[]; edges: EdgeId[]; ops: Op[]; why: string };

const UPLOAD_HOPS = { nodes: ["browser", "nginx", "api"] as NodeId[], edges: ["browser-nginx", "nginx-api"] as EdgeId[] };
const pad = (n: number, width: number) => String(n).padStart(width, "0");

export function explainEvent(e: PipelineEvent, s: PipelineState): Explanation {
  const d = e.data ?? {};
  const u = s.upload;
  switch (e.kind) {
    case "upload_started":
      return {
        nodes: [...UPLOAD_HOPS.nodes, "postgres", "disk"],
        edges: [...UPLOAD_HOPS.edges, "api-postgres", "api-disk"],
        ops: [
          { layer: "HTTP", text: `POST /api/uploads  {"filename": "…", "size": ${d.size}}  → 201` },
          { layer: "SQL", text: "BEGIN; INSERT INTO videos (…) RETURNING id;" },
          { layer: "SQL", text: `INSERT INTO uploads (…, size, chunk_size, total_chunks) VALUES (…, ${d.size}, ${d.chunkSize}, ${d.totalChunks}); COMMIT;` },
          { layer: "Disk", text: "mkdir /data/uploads/<uploadId>/" },
        ],
        why: `The server picks the chunk size, so it can validate every chunk's length: ceil(${d.size} / ${d.chunkSize}) = ${d.totalChunks} chunks. The video row exists before any bytes arrive, which makes the upload resumable from the first chunk.`,
      };
    case "chunk_received": {
      const offset = d.offset ?? (u ? d.index * u.chunkSize : 0);
      return {
        nodes: [...UPLOAD_HOPS.nodes, "disk", "postgres"],
        edges: [...UPLOAD_HOPS.edges, "api-disk", "api-postgres"],
        ops: [
          { layer: "HTTP", text: `PUT /api/uploads/<id>/chunks/${d.index}  Content-Length: ${d.size}  (bytes ${offset}–${offset + d.size - 1})  → 200` },
          { layer: "Disk", text: `write ${pad(d.index, 6)}.part.<pid>.tmp, then rename → ${pad(d.index, 6)}.part` },
          { layer: "SQL", text: `INSERT INTO upload_chunks (upload_id, idx, size) VALUES (…, ${d.index}, ${d.size}) ON CONFLICT (upload_id, idx) DO UPDATE SET size = EXCLUDED.size;` },
          { layer: "SQL", text: `SELECT count(*) FROM upload_chunks WHERE upload_id = …;  → ${d.received}` },
        ],
        why: `PUT to a fixed index is idempotent: a retried chunk overwrites itself and the upsert keeps one row, so retries are always safe. The rename is atomic, so a half-written chunk is never mistaken for a whole one.${typeof d.serverMs === "number" ? ` The server spent ${d.serverMs} ms on this request once the body had arrived.` : ""}`,
      };
    }
    case "assembly_started":
    case "assembled":
      return {
        nodes: [...UPLOAD_HOPS.nodes, "postgres", "disk"],
        edges: [...UPLOAD_HOPS.edges, "api-postgres", "api-disk"],
        ops:
          e.kind === "assembly_started"
            ? [
                { layer: "HTTP", text: "POST /api/uploads/<id>/complete" },
                { layer: "SQL", text: `SELECT idx FROM upload_chunks WHERE upload_id = … ORDER BY idx;  → all ${d.totalChunks} present` },
                { layer: "Disk", text: `open /data/videos/<videoId>/source.<ext>; append 000000.part … ${pad(d.totalChunks - 1, 6)}.part in order` },
              ]
            : [
                { layer: "Disk", text: `stat ${d.file ?? "source"}  → ${d.size} bytes, matches the declared size` },
                { layer: "SQL", text: "UPDATE uploads SET completed_at = now();" },
                { layer: "Disk", text: "rm -r /data/uploads/<uploadId>/   (the parts are no longer needed)" },
                { layer: "SQL", text: "DELETE FROM upload_chunks WHERE upload_id = …;" },
              ],
        why:
          e.kind === "assembly_started"
            ? "Chunks may arrive in any order, so they are stitched by index. Only one chunk is held in memory at a time, so memory stays flat no matter how big the file is."
            : `The reassembled file is checked byte for byte against the size announced at the start (${formatBytes(d.size)}) before anything is queued.`,
      };
    case "queued":
      return {
        nodes: ["api", "postgres", "redis"],
        edges: ["api-postgres", "api-redis"],
        ops: [
          { layer: "SQL", text: "UPDATE videos SET status = 'queued', stage = 'Waiting for encoder';" },
          { layer: "Queue", text: `BullMQ Queue("${d.queue ?? "transcode"}").add("transcode", {videoId}, {jobId: "${d.jobId ?? "<videoId>"}", attempts: ${d.attempts ?? 2}, backoff: ${d.backoffMs ?? 5000} ms})` },
        ],
        why: "The HTTP request returns now; encoding happens in a separate worker process. Using the video id as the job id makes enqueueing idempotent, so completing an upload twice can't encode it twice. Redis holds the job until a worker is free.",
      };
    case "encode_started":
      return {
        nodes: ["redis", "worker", "postgres"],
        edges: ["redis-worker", "worker-postgres"],
        ops: [
          { layer: "Queue", text: `Worker("${d.queue ?? "transcode"}", {concurrency: 1}) takes job ${d.jobId ?? ""}: attempt ${d.attempt ?? s.attempts} of ${d.maxAttempts ?? "?"}${d.pid ? `, worker pid ${d.pid}` : ""}` },
          { layer: "SQL", text: "UPDATE videos SET status = 'processing', progress = 0, error = NULL;" },
        ],
        why: "The worker runs one job at a time because ffmpeg already uses every core; a second job would only slow both down. If this attempt throws, BullMQ retries it after the backoff, and renditions already published are kept.",
      };
    case "probed":
      return {
        nodes: ["worker", "ffmpeg", "disk", "postgres"],
        edges: ["worker-ffmpeg", "ffmpeg-disk", "worker-postgres"],
        ops: [
          { layer: "Process", text: `ffprobe -v error -print_format json -show_format -show_streams ${s.job?.source ?? "source"}` },
          { layer: "SQL", text: `UPDATE videos SET duration_seconds = ${d.durationSeconds}, width = ${d.width}, height = ${d.height};` },
        ],
        why: `Everything after this depends on the source: the rungs to encode (never above ${Math.min(d.width, d.height)}p, the short side), the segment count, and whether there is an audio track to map.`,
      };
    case "thumbnail": {
      const at = s.probe ? (s.probe.durationSeconds * 0.1).toFixed(2) : "10%";
      return {
        nodes: ["worker", "ffmpeg", "disk"],
        edges: ["worker-ffmpeg", "ffmpeg-disk"],
        ops: [
          { layer: "Process", text: `ffmpeg -ss ${at} -i ${s.job?.source ?? "source"} -frames:v 1 -vf scale=640:-2 -q:v 3 thumbnail.jpg` },
          { layer: "Disk", text: "write /data/videos/<videoId>/thumbnail.jpg" },
        ],
        why: "The frame is taken 10% in rather than at 0, which skips black intro frames more often. Seeking before -i makes ffmpeg jump to the nearest keyframe instead of decoding from the start.",
      };
    }
    case "planned":
      return {
        nodes: ["worker", "ffmpeg"],
        edges: ["worker-ffmpeg"],
        ops: (d.groups ?? []).map((g: any) => ({ layer: "Process" as Layer, text: `${g.nice ? `nice -n ${g.nice} ` : ""}${(g.command as string[]).join(" ")}` })),
        why: `${d.segments} segments of ${d.segmentSeconds} s per quality. The smallest rendition runs alone at full priority so the video becomes playable fast; the rest share one ffmpeg run that decodes the source once and splits the frames, at a lower CPU priority so they never slow the first one down.`,
      };
    case "encode_progress":
      return {
        nodes: ["ffmpeg", "worker", "postgres"],
        edges: ["worker-ffmpeg", "worker-postgres"],
        ops: [
          { layer: "Process", text: "ffmpeg -progress pipe:1 → stdout: out_time_us=… (parsed as position / duration)" },
          { layer: "SQL", text: "UPDATE videos SET progress = …, stage = …;   (at most once a second)" },
        ],
        why: "Progress is weighted by pixel count, so the overall bar moves at an even pace even though the renditions differ a lot in cost.",
      };
    case "segment":
      return {
        nodes: ["ffmpeg", "disk", "worker", "postgres"],
        edges: ["ffmpeg-disk", "worker-ffmpeg", "worker-postgres"],
        ops: [
          { layer: "Process", text: `stderr: [hls] Opening '${d.rendition}/segment_${pad(d.index + 1, 4)}.ts' for writing  ⇒ segment ${d.index} is closed` },
          { layer: "Disk", text: `${d.rendition}/segment_${pad(d.index, 4)}.ts  ${d.bytes ? `${d.bytes} bytes (${formatBytes(d.bytes)})` : ""}` },
        ],
        why: `ffmpeg forces a keyframe every ${s.segmentSeconds} s (-force_key_frames, -sc_threshold 0), so every rendition cuts at the same timestamps. That alignment is what lets a player switch quality at any segment boundary.${d.bytes && s.segmentSeconds ? ` This one averages ${Math.round((d.bytes * 8) / s.segmentSeconds / 1000)} kb/s including audio.` : ""}`,
      };
    case "published":
      return {
        nodes: ["worker", "disk", "postgres", "api", "nginx", "browser"],
        edges: ["worker-disk", "worker-postgres", "api-disk", "nginx-api", "browser-nginx"],
        ops: [
          { layer: "Disk", text: `write master.m3u8.tmp, then rename → master.m3u8  (${d.renditions.length} variant${d.renditions.length === 1 ? "" : "s"})` },
          { layer: "SQL", text: `UPDATE videos SET renditions = '[${(d.renditions as string[]).map((r) => `"${r}"`).join(", ")}]', playable_at = COALESCE(playable_at, now());` },
          { layer: "HTTP", text: "GET /media/<videoId>/master.m3u8   Cache-Control: no-cache" },
          { layer: "Player", text: `hls.js reloads the master playlist and adds ${(d.added as string[]).join(", ")} to its levels` },
        ],
        why: "The playlist is written to a temp file and renamed, so a player fetching it mid-write never sees half a file. Playlists are no-cache because they change; segments are cached for a year because they never do.",
      };
    case "ready":
      return {
        nodes: ["worker", "postgres", "redis"],
        edges: ["worker-postgres", "redis-worker"],
        ops: [
          { layer: "SQL", text: "UPDATE videos SET status = 'ready', progress = 100, ready_at = now();" },
          { layer: "Queue", text: "job completed; BullMQ keeps the last 100 completed jobs" },
        ],
        why: "Every rung is encoded. The source file stays on disk but is never served: /media refuses source.* paths.",
      };
    case "failed":
      return {
        nodes: ["worker", "redis", "postgres"],
        edges: ["redis-worker", "worker-postgres"],
        ops: [
          { layer: "Queue", text: d.final ? "job failed on its last attempt" : "job failed; BullMQ schedules a retry after the backoff" },
          { layer: "SQL", text: `UPDATE videos SET error = '${String(d.error).slice(0, 80)}', status = …;` },
        ],
        why: "A video that already has published renditions stays watchable: a retry keeps them, and after the last attempt it is marked ready with what it has.",
      };
    default:
      return { nodes: [], edges: [], ops: [], why: "" };
  }
}

/** How the dashboard itself hears about every event: the same path for all of them. */
export const DELIVERY = [
  "INSERT INTO pipeline_events (video_id, kind, data) …",
  "AFTER INSERT trigger → pg_notify('pipeline_events', video_id)",
  "API's LISTEN connection wakes this page's stream",
  "SELECT … WHERE id > last → SSE  id: <event id>",
];
