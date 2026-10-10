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
const { processVideo } = await import("../src/pipeline.js");
const { transcodeQueue } = await import("../src/queue.js");

const sample = path.join(storage, "sample.mp4");
const agent = request.agent(createApp());

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
  await transcodeQueue().close();
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
    await processVideo(videoId).finally(() => (encoding = false));
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
    expect(segments.length).toBe(2); // 7 seconds cut at 6 second boundaries
    await agent.get(`/media/${videoId}/360p/${segments[0]}`).expect(200);
    // Both renditions cut at the same timestamps, so players can switch between them at any segment.
    const hd = await agent.get(`/media/${videoId}/720p/index.m3u8`).expect(200);
    const durations = (text: string) => text.split("\n").filter((l) => l.startsWith("#EXTINF"));
    expect(durations(hd.text)).toEqual(durations(media.text));
    await agent.get(body.video.thumbnailUrl).expect(200);
  });

  it("keeps published renditions when the job runs again, as a retry would", async () => {
    const segment = path.join(storage, "videos", videoId, "720p", "segment_0000.ts");
    const before = fs.statSync(segment).mtimeMs;
    await processVideo(videoId);
    expect(fs.statSync(segment).mtimeMs).toBe(before);
    const { body } = await agent.get(`/api/videos/${videoId}`).expect(200);
    expect(body.video.status).toBe("ready");
    expect(body.video.renditions).toHaveLength(2);
  });

  it("keeps the original upload private", async () => {
    await agent.get(`/media/${videoId}/source.mp4`).expect(404);
  });

  it("lists the finished video publicly", async () => {
    const { body } = await request(createApp()).get("/api/videos").query({ q: "test pattern" }).expect(200);
    expect(body.videos.map((v: { id: string }) => v.id)).toContain(videoId);
  });
});
