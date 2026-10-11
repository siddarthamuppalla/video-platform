// Times different ways of encoding the HLS ladder for one source video, using the worker's encoder settings.
// Usage: node encode-strategies.mjs <video> <scratch dir> [strategy name prefix...]
// Prints when the first rendition was done ("firstPlayable") and when all were done ("total"), in seconds.
// RATE=crf switches every strategy from a target bitrate to capped CRF 21, the setting the worker now uses.
// KEEP=1 leaves each strategy's output in the scratch dir, to compare quality afterwards.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LADDER = [
  { name: "2160p", height: 2160, kbps: 16000, profile: "high", level: "5.2" },
  { name: "1440p", height: 1440, kbps: 9000, profile: "high", level: "5.1" },
  { name: "1080p", height: 1080, kbps: 5000, profile: "high", level: "4.2" },
  { name: "720p", height: 720, kbps: 2800, profile: "main", level: "4.0" },
  { name: "360p", height: 360, kbps: 800, profile: "main", level: "4.0" },
];
const [source, outRoot, ...only] = process.argv.slice(2);
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", source]));
const v = probe.streams.find((s) => s.codec_type === "video");
const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const short = Math.min(v.width, v.height);
const plan = LADDER.filter((r) => r.height <= short).map((r) => ({
  ...r,
  w: even((v.width * r.height) / short),
  h: even((v.height * r.height) / short),
}));
const preset = process.env.PRESET || "veryfast";
const rate = (r) => (process.env.RATE === "crf" ? ["-crf", "21"] : ["-b:v", `${r.kbps}k`]);

function outputArgs(r, dir, videoLabel) {
  fs.mkdirSync(path.join(dir, r.name), { recursive: true });
  return [
    ...(videoLabel ? ["-map", videoLabel] : ["-map", "0:v:0", "-vf", `scale=${r.w}:${r.h}`]),
    ...(hasAudio ? ["-map", "0:a:0"] : []),
    "-c:v", "libx264", "-preset", r.preset ?? preset, "-profile:v", r.profile, "-level:v", r.level, "-pix_fmt", "yuv420p",
    ...rate(r), "-maxrate", `${Math.round(r.kbps * 1.07)}k`, "-bufsize", `${r.kbps * 2}k`,
    "-force_key_frames", "expr:gte(t,n_forced*6)", "-sc_threshold", "0",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"] : []),
    "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, r.name, "segment_%04d.ts"), path.join(dir, r.name, "index.m3u8"),
  ];
}

// One ffmpeg per rendition.
const single = (r, dir) => ["-y", "-v", "error", "-i", source, ...outputArgs(r, dir)];
// One ffmpeg for several renditions: decode once, split, scale each branch.
function multi(rs, dir) {
  const labels = rs.map((_, i) => `[s${i}]`).join("");
  const graph = [`[0:v]split=${rs.length}${labels}`, ...rs.map((r, i) => `[s${i}]scale=${r.w}:${r.h}[o${i}]`)].join(";");
  return ["-y", "-v", "error", "-i", source, "-filter_complex", graph, ...rs.flatMap((r, i) => outputArgs(r, dir, `[o${i}]`))];
}

function run(args, nice = 0) {
  return new Promise((resolve, reject) => {
    const c = nice ? spawn("nice", ["-n", String(nice), "ffmpeg", ...args], { stdio: ["ignore", "ignore", "inherit"] })
      : spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
}

// Chunked, as the worker does it: 6 s chunks cut exactly with trim, the smallest rendition's chunks first, then the
// rest decoded once per chunk, one task per core at a time, and the audio encoded once on the side.
const duration = Number(probe.format.duration);
const startTime = Number(probe.format.start_time) || 0;
const seekable = /\b(mov|mp4|matroska|webm)\b/.test(probe.format.format_name ?? "");
// The same chunk index as planChunks in src/transcode.ts: a leftover under a second joins the chunk before it.
let count = Math.max(1, Math.ceil(duration / 6 - 1e-9));
if (count > 1 && duration - (count - 1) * 6 < 1) count -= 1;
const chunks = Array.from({ length: count }, (_, i) => ({ start: i * 6, end: i === count - 1 ? null : (i + 1) * 6 }));
// The same arguments as chunkArgs in src/transcode.ts.
function chunkTask(c, i, rs, dir) {
  const at = (t) => (startTime + t).toFixed(6);
  const cut = `trim=start=${at(c.start)}${c.end === null ? "" : `:end=${at(c.end)}`},setpts=PTS-${startTime.toFixed(6)}/TB`;
  const graph = [`[0:v]${cut},split=${rs.length}${rs.map((_, j) => `[s${j}]`).join("")}`, ...rs.map((r, j) => `[s${j}]scale=${r.w}:${r.h}[o${j}]`)].join(";");
  for (const r of rs) fs.mkdirSync(path.join(dir, r.name), { recursive: true });
  return ["-y", "-v", "error", ...(seekable ? ["-ss", Math.max(0, c.start - 1).toFixed(6)] : []), "-copyts", "-i", source, "-filter_complex", graph, ...rs.flatMap((r, j) => [
    "-map", `[o${j}]`, "-c:v", "libx264", "-preset", preset, "-threads", "1", "-profile:v", r.profile, "-level:v", r.level, "-pix_fmt", "yuv420p",
    ...rate(r), "-maxrate", `${Math.round(r.kbps * 1.07)}k`, "-bufsize", `${r.kbps * 2}k`,
    "-avoid_negative_ts", "disabled", "-f", "mpegts", path.join(dir, r.name, `segment_${String(i).padStart(4, "0")}.ts`),
  ])];
}
async function chunked(dir, mark) {
  const tiers = [[...plan].reverse().slice(0, 1), [...plan].reverse().slice(1)].filter((t) => t.length);
  const tasks = [
    ...(hasAudio ? [{ args: ["-y", "-v", "error", "-i", source, "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-f", "hls", "-hls_time", "6", path.join(dir, "audio.m3u8")] }] : []),
    ...tiers.flatMap((rs, tier) => chunks.map((c, i) => ({ tier, args: chunkTask(c, i, rs, dir) }))),
  ];
  const left = tiers.map(() => chunks.length);
  let audioDone = !hasAudio;
  const published = new Set();
  const publish = () => tiers.forEach((rs, t) => {
    if (left[t] === 0 && audioDone && !published.has(t)) { published.add(t); rs.forEach((r) => mark(r.name)); }
  });
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      await run(t.args);
      if (t.tier === undefined) audioDone = true; else left[t.tier]--;
      publish();
    }
  };
  await Promise.all(Array.from({ length: os.availableParallelism() }, lane));
}

const asc = [...plan].reverse();
const smallest = asc[0];
const rest = asc.slice(1);
const strategies = {
  "current (largest first, one process each)": async (dir, mark) => {
    for (const r of plan) { await run(single(r, dir)); mark(r.name); }
  },
  "ascending (smallest first, one process each)": async (dir, mark) => {
    for (const r of asc) { await run(single(r, dir)); mark(r.name); }
  },
  "single pass (decode once, all outputs)": async (dir, mark) => {
    await run(multi(asc, dir)); asc.forEach((r) => mark(r.name));
  },
  "parallel (one process each, all at once)": async (dir, mark) => {
    await Promise.all(asc.map((r) => run(single(r, dir)).then(() => mark(r.name))));
  },
  "smallest, then single pass for the rest": async (dir, mark) => {
    await run(single(smallest, dir)); mark(smallest.name);
    if (rest.length) { await run(multi(rest, dir)); rest.forEach((r) => mark(r.name)); }
  },
  "smallest alongside single pass for the rest": async (dir, mark) => {
    await Promise.all([
      run(single(smallest, dir)).then(() => mark(smallest.name)),
      rest.length ? run(multi(rest, dir)).then(() => rest.forEach((r) => mark(r.name))) : null,
    ]);
  },
  "niced: smallest alongside single pass for the rest at lower priority": async (dir, mark) => {
    await Promise.all([
      run(single(smallest, dir)).then(() => mark(smallest.name)),
      rest.length ? run(multi(rest, dir), 10).then(() => rest.forEach((r) => mark(r.name))) : null,
    ]);
  },
  "tiered: smallest n0, next n5, rest single pass n10": async (dir, mark) => {
    const groups = [[asc[0]], asc.slice(1, 2), asc.slice(2)].filter((g) => g.length);
    await Promise.all(groups.map((g, i) => run(g.length === 1 ? single(g[0], dir) : multi(g, dir), i * 5).then(() => g.forEach((r) => mark(r.name)))));
  },
  "chunked: 6 s chunks, smallest rendition's chunks first, one task per core": chunked,
  "smallest ultrafast first, then single pass for all": async (dir, mark) => {
    await run(single({ ...smallest, preset: "ultrafast" }, dir)); mark(smallest.name + "(uf)");
    await run(multi(asc, dir)); asc.forEach((r) => mark(r.name));
  },
};

const results = [];
for (const [name, fn] of Object.entries(strategies)) {
  if (only.length && !only.some((o) => name.startsWith(o))) continue;
  const dir = path.join(outRoot, name.split(" ")[0] + "-" + results.length);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  const marks = {};
  await fn(dir, (n) => (marks[n] = (performance.now() - t0) / 1000));
  const total = (performance.now() - t0) / 1000;
  const firstPlayable = Math.min(...Object.values(marks));
  results.push({ name, total: +total.toFixed(1), firstPlayable: +firstPlayable.toFixed(1), marks });
  console.error(JSON.stringify(results.at(-1)));
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ source: path.basename(source), size: `${v.width}x${v.height}`, plan: plan.map((r) => r.name), results }));
