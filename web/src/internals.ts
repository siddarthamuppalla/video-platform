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
        why: `The browser announces the file before sending any of it. The server chooses the piece size, so it knows exactly how long every piece must be: ${d.size} bytes ÷ ${d.chunkSize} = ${d.totalChunks} pieces. It saves a record of the upload right away, so if the connection drops at any point the upload can resume instead of starting over.`,
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
        why: `Each piece goes to its own numbered address, so sending it twice just replaces it with the same bytes; that is what makes retries safe (idempotent). The piece is written under a temporary name and then renamed, so a piece cut off halfway is never mistaken for a complete one. The database row records that this piece arrived, which is how a resumed upload knows what is still missing.${typeof d.serverMs === "number" ? ` The server spent ${d.serverMs} ms on this request after the bytes arrived.` : ""}`,
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
            ? "The browser has said it is done. The server first checks that every piece really arrived, then joins them by number, because they may have arrived out of order. It reads one piece at a time, so memory use stays small even for a very large file."
            : `The rebuilt file's size is checked against the size announced at the start (${formatBytes(d.size)}), which catches any missing or damaged piece before encoding. The pieces are then deleted because the whole file now exists.`,
      };
    case "queued":
      return {
        nodes: ["api", "postgres", "redis"],
        edges: ["api-postgres", "api-redis"],
        ops: [
          { layer: "SQL", text: "UPDATE videos SET status = 'queued', stage = 'Waiting for encoder';" },
          { layer: "Queue", text: `BullMQ Queue("${d.queue ?? "transcode"}").add("transcode", {videoId}, {jobId: "${d.jobId ?? "<videoId>"}", attempts: ${d.attempts ?? 2}, backoff: ${d.backoffMs ?? 5000} ms})` },
        ],
        why: "The upload request finishes here and the browser gets its answer immediately. The encoding is handed off as a job to a queue in Redis, where it waits until a worker is free. The job is named after the video, so even if the upload were completed twice, the video would only be encoded once.",
      };
    case "encode_started":
      return {
        nodes: ["redis", "worker", "postgres"],
        edges: ["redis-worker", "worker-postgres"],
        ops: [
          { layer: "Queue", text: `Worker("${d.queue ?? "transcode"}", {concurrency: 1}) takes job ${d.jobId ?? ""}: attempt ${d.attempt ?? s.attempts} of ${d.maxAttempts ?? "?"}${d.pid ? `, worker pid ${d.pid}` : ""}` },
          { layer: "SQL", text: "UPDATE videos SET status = 'processing', progress = 0, error = NULL;" },
        ],
        why: "A separate worker process takes the job off the queue. It handles one video at a time because ffmpeg already uses every CPU core; two at once would just make both slower. If this attempt fails, the queue tries again after a short wait, and any qualities that were already finished are kept.",
      };
    case "probed":
      return {
        nodes: ["worker", "ffmpeg", "disk", "postgres"],
        edges: ["worker-ffmpeg", "ffmpeg-disk", "worker-postgres"],
        ops: [
          { layer: "Process", text: `ffprobe -v error -print_format json -show_format -show_streams ${s.job?.source ?? "source"}` },
          { layer: "SQL", text: `UPDATE videos SET duration_seconds = ${d.durationSeconds}, width = ${d.width}, height = ${d.height};` },
        ],
        why: `Everything that follows depends on these facts. The qualities to make are chosen from them (never larger than the original's ${Math.min(d.width, d.height)}p, because upscaling adds size without adding detail), the length decides how many segments there will be, and the audio check decides whether to include sound.`,
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
        why: "The picture is taken 10% of the way in, because the very first frame is often black. Asking ffmpeg to jump there before opening the file lets it skip straight to that point instead of decoding everything before it.",
      };
    }
    case "planned":
      return {
        nodes: ["worker", "ffmpeg"],
        edges: ["worker-ffmpeg"],
        ops: (d.groups ?? []).map((g: any) => ({ layer: "Process" as Layer, text: `${g.nice ? `nice -n ${g.nice} ` : ""}${(g.command as string[]).join(" ")}` })),
        why: `The worker now starts ffmpeg, the program that does the encoding. Each quality will be cut into ${d.segments} segments of ${d.segmentSeconds} seconds. The smallest quality gets its own ffmpeg run at full priority, so the video becomes watchable as early as possible. The larger qualities share a second run, which reads the original only once and resizes it for each, at a lower priority ("nice") so it never slows the first.`,
      };
    case "encode_progress":
      return {
        nodes: ["ffmpeg", "worker", "postgres"],
        edges: ["worker-ffmpeg", "worker-postgres"],
        ops: [
          { layer: "Process", text: "ffmpeg -progress pipe:1 → stdout: out_time_us=… (parsed as position / duration)" },
          { layer: "SQL", text: "UPDATE videos SET progress = …, stage = …;   (at most once a second)" },
        ],
        why: "ffmpeg reports how far through the video it is. The worker turns that into a percentage, weighted by picture size because a 1080p frame takes far more work than a 360p one, and saves it at most once a second to avoid flooding the database.",
      };
    case "segment":
      return {
        nodes: ["ffmpeg", "disk", "worker", "postgres"],
        edges: ["ffmpeg-disk", "worker-ffmpeg", "worker-postgres"],
        ops: [
          { layer: "Process", text: `stderr: [hls] Opening '${d.rendition}/segment_${pad(d.index + 1, 4)}.ts' for writing  ⇒ segment ${d.index} is closed` },
          { layer: "Disk", text: `${d.rendition}/segment_${pad(d.index, 4)}.ts  ${d.bytes ? `${d.bytes} bytes (${formatBytes(d.bytes)})` : ""}` },
        ],
        why: `ffmpeg announces when it starts writing the next segment, which tells the worker the previous one is complete. Every ${s.segmentSeconds} seconds ffmpeg is told to store a full picture (a keyframe), so every quality is cut at exactly the same moments. That is what lets a player switch quality between any two segments without a jump.${d.bytes && s.segmentSeconds ? ` This segment works out to about ${Math.round((d.bytes * 8) / s.segmentSeconds / 1000)} kilobits per second, including sound.` : ""}`,
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
        why: "This quality is now watchable. Its line is added to the master playlist, the index players read first. The file is written under a temporary name and renamed, so a player never reads half of it. Players are told not to cache the playlist, because it changes as qualities are added, but to cache segments for a year, because a finished segment never changes.",
      };
    case "ready":
      return {
        nodes: ["worker", "postgres", "redis"],
        edges: ["worker-postgres", "redis-worker"],
        ops: [
          { layer: "SQL", text: "UPDATE videos SET status = 'ready', progress = 100, ready_at = now();" },
          { layer: "Queue", text: "job completed; BullMQ keeps the last 100 completed jobs" },
        ],
        why: "Every quality is finished and the job is marked complete. The original upload stays on disk in case it is needed again, but it is never served to viewers.",
      };
    case "failed":
      return {
        nodes: ["worker", "redis", "postgres"],
        edges: ["redis-worker", "worker-postgres"],
        ops: [
          { layer: "Queue", text: d.final ? "job failed on its last attempt" : "job failed; BullMQ schedules a retry after the backoff" },
          { layer: "SQL", text: `UPDATE videos SET error = '${String(d.error).slice(0, 80)}', status = …;` },
        ],
        why: "If the video already has finished qualities it stays watchable: a retry keeps them, and if the last attempt also fails, the video is shown with the qualities it has.",
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
