import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export type Probe = { durationSeconds: number; width: number; height: number; hasAudio: boolean };
export type Rung = { name: string; height: number; videoKbps: number };
export type PlannedRendition = { name: string; width: number; height: number; videoKbps: number };

/** The bitrate ladder. Each source is encoded once per rung at or below its own height. */
export const LADDER: Rung[] = [
  { name: "1080p", height: 1080, videoKbps: 5000 },
  { name: "720p", height: 720, videoKbps: 2800 },
  { name: "360p", height: 360, videoKbps: 800 },
];
export const AUDIO_KBPS = 128;
/** Segment length in seconds. Every rendition cuts at the same timestamps, so players can switch at any boundary. */
export const SEGMENT_SECONDS = 6;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Never upscale: pick rungs no taller than the source, or one rung at the source's own size if it is tiny. */
export function planRenditions(srcWidth: number, srcHeight: number): PlannedRendition[] {
  const fit = (r: Rung, h: number) => ({ name: r.name, height: even(h), width: even((srcWidth * h) / srcHeight), videoKbps: r.videoKbps });
  const rungs = LADDER.filter((r) => r.height <= srcHeight).map((r) => fit(r, r.height));
  if (rungs.length > 0) return rungs;
  const smallest = LADDER[LADDER.length - 1];
  return [{ ...fit(smallest, srcHeight), name: `${even(srcHeight)}p` }];
}

export function bandwidthFor(r: { videoKbps: number }, hasAudio: boolean) {
  // Peak bits per second the player should budget for, with ~10% container overhead.
  return Math.round((r.videoKbps * 1.07 + (hasAudio ? AUDIO_KBPS : 0)) * 1000 * 1.1);
}

/** The master playlist is the entry point a player loads: one line per rendition, which it picks between by bandwidth. */
export function masterPlaylist(renditions: PlannedRendition[], hasAudio: boolean) {
  const codecs = hasAudio ? "avc1.4d401f,mp4a.40.2" : "avc1.4d401f";
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const r of renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(r, hasAudio)},RESOLUTION=${r.width}x${r.height},CODECS="${codecs}",NAME="${r.name}"`,
      `${r.name}/index.m3u8`,
    );
  }
  return lines.join("\n") + "\n";
}

function run(cmd: string, args: string[], onStdout?: (chunk: string) => void) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      onStdout?.(d);
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
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    hasAudio: data.streams.some((s: any) => s.codec_type === "audio"),
  };
}

/** Encode one rendition to HLS: H.264 + AAC, cut into SEGMENT_SECONDS segments under `outDir/<name>/`. */
export async function encodeRendition(
  source: string,
  outDir: string,
  r: PlannedRendition,
  src: Probe,
  onProgress: (fraction: number) => void,
) {
  const dir = path.join(outDir, r.name);
  await fsp.mkdir(dir, { recursive: true });
  const args = [
    "-y", "-hide_banner", "-nostats", "-progress", "pipe:1",
    "-i", source,
    "-map", "0:v:0", ...(src.hasAudio ? ["-map", "0:a:0"] : []),
    "-vf", `scale=${r.width}:${r.height}`,
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
    "-b:v", `${r.videoKbps}k`, "-maxrate", `${Math.round(r.videoKbps * 1.07)}k`, "-bufsize", `${r.videoKbps * 2}k`,
    // A keyframe exactly every SEGMENT_SECONDS lines segment boundaries up across renditions.
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, "-sc_threshold", "0",
    ...(src.hasAudio ? ["-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ac", "2", "-ar", "48000"] : []),
    "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, "segment_%04d.ts"),
    path.join(dir, "index.m3u8"),
  ];
  let buffer = "";
  await run("ffmpeg", args, (chunk) => {
    buffer += chunk;
    const matches = [...buffer.matchAll(/out_time_us=(\d+)/g)];
    if (matches.length) {
      const us = Number(matches[matches.length - 1][1]);
      onProgress(Math.min(1, us / 1e6 / src.durationSeconds));
      buffer = buffer.slice(buffer.lastIndexOf("out_time_us="));
    }
  });
  onProgress(1);
}

export async function makeThumbnail(source: string, outDir: string, src: Probe) {
  // Grab a frame 10% in, which skips black intro frames more often than frame 0 does.
  const at = Math.min(src.durationSeconds * 0.1, Math.max(0, src.durationSeconds - 0.1)).toFixed(2);
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", at, "-i", source,
    "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", path.join(outDir, "thumbnail.jpg"),
  ]);
}
