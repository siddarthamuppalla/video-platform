import { describe, expect, it } from "vitest";
import { eventsBy, interpolatedFractions, masterPlaylistLines, pipelineState, replayTimes, type PipelineEvent } from "./pipeline";

// A short run shaped like what the server records: 3 chunks, a queue wait, then 360p first and 720p after.
let id = 0;
const ev = (ms: number, kind: string, data: Record<string, unknown> = {}): PipelineEvent => ({
  id: ++id,
  at: new Date(Date.UTC(2026, 9, 11, 12, 0, 0) + ms).toISOString(),
  kind,
  data,
});
const plan = (group720: number, group360: number) => ({
  segments: 2,
  segmentSeconds: 6,
  renditions: [
    { name: "720p", width: 1280, height: 720, videoKbps: 2800, bandwidth: 3436000, codecs: "avc1.4d4028,mp4a.40.2", group: group720, nice: group720 < 0 ? null : 10 },
    { name: "360p", width: 640, height: 360, videoKbps: 800, bandwidth: 1082000, codecs: "avc1.4d4028,mp4a.40.2", group: group360, nice: group360 < 0 ? null : 0 },
  ],
});
const events = [
  ev(0, "upload_started", { size: 600, chunkSize: 256, totalChunks: 3 }),
  ev(100, "chunk_received", { index: 2, size: 88, received: 1 }),
  ev(200, "chunk_received", { index: 0, size: 256, received: 2 }),
  ev(250, "chunk_received", { index: 0, size: 256, received: 2 }),
  ev(300, "chunk_received", { index: 1, size: 256, received: 3 }),
  ev(310, "assembly_started", { totalChunks: 3, size: 600 }),
  ev(320, "assembled", { size: 600 }),
  ev(330, "queued"),
  ev(60_330, "encode_started"),
  ev(60_400, "probed", { width: 1280, height: 720, durationSeconds: 7, hasAudio: true }),
  ev(60_500, "thumbnail"),
  ev(60_510, "planned", plan(1, 0)),
  ev(61_510, "encode_progress", { fractions: { "360p": 0.5, "720p": 0.2 } }),
  ev(62_510, "encode_progress", { fractions: { "360p": 0.9, "720p": 0.6 } }),
  ev(62_600, "segment", { rendition: "360p", index: 0, bytes: 700 }),
  ev(62_700, "segment", { rendition: "360p", index: 1, bytes: 100 }),
  ev(62_710, "published", { renditions: ["360p"], added: ["360p"] }),
  ev(63_510, "encode_progress", { fractions: { "360p": 1, "720p": 0.95 } }),
  ev(63_700, "segment", { rendition: "720p", index: 0, bytes: 2000 }),
  ev(63_800, "segment", { rendition: "720p", index: 1, bytes: 300 }),
  ev(63_810, "published", { renditions: ["720p", "360p"], added: ["720p"] }),
  ev(63_820, "ready"),
];
const at = (kind: string) => events.findIndex((e) => e.kind === kind) + 1;

describe("pipelineState", () => {
  it("tracks chunks as they arrive, counting a re-sent one once", () => {
    const s = pipelineState(events, at("chunk_received") + 2);
    expect(s.stage).toBe("upload");
    expect(s.upload?.chunks).toEqual([1, 0, 1]);
    expect(s.upload?.bytes).toBe(344);
    expect(s.upload?.resent).toBe(1);
    expect(s.upload?.lastIndex).toBe(0);
  });

  it("merges every chunk into the source file once it is reassembled", () => {
    const s = pipelineState(events, at("assembled"));
    expect(s.stage).toBe("assemble");
    expect(s.upload?.chunks).toEqual([2, 2, 2]);
    expect(s.assembly?.doneAt! - s.assembly?.startedAt!).toBe(10);
  });

  it("lays out encode lanes smallest first with empty segments", () => {
    const s = pipelineState(events, at("planned"));
    expect(s.stage).toBe("encode");
    expect(s.lanes.map((l) => [l.name, l.group, l.segments])).toEqual([
      ["360p", 0, [null, null]],
      ["720p", 1, [null, null]],
    ]);
  });

  it("makes the video playable when the first rendition is published, before the rest are done", () => {
    const s = pipelineState(events, at("published"));
    const [small, large] = s.lanes;
    expect(small.segmentsDone).toBe(2);
    expect(small.publishedAt).not.toBeNull();
    expect(large.publishedAt).toBeNull();
    expect(large.fraction).toBe(0.6);
    expect(s.playableAt! - s.queuedAt!).toBe(62_380);
    expect(masterPlaylistLines(s.lanes)).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      '#EXT-X-STREAM-INF:BANDWIDTH=1082000,RESOLUTION=640x360,CODECS="avc1.4d4028,mp4a.40.2",NAME="360p"',
      "360p/index.m3u8",
    ]);
  });

  it("ends ready with every segment written and the master playlist largest first", () => {
    const s = pipelineState(events);
    expect(s.stage).toBe("ready");
    expect(s.lanes.every((l) => l.segmentsDone === 2 && l.publishedAt !== null)).toBe(true);
    expect(masterPlaylistLines(s.lanes).filter((l) => l.endsWith(".m3u8"))).toEqual(["720p/index.m3u8", "360p/index.m3u8"]);
  });

  it("shows a retry as a second attempt that keeps what was already published", () => {
    const retry = [...events, ev(70_000, "encode_started"), ev(70_100, "planned", plan(-1, -1))];
    const s = pipelineState(retry);
    expect(s.attempts).toBe(2);
    expect(s.lanes.every((l) => l.group === -1 && l.segmentsDone === 2 && l.publishedAt !== null)).toBe(true);
    expect(s.lanes[0].segments).toEqual([700, 100]);
  });

  it("only marks the video failed on the last attempt", () => {
    const failing = events.slice(0, at("planned"));
    expect(pipelineState([...failing, ev(61_000, "failed", { error: "boom", final: false })]).stage).toBe("encode");
    expect(pipelineState([...failing, ev(61_000, "failed", { error: "boom", final: true })]).stage).toBe("failed");
  });
});

describe("replay clock", () => {
  it("shortens idle stretches so a long queue wait doesn't stall the replay", () => {
    const real = replayTimes(events);
    const short = replayTimes(events, 1500);
    expect(real[real.length - 1]).toBe(63_820);
    // The 60 second queue wait becomes 1.5 seconds; nothing else changes.
    expect(short[short.length - 1]).toBe(63_820 - 60_000 + 1500);
  });

  it("finds how many events have happened at a point in time", () => {
    const times = replayTimes(events);
    expect(eventsBy(times, -1)).toBe(0);
    expect(eventsBy(times, 0)).toBe(1);
    expect(eventsBy(times, 305)).toBe(5);
    expect(eventsBy(times, 1e9)).toBe(events.length);
  });

  it("eases encode progress between reports", () => {
    const times = replayTimes(events);
    const t = (times[at("encode_progress") - 1] + times[at("encode_progress")]) / 2; // halfway between the first two reports
    const count = eventsBy(times, t);
    const f = interpolatedFractions(pipelineState(events, count), events, times, count, t);
    expect(f.get("360p")).toBeCloseTo(0.7);
    expect(f.get("720p")).toBeCloseTo(0.4);
  });
});
