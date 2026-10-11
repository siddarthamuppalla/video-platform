import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export type Probe = {
  durationSeconds: number;
  startSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Whether ffmpeg can seek in this container to the keyframe before a time. See chunkArgs. */
  seekable?: boolean;
};

// Containers with an index, where ffmpeg's input -ss lands on the keyframe at or before the time asked for. In
// MPEG-TS and other streams without one, it can land on the keyframe after it, which would drop a chunk's first frames.
const SEEKABLE = /\b(mov|mp4|matroska|webm)\b/;
export type Rung = { name: string; height: number; videoKbps: number; profile: "main" | "high"; level: string; codec: string };
export type PlannedRendition = Rung & { width: number };

/**
 * The ladder, highest first. Each source is encoded once per rung at or below its own size.
 * videoKbps is the rung's bitrate cap (see CRF). Profile and level are pinned per rung so the CODECS string
 * in the master playlist matches the stream.
 */
export const LADDER: Rung[] = [
  { name: "2160p", height: 2160, videoKbps: 16000, profile: "high", level: "5.2", codec: "avc1.640034" },
  { name: "1440p", height: 1440, videoKbps: 9000, profile: "high", level: "5.1", codec: "avc1.640033" },
  { name: "1080p", height: 1080, videoKbps: 5000, profile: "high", level: "4.2", codec: "avc1.64002a" },
  { name: "720p", height: 720, videoKbps: 2800, profile: "main", level: "4.0", codec: "avc1.4d4028" },
  { name: "360p", height: 360, videoKbps: 800, profile: "main", level: "4.0", codec: "avc1.4d4028" },
];
export const AUDIO_KBPS = 128;
/**
 * Segment length in seconds, which is also the chunk length: each chunk is encoded on its own and becomes exactly
 * one segment in every rendition, so all renditions cut at the same timestamps and players can switch at any boundary.
 */
export const SEGMENT_SECONDS = 6;
/**
 * Quality target. Capped CRF gives every frame the bits its content needs, up to the rung's bitrate cap. Unlike a
 * target bitrate it has no warm-up, so each independently encoded chunk starts at full quality (see the README).
 */
export const CRF = 21;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Never upscale: pick rungs no larger than the source, or one rung at the source's own size if it is tiny.
 * A rung's number is the frame's short side, as on other video sites, so a 1080x1920 phone video is "1080p".
 */
export function planRenditions(srcWidth: number, srcHeight: number): PlannedRendition[] {
  const short = Math.min(srcWidth, srcHeight);
  const fit = (r: Rung, side: number): PlannedRendition => {
    const scale = side / short;
    return { ...r, width: even(srcWidth * scale), height: even(srcHeight * scale) };
  };
  const rungs = LADDER.filter((r) => r.height <= short).map((r) => fit(r, r.height));
  if (rungs.length > 0) return rungs;
  const smallest = LADDER[LADDER.length - 1];
  return [{ ...fit(smallest, short), name: `${even(short)}p` }];
}

/**
 * Split a plan into encode tiers, smallest first. Tier 0 is the smallest rendition on its own, so the video
 * becomes playable as early as possible; tier 1 is the rest, which decode each chunk once between them.
 */
export function encodeGroups(plan: PlannedRendition[]): PlannedRendition[][] {
  const ascending = [...plan].sort((a, b) => a.width * a.height - b.width * b.height);
  return [ascending.slice(0, 1), ascending.slice(1)].filter((g) => g.length > 0);
}

export function bandwidthFor(r: { videoKbps: number }, hasAudio: boolean) {
  // Peak bits per second the player should budget for, with ~10% container overhead.
  return Math.round((r.videoKbps * 1.07 + (hasAudio ? AUDIO_KBPS : 0)) * 1000 * 1.1);
}

/** The master playlist is the entry point a player loads: one line per rendition, which it picks between by bandwidth. */
export function masterPlaylist(renditions: PlannedRendition[], hasAudio: boolean) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  // Audio is encoded once for the whole video and shared by every rendition, as its own playlist.
  if (hasAudio) lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"`);
  for (const r of renditions) {
    const codecs = hasAudio ? `${r.codec},mp4a.40.2` : r.codec;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(r, hasAudio)},RESOLUTION=${r.width}x${r.height},CODECS="${codecs}",NAME="${r.name}"${hasAudio ? ',AUDIO="audio"' : ""}`,
      `${r.name}/index.m3u8`,
    );
  }
  return lines.join("\n") + "\n";
}

export const segmentName = (index: number) => `segment_${String(index).padStart(4, "0")}.ts`;

/** A rendition's playlist: one line per chunk's segment, with the length that chunk actually came out at. */
export function mediaPlaylist(durations: number[]) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations) - 0.001)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  durations.forEach((d, i) => lines.push(`#EXTINF:${d.toFixed(6)},`, segmentName(i)));
  return [...lines, "#EXT-X-ENDLIST"].join("\n") + "\n";
}

/** A chunk covers source time [start, end). The last chunk runs to the end of the video, so its end is null. */
export type Chunk = { index: number; start: number; end: number | null };

/**
 * The chunk index: the video cut into SEGMENT_SECONDS pieces. A leftover shorter than a second is folded into the
 * chunk before it rather than becoming a tiny chunk of its own, which might hold no frames at all.
 */
export function planChunks(durationSeconds: number, seconds = SEGMENT_SECONDS): Chunk[] {
  let count = Math.max(1, Math.ceil(durationSeconds / seconds - 1e-9));
  if (count > 1 && durationSeconds - (count - 1) * seconds < 1) count -= 1;
  return Array.from({ length: count }, (_, index) => ({
    index,
    start: index * seconds,
    end: index === count - 1 ? null : (index + 1) * seconds,
  }));
}

type RunOptions = { signal?: AbortSignal };

function run(cmd: string, args: string[], opts: RunOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      err = (err + d).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

export async function probe(file: string): Promise<Probe> {
  const out = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const data = JSON.parse(out);
  const video = data.streams?.find((s: any) => s.codec_type === "video");
  if (!video) throw new Error("This file has no video stream.");
  const duration = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Couldn't read the video's duration.");
  // Phones record sideways and store a rotation flag. ffmpeg applies it while encoding, so swap the axes to match.
  const rotation = Math.abs(
    Number(video.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0),
  );
  const sideways = rotation === 90 || rotation === 270;
  return {
    durationSeconds: duration,
    // Most files start at 0, but some start later. ffmpeg shifts a whole-file encode to start at 0, so chunks do too.
    startSeconds: Number(data.format?.start_time) || 0,
    seekable: SEEKABLE.test(String(data.format?.format_name ?? "")),
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    hasAudio: data.streams.some((s: any) => s.codec_type === "audio"),
  };
}

const sec = (n: number) => n.toFixed(6);

/**
 * The ffmpeg arguments that encode one chunk into one segment per rendition, video only.
 *
 * - Seek a second early, keeping the source's own timestamps (-copyts), then cut exactly with the trim filter.
 *   trim keeps the frames whose time is in [start, end), so neighbouring chunks never share or drop a frame,
 *   whatever the frame rate. -ss counts from the file's start, while trim sees the source's timestamps, which
 *   include the start time. Files without an index (MPEG-TS) are read from the beginning instead of seeking.
 * - Keep each frame's real time in the video (shifted only by the file's start time), so segment 7 says it starts
 *   at 42 s and the player sees one continuous timeline. -avoid_negative_ts disabled stops the muxer from shifting
 *   the first chunk differently from the rest.
 * - Decode once and split for each rendition, as YouTube's "multiple output transcoding" does.
 */
export function chunkArgs(source: string, outDir: string, chunk: Chunk, rs: PlannedRendition[], src: Probe, threads = 0, tmp = ".tmp") {
  const from = src.startSeconds + chunk.start;
  const cut = `trim=start=${sec(from)}${chunk.end === null ? "" : `:end=${sec(src.startSeconds + chunk.end)}`}`;
  const graph = [
    `[0:v]${cut},setpts=PTS-${sec(src.startSeconds)}/TB,split=${rs.length}${rs.map((_, i) => `[in${i}]`).join("")}`,
    ...rs.map((r, i) => `[in${i}]scale=${r.width}:${r.height}[out${i}]`),
  ].join(";");
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    ...(src.seekable ? ["-ss", sec(Math.max(0, chunk.start - 1))] : []), "-copyts", "-i", source,
    "-filter_complex", graph,
    ...rs.flatMap((r, i) => [
      "-map", `[out${i}]`,
      "-c:v", "libx264", "-preset", "veryfast", "-threads", String(threads), "-profile:v", r.profile, "-level:v", r.level,
      "-pix_fmt", "yuv420p", "-crf", String(CRF), "-maxrate", `${Math.round(r.videoKbps * 1.07)}k`, "-bufsize", `${r.videoKbps * 2}k`,
      "-avoid_negative_ts", "disabled", "-f", "mpegts", path.join(outDir, r.name, `${segmentName(chunk.index)}${tmp}`),
    ]),
  ];
}

/** The ffmpeg arguments that encode the whole video's audio once, cut into segments of its own. */
export function audioArgs(source: string, outDir: string, dirName = "audio") {
  const dir = path.join(outDir, dirName);
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-i", source, "-map", "0:a:0",
    "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ac", "2", "-ar", "48000",
    "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, "segment_%04d.ts"), path.join(dir, "index.m3u8"),
  ];
}

async function segmentSeconds(file: string) {
  const out = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file]);
  const seconds = Number(out.trim().split("\n")[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Couldn't read the length of ${path.basename(file)}.`);
  return seconds;
}

/**
 * Encode one chunk into one segment per rendition. Segments are written under a temporary name and renamed only
 * once ffmpeg has finished, so a crash never leaves a half-written segment behind. The name is unique to this run,
 * so if the queue hands the same task to two workers at once (it re-delivers a job whose worker looked stalled),
 * neither overwrites the other's file mid-write; both produce the same segment and the last rename wins. Returns the chunk's real length
 * (the playlist needs it) and the bytes written, in total and per rendition.
 */
export async function encodeChunk(source: string, outDir: string, chunk: Chunk, rs: PlannedRendition[], src: Probe, opts: RunOptions & { threads?: number } = {}) {
  await Promise.all(rs.map((r) => fsp.mkdir(path.join(outDir, r.name), { recursive: true })));
  const tmp = `.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await run("ffmpeg", chunkArgs(source, outDir, chunk, rs, src, opts.threads, tmp), opts);
  } catch (err) {
    await Promise.all(rs.map((r) => fsp.rm(path.join(outDir, r.name, `${segmentName(chunk.index)}${tmp}`), { force: true })));
    throw err;
  }
  const segments: { rendition: string; bytes: number }[] = [];
  for (const r of rs) {
    const file = path.join(outDir, r.name, segmentName(chunk.index));
    await fsp.rename(`${file}${tmp}`, file);
    segments.push({ rendition: r.name, bytes: (await fsp.stat(file)).size });
  }
  return {
    durationSeconds: await segmentSeconds(path.join(outDir, rs[0].name, segmentName(chunk.index))),
    bytes: segments.reduce((sum, s) => sum + s.bytes, 0),
    segments,
  };
}

/**
 * Encode the whole soundtrack into audio/, through a folder of its own that is swapped in at the end. `keep` is
 * asked just before the swap; if it says no (another run already finished this task), the new files are dropped
 * and the published ones are left alone.
 */
export async function encodeAudio(source: string, outDir: string, opts: RunOptions & { keep?: () => Promise<boolean> } = {}) {
  const name = `audio.${randomUUID().slice(0, 8)}.tmp`;
  const tmp = path.join(outDir, name);
  await fsp.mkdir(tmp, { recursive: true });
  try {
    await run("ffmpeg", audioArgs(source, outDir, name), opts);
    const files = await fsp.readdir(tmp);
    const sizes = await Promise.all(files.map((f) => fsp.stat(path.join(tmp, f)).then((s) => s.size)));
    if (opts.keep && !(await opts.keep())) return { bytes: 0, kept: false };
    const dir = path.join(outDir, "audio");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmp, dir);
    return { bytes: sizes.reduce((a, b) => a + b, 0), kept: true };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

export async function makeThumbnail(source: string, outDir: string, src: Probe) {
  // Grab a frame 10% in, which skips black intro frames more often than frame 0 does.
  const at = Math.min(src.durationSeconds * 0.1, Math.max(0, src.durationSeconds - 0.1)).toFixed(2);
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", at, "-i", source,
    "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", path.join(outDir, "thumbnail.jpg"),
  ]);
}
