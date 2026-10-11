// End to end against real Postgres, Redis and ffmpeg: sign up, upload in chunks
// out of order, resume, complete, encode, then fetch the HLS output.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "reel-test-"));
process.env.STORAGE_DIR = storage;
process.env.CHUNK_SIZE = String(256 * 1024);

const { createApp } = await import("../src/app.js");
const { migrate } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { planVideo, runTask, taskFailed } = await import("../src/pipeline.js");
const { closeQueues, encodeChunkQueue } = await import("../src/queue.js");
const { startWorkers } = await import("../src/worker.js");
const { closeListener, recordEvent } = await import("../src/events.js");

const sample = path.join(storage, "sample.mp4");
const agent = request.agent(createApp());
let workers: { close(): Promise<void> } | undefined;

beforeAll(async () => {
  await migrate();
  // A 7 second 720p test pattern with a tone: two renditions (360p, then 720p), encoded in a few seconds.
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "7", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", sample,
  ]);
});

afterAll(async () => {
  await workers?.close();
  await closeQueues();
  await closeListener();
  await pool.end();
  fs.rmSync(storage, { recursive: true, force: true });
});

describe("upload to playback", () => {
  const name = `t${Date.now() % 1e8}`;
  let uploadId = "";
  let videoId = "";
  let chunkSize = 0;
  let totalChunks = 0;
  const file = () => fs.readFileSync(sample);
  const chunk = (i: number) => file().subarray(i * chunkSize, (i + 1) * chunkSize);

  it("rejects uploads from signed-out visitors", async () => {
    await request(createApp()).post("/api/uploads").send({ filename: "a.mp4", size: 10 }).expect(401);
  });

  it("creates an account and signs in", async () => {
    await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: "password123" }).expect(201);
    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.user.username).toBe(name);
  });

  it("starts an upload session", async () => {
    const res = await agent.post("/api/uploads").send({ filename: "test-pattern.mp4", size: file().length }).expect(201);
    ({ uploadId, videoId, chunkSize, totalChunks } = res.body);
    expect(totalChunks).toBe(Math.ceil(file().length / chunkSize));
    expect(totalChunks).toBeGreaterThan(2);
  });

  it("rejects a chunk of the wrong size", async () => {
    await agent.put(`/api/uploads/${uploadId}/chunks/0`).set("Content-Type", "application/octet-stream").send(Buffer.alloc(10)).expect(400);
  });

  it("accepts chunks in any order and refuses to complete while some are missing", async () => {
    for (let i = totalChunks - 1; i >= 1; i--) {
      await agent.put(`/api/uploads/${uploadId}/chunks/${i}`).set("Content-Type", "application/octet-stream").send(chunk(i)).expect(200);
    }
    const res = await agent.post(`/api/uploads/${uploadId}/complete`).expect(409);
    expect(res.body.error).toContain("chunk 0");
  });

  it("reports received chunks so the client can resume", async () => {
    const res = await agent.get(`/api/uploads/${uploadId}`).expect(200);
    expect(res.body.received).not.toContain(0);
    expect(res.body.received).toHaveLength(totalChunks - 1);
    await agent.put(`/api/uploads/${uploadId}/chunks/0`).set("Content-Type", "application/octet-stream").send(chunk(0)).expect(200);
  });

  it("reassembles the file byte for byte and queues it", async () => {
    await agent.post(`/api/uploads/${uploadId}/complete`).expect(200);
    const source = fs.readFileSync(path.join(storage, "videos", videoId, "source.mp4"));
    expect(source.equals(file())).toBe(true);
    const { body } = await agent.get(`/api/videos/${videoId}`).expect(200);
    expect(body.video.status).toBe("queued");
  });

  it("hides unfinished videos from other people", async () => {
    await request(createApp()).get(`/api/videos/${videoId}`).expect(404);
  });

  it("makes the video playable at 360p before 720p is done, then finishes both", async () => {
    // Watch the video the way a viewer's page would while it encodes.
    const seen: { status: string; renditions: string[]; master: string }[] = [];
    let encoding = true;
    const watching = (async () => {
      while (encoding) {
        const { body } = await agent.get(`/api/videos/${videoId}`);
        if (body.video?.hlsUrl) {
          const master = await agent.get(body.video.hlsUrl);
          seen.push({ status: body.video.status, renditions: body.video.renditions.map((r: { name: string }) => r.name), master: master.text });
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    // The upload queued a planning job. Starting workers picks it up, fans the chunks out and encodes them.
    workers = startWorkers({ concurrency: 2, log: false });
    try {
      for (let i = 0; i < 1200; i++) {
        const { body } = await agent.get(`/api/videos/${videoId}`);
        if (body.video.status === "ready" || body.video.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      encoding = false;
    }
    await watching;

    const early = seen.find((s) => s.status === "processing");
    expect(early?.renditions).toEqual(["360p"]);
    expect(early?.master).toContain("360p/index.m3u8");
    expect(early?.master).not.toContain("720p");

    const { body } = await agent.get(`/api/videos/${videoId}`).expect(200);
    expect(body.video.status).toBe("ready");
    expect(body.video.playable).toBe(true);
    expect(body.video.renditions.map((r: { name: string }) => r.name)).toEqual(["720p", "360p"]);
    expect(Math.round(body.video.durationSeconds)).toBe(7);

    const master = await agent.get(body.video.hlsUrl).expect(200);
    expect(master.headers["content-type"]).toContain("mpegurl");
    expect(master.text).toContain("360p/index.m3u8");
    expect(master.text).toContain("720p/index.m3u8");

    const media = await agent.get(`/media/${videoId}/360p/index.m3u8`).expect(200);
    const segments = media.text.split("\n").filter((l) => l.endsWith(".ts"));
    expect(segments.length).toBe(2); // 7 seconds cut into 6 second chunks
    await agent.get(`/media/${videoId}/360p/${segments[0]}`).expect(200);
    // Both renditions cut at the same timestamps, so players can switch between them at any segment.
    const hd = await agent.get(`/media/${videoId}/720p/index.m3u8`).expect(200);
    const durations = (text: string) => text.split("\n").filter((l) => l.startsWith("#EXTINF"));
    expect(durations(hd.text)).toEqual(durations(media.text));
    await agent.get(body.video.thumbnailUrl).expect(200);
  });

  it("encodes each chunk as its own task and stitches them into one continuous timeline", async () => {
    const { rows } = await pool.query(
      "SELECT kind, tier, chunk, status, duration_seconds FROM encode_tasks WHERE video_id = $1 ORDER BY kind, tier, chunk",
      [videoId],
    );
    // Audio once, then 2 chunks for 360p (tier 0) and 2 for 720p (tier 1).
    expect(rows.map((r) => `${r.kind} ${r.tier} ${r.chunk} ${r.status}`)).toEqual([
      "audio 0 0 done", "video 0 0 done", "video 0 1 done", "video 1 0 done", "video 1 1 done",
    ]);

    const dir = path.join(storage, "videos", videoId);
    const probe = (file: string, entries: string) =>
      execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", path.join(dir, file)]).toString().trim().split("\n")[0];
    for (const rung of ["360p", "720p"]) {
      // Segment 1 starts exactly where segment 0 ends, so the player sees no gap or overlap at the chunk edge.
      const [start0, length0] = probe(`${rung}/segment_0000.ts`, "stream=start_time,duration").split(",").map(Number);
      const start1 = Number(probe(`${rung}/segment_0001.ts`, "stream=start_time"));
      expect(start1).toBeCloseTo(start0 + length0, 3);
      // Every source frame lands in exactly one chunk: 7 s at 25 fps.
      const frames = ["segment_0000.ts", "segment_0001.ts"].map((f) =>
        Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path.join(dir, rung, f)]).toString().trim().split("\n")[0]),
      );
      expect(frames[0] + frames[1]).toBe(175);
    }

    // Audio is encoded once, as its own playlist that every rendition shares, starting with the video.
    const master = await agent.get(`/media/${videoId}/master.m3u8`).expect(200);
    expect(master.text).toContain('TYPE=AUDIO,GROUP-ID="audio"');
    const audio = await agent.get(`/media/${videoId}/audio/index.m3u8`).expect(200);
    const audioFirst = audio.text.split("\n").find((l) => l.endsWith(".ts"))!;
    await agent.get(`/media/${videoId}/audio/${audioFirst}`).expect(200);
    const videoStart = Number(probe("360p/segment_0000.ts", "stream=start_time"));
    expect(Number(probe(`audio/${audioFirst}`, "stream=start_time"))).toBeCloseTo(videoStart, 1);
  });

  it("keeps published renditions when the job runs again, as a retry would", async () => {
    const segment = path.join(storage, "videos", videoId, "720p", "segment_0000.ts");
    const before = fs.statSync(segment).mtimeMs;
    expect(await planVideo(videoId)).toEqual([]); // Every task is already done, so nothing is queued.
    expect(fs.statSync(segment).mtimeMs).toBe(before);
    const { body } = await agent.get(`/api/videos/${videoId}`).expect(200);
    expect(body.video.status).toBe("ready");
    expect(body.video.renditions).toHaveLength(2);
  });

  it("keeps the renditions that finished when a chunk fails for good", async () => {
    // Run this video's tasks by hand, with no workers, so one of them can fail on cue.
    await workers?.close();
    workers = undefined;
    const { rows } = await pool.query(
      "INSERT INTO videos (user_id, title, status) SELECT user_id, 'failing chunk', 'queued' FROM videos WHERE id = $1 RETURNING id",
      [videoId],
    );
    const id: string = rows[0].id;
    fs.mkdirSync(path.join(storage, "videos", id), { recursive: true });
    fs.copyFileSync(sample, path.join(storage, "videos", id, "source.mp4"));

    const tasks = await planVideo(id);
    expect(tasks.map((t) => `${t.kind} ${t.tier} ${t.chunk}`)).toEqual(["audio 0 0", "video 0 0", "video 0 1", "video 1 0", "video 1 1"]);
    for (const t of tasks.slice(0, 3)) await runTask(t);
    let { body } = await agent.get(`/api/videos/${id}`).expect(200);
    expect(body.video.status).toBe("processing");
    expect(body.video.renditions.map((r: { name: string }) => r.name)).toEqual(["360p"]);

    await taskFailed(tasks[3], "ffmpeg exited with 1", true);
    await runTask(tasks[4]);
    ({ body } = await agent.get(`/api/videos/${id}`).expect(200));
    expect(body.video.status).toBe("ready");
    expect(body.video.renditions.map((r: { name: string }) => r.name)).toEqual(["360p"]);
    expect(body.video.error).toBe("Encoding chunk 0 failed: ffmpeg exited with 1");
    const master = await agent.get(body.video.hlsUrl).expect(200);
    expect(master.text).not.toContain("720p");
    await encodeChunkQueue().obliterate({ force: true });
  });

  it("publishes the video without sound when only the audio fails", async () => {
    const { rows } = await pool.query(
      "INSERT INTO videos (user_id, title, status) SELECT user_id, 'failing audio', 'queued' FROM videos WHERE id = $1 RETURNING id",
      [videoId],
    );
    const id: string = rows[0].id;
    fs.mkdirSync(path.join(storage, "videos", id), { recursive: true });
    fs.copyFileSync(sample, path.join(storage, "videos", id, "source.mp4"));

    const tasks = await planVideo(id);
    for (const t of tasks.filter((t) => t.kind === "video")) await runTask(t);
    let { body } = await agent.get(`/api/videos/${id}`).expect(200);
    expect(body.video.renditions).toEqual([]); // Nothing is published while the audio is still pending.
    await taskFailed(tasks[0], "no audio decoder", true);
    ({ body } = await agent.get(`/api/videos/${id}`).expect(200));
    expect(body.video.status).toBe("ready");
    expect(body.video.renditions.map((r: { name: string }) => r.name)).toEqual(["720p", "360p"]);
    expect(body.video.error).toBe("Encoding the audio failed: no audio decoder");
    const master = await agent.get(body.video.hlsUrl).expect(200);
    expect(master.text).not.toContain("EXT-X-MEDIA");
    expect(master.text).not.toContain("mp4a");
    await encodeChunkQueue().obliterate({ force: true });
  });

  it("removes the folder of a video deleted while one of its tasks ran", async () => {
    const { rows } = await pool.query(
      "INSERT INTO videos (user_id, title, status) SELECT user_id, 'deleted mid-encode', 'queued' FROM videos WHERE id = $1 RETURNING id",
      [videoId],
    );
    const id: string = rows[0].id;
    const dir = path.join(storage, "videos", id);
    fs.mkdirSync(path.join(dir, "360p"), { recursive: true });
    await pool.query("DELETE FROM videos WHERE id = $1", [id]);
    await taskFailed({ videoId: id, kind: "video", tier: 0, chunk: 0 }, "source.mp4: No such file or directory", true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("keeps the original upload private", async () => {
    await agent.get(`/media/${videoId}/source.mp4`).expect(404);
  });

  it("records every pipeline step in order for the dashboard to replay", async () => {
    const { body } = await agent.get(`/api/videos/${videoId}/pipeline`).expect(200);
    type Ev = { id: number; at: string; kind: string; data: any };
    const events: Ev[] = body.events;
    const kinds = events.map((e) => e.kind);
    const first = (kind: string) => kinds.indexOf(kind);

    // The upload: one event per chunk PUT, including the one rejected-size chunk never recorded.
    expect(kinds[0]).toBe("upload_started");
    expect(events[0].data.totalChunks).toBe(totalChunks);
    const chunks = events.filter((e) => e.kind === "chunk_received");
    expect(chunks.map((e) => e.data.index).sort((a, b) => a - b)).toEqual(Array.from({ length: totalChunks }, (_, i) => i));
    expect(chunks[chunks.length - 1].data.received).toBe(totalChunks);
    expect(chunks.every((e) => e.data.offset === e.data.index * chunkSize && e.data.serverMs >= 0)).toBe(true);

    // Then assembly, the queue and the plan, in that order.
    const order = ["assembly_started", "assembled", "queued", "encode_started", "probed", "thumbnail", "planned"].map(first);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(events.find((e) => e.kind === "queued")!.data).toMatchObject({ queue: "transcode", jobId: videoId, attempts: 2 });
    const planned = events.find((e) => e.kind === "planned")!;
    expect(planned.data.segments).toBe(2);
    expect(planned.data.tasks).toBe(5);
    expect(planned.data.renditions.map((r: any) => [r.name, r.group])).toEqual([["720p", 1], ["360p", 0]]);
    // One ffmpeg command per tier, shown for chunk 0 with paths relative to the video folder.
    expect(planned.data.groups.map((g: any) => [g.renditions, g.priority])).toEqual([[["360p"], 1], [["720p"], 2]]);
    expect(planned.data.groups[0].command.join(" ")).toContain("360p/segment_0000.ts");
    expect(planned.data.groups[0].command.join(" ")).not.toContain(storage);
    expect(planned.data.audio.command.join(" ")).not.toContain(storage);

    // Every task starts and finishes, and each chunk's segment lands before its rendition is published.
    const firstRun = events.slice(0, events.findIndex((e) => e.kind === "ready") + 1);
    const done = firstRun.filter((e) => e.kind === "task_done");
    expect(done.map((e) => `${e.data.kind} ${e.data.tier} ${e.data.chunk}`).sort()).toEqual([
      "audio 0 0", "video 0 0", "video 0 1", "video 1 0", "video 1 1",
    ]);
    expect(firstRun.filter((e) => e.kind === "task_started")).toHaveLength(5);
    const segments = (name: string) => firstRun.filter((e) => e.kind === "segment" && e.data.rendition === name);
    for (const name of ["360p", "720p"]) {
      // Chunks run in parallel, so their segments can finish in either order.
      expect(segments(name).map((e) => e.data.index).sort()).toEqual([0, 1]);
      expect(segments(name).every((e) => e.data.bytes > 0)).toBe(true);
      const published = firstRun.findIndex((e) => e.kind === "published" && e.data.added.includes(name));
      expect(Math.max(...segments(name).map((e) => firstRun.indexOf(e)))).toBeLessThan(published);
    }
    expect(firstRun.filter((e) => e.kind === "published").map((e) => e.data.added)).toEqual([["360p"], ["720p"]]);

    // The rerun above shows up as a second attempt that keeps both renditions.
    expect(kinds.filter((k) => k === "encode_started")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "planned")[1].data.renditions.every((r: any) => r.group === -1)).toBe(true);
    expect(kinds[kinds.length - 1]).toBe("ready");

    // Timestamps never go backwards.
    const times = events.map((e) => new Date(e.at).getTime());
    expect(times.every((t, i) => i === 0 || t >= times[i - 1])).toBe(true);
  });

  it("streams events live, picking up after the last one the browser saw", async () => {
    const server = createApp().listen(0);
    const { port } = server.address() as { port: number };
    const { body } = await agent.get(`/api/videos/${videoId}/pipeline`).expect(200);
    const lastId = body.events[body.events.length - 1].id;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/videos/${videoId}/pipeline/live?after=${lastId}`, { signal: controller.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      const next = async () => {
        while (!text.includes("data:")) text += (await reader.read()).value ?? "";
      };
      // Nothing new yet; record an event and it should arrive over the open stream.
      setTimeout(() => void recordEvent(videoId, "encode_started"), 100);
      await next();
      const event = JSON.parse(/data: (.*)/.exec(text)![1]);
      expect(event.kind).toBe("encode_started");
      expect(event.id).toBeGreaterThan(lastId);
      expect(text).toContain(`id: ${event.id}`);
    } finally {
      controller.abort();
      server.close();
    }
  });

  it("lists the finished video publicly", async () => {
    const { body } = await request(createApp()).get("/api/videos").query({ q: "test pattern" }).expect(200);
    expect(body.videos.map((v: { id: string }) => v.id)).toContain(videoId);
  });
});
