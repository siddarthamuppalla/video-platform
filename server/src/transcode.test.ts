import { describe, expect, it } from "vitest";
import { bandwidthFor, masterPlaylist, planRenditions } from "./transcode.js";

const summary = (w: number, h: number) => planRenditions(w, h).map((r) => `${r.name} ${r.width}x${r.height}`);

describe("planRenditions", () => {
  it("keeps every rung up to 2160p for a 4K source", () => {
    expect(summary(3840, 2160)).toEqual([
      "2160p 3840x2160",
      "1440p 2560x1440",
      "1080p 1920x1080",
      "720p 1280x720",
      "360p 640x360",
    ]);
  });

  it("tops out at 1440p for a 1440p source", () => {
    expect(planRenditions(2560, 1440).map((r) => r.name)).toEqual(["1440p", "1080p", "720p", "360p"]);
  });

  it("encodes 1080p and below for a 1080p source", () => {
    expect(summary(1920, 1080)).toEqual(["1080p 1920x1080", "720p 1280x720", "360p 640x360"]);
  });

  it("never upscales", () => {
    expect(planRenditions(1280, 720).map((r) => r.name)).toEqual(["720p", "360p"]);
    // Just short of 4K (a cropped 3840x2100) doesn't qualify for 2160p.
    expect(planRenditions(3840, 2100)[0].name).toBe("1440p");
  });

  it("names portrait videos by their short side", () => {
    expect(summary(2160, 3840)[0]).toBe("2160p 2160x3840");
    expect(summary(1080, 1920)).toEqual(["1080p 1080x1920", "720p 720x1280", "360p 360x640"]);
  });

  it("keeps a tiny source at its own size", () => {
    expect(summary(320, 240)).toEqual(["240p 320x240"]);
  });

  it("keeps dimensions even, which H.264 requires", () => {
    for (const r of [...planRenditions(1080, 1920), ...planRenditions(4096, 2160), ...planRenditions(1366, 768)]) {
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });
});

describe("masterPlaylist", () => {
  it("lists each rendition with bandwidth, resolution, codec and its playlist path", () => {
    const plan = planRenditions(1280, 720);
    expect(masterPlaylist(plan, true)).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(plan[0], true)},RESOLUTION=1280x720,CODECS="avc1.4d4028,mp4a.40.2",NAME="720p"`,
        "720p/index.m3u8",
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(plan[1], true)},RESOLUTION=640x360,CODECS="avc1.4d4028,mp4a.40.2",NAME="360p"`,
        "360p/index.m3u8",
        "",
      ].join("\n"),
    );
  });

  it("advertises High profile at a 4K level for 2160p", () => {
    expect(masterPlaylist(planRenditions(3840, 2160), true)).toContain('RESOLUTION=3840x2160,CODECS="avc1.640034,mp4a.40.2",NAME="2160p"');
  });

  it("drops the audio codec for silent videos", () => {
    expect(masterPlaylist(planRenditions(640, 360), false)).toContain('CODECS="avc1.4d4028"');
  });
});
