import { describe, expect, it } from "vitest";
import { bandwidthFor, masterPlaylist, planRenditions } from "./transcode.js";

describe("planRenditions", () => {
  it("encodes every rung for a 1080p source", () => {
    expect(planRenditions(1920, 1080).map((r) => `${r.name} ${r.width}x${r.height}`)).toEqual([
      "1080p 1920x1080",
      "720p 1280x720",
      "360p 640x360",
    ]);
  });

  it("never upscales", () => {
    expect(planRenditions(1280, 720).map((r) => r.name)).toEqual(["720p", "360p"]);
  });

  it("keeps a tiny source at its own size", () => {
    expect(planRenditions(320, 240)).toEqual([{ name: "240p", width: 320, height: 240, videoKbps: 800 }]);
  });

  it("keeps dimensions even, which H.264 requires", () => {
    for (const r of planRenditions(1080, 1920)) {
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });
});

describe("masterPlaylist", () => {
  it("lists each rendition with bandwidth, resolution and its playlist path", () => {
    const plan = planRenditions(1280, 720);
    expect(masterPlaylist(plan, true)).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(plan[0], true)},RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",NAME="720p"`,
        "720p/index.m3u8",
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(plan[1], true)},RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2",NAME="360p"`,
        "360p/index.m3u8",
        "",
      ].join("\n"),
    );
  });

  it("drops the audio codec for silent videos", () => {
    expect(masterPlaylist(planRenditions(640, 360), false)).toContain('CODECS="avc1.4d401f"');
  });
});
