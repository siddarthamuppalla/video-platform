import { describe, expect, it } from "vitest";
import { bandwidthFor, chunkArgs, encodeGroups, masterPlaylist, mediaPlaylist, planChunks, planRenditions } from "./transcode.js";

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
  it("lists each rendition with bandwidth, resolution, codec and its playlist path, sharing one audio playlist", () => {
    const plan = planRenditions(1280, 720);
    expect(masterPlaylist(plan, true)).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(plan[0], true)},RESOLUTION=1280x720,CODECS="avc1.4d4028,mp4a.40.2",NAME="720p",AUDIO="audio"`,
        "720p/index.m3u8",
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthFor(plan[1], true)},RESOLUTION=640x360,CODECS="avc1.4d4028,mp4a.40.2",NAME="360p",AUDIO="audio"`,
        "360p/index.m3u8",
        "",
      ].join("\n"),
    );
  });

  it("advertises High profile at a 4K level for 2160p", () => {
    expect(masterPlaylist(planRenditions(3840, 2160), true)).toContain('RESOLUTION=3840x2160,CODECS="avc1.640034,mp4a.40.2",NAME="2160p"');
  });

  it("drops the audio codec and audio group for silent videos", () => {
    const master = masterPlaylist(planRenditions(640, 360), false);
    expect(master).toContain('CODECS="avc1.4d4028",NAME="360p"\n');
    expect(master).not.toContain("TYPE=AUDIO");
  });
});

describe("planChunks", () => {
  const spans = (d: number) => planChunks(d).map((c) => [c.start, c.end]);

  it("cuts the timeline into 6 second chunks, the last one running to the end", () => {
    expect(spans(15.5)).toEqual([[0, 6], [6, 12], [12, null]]);
    expect(planChunks(15.5).map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("does not add an empty chunk when the length is a multiple of 6", () => {
    expect(spans(12)).toEqual([[0, 6], [6, null]]);
  });

  it("folds a leftover under a second into the chunk before it", () => {
    expect(spans(12.4)).toEqual([[0, 6], [6, null]]);
    expect(spans(13.2)).toEqual([[0, 6], [6, 12], [12, null]]);
  });

  it("keeps a short video as one chunk", () => {
    expect(spans(0.5)).toEqual([[0, null]]);
    expect(spans(4)).toEqual([[0, null]]);
  });
});

describe("mediaPlaylist", () => {
  it("lists one segment per chunk with its real length, and a target duration that covers the longest", () => {
    expect(mediaPlaylist([6.006, 5.989, 0.5]).split("\n")).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:7",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXTINF:6.006000,",
      "segment_0000.ts",
      "#EXTINF:5.989000,",
      "segment_0001.ts",
      "#EXTINF:0.500000,",
      "segment_0002.ts",
      "#EXT-X-ENDLIST",
      "",
    ]);
    expect(mediaPlaylist([6, 6, 6])).toContain("#EXT-X-TARGETDURATION:6\n");
  });
});

describe("encodeGroups", () => {
  const names = (w: number, h: number) => encodeGroups(planRenditions(w, h)).map((g) => g.map((r) => r.name));

  it("encodes the smallest rendition on its own first, then everything else together", () => {
    expect(names(3840, 2160)).toEqual([["360p"], ["720p", "1080p", "1440p", "2160p"]]);
    expect(names(1920, 1080)).toEqual([["360p"], ["720p", "1080p"]]);
    expect(names(1280, 720)).toEqual([["360p"], ["720p"]]);
  });

  it("has a single group when there is a single rendition", () => {
    expect(names(640, 360)).toEqual([["360p"]]);
    expect(encodeGroups([])).toEqual([]);
  });
});

describe("chunkArgs", () => {
  const src = { durationSeconds: 20, startSeconds: 0, width: 1920, height: 1080, hasAudio: true };
  const [small, rest] = encodeGroups(planRenditions(1920, 1080));
  const chunks = planChunks(20);
  const middle = chunks[1];
  const last = chunks[chunks.length - 1];

  it("seeks just before the chunk, cuts it exactly and keeps its place on the timeline", () => {
    const args = chunkArgs("/v/source.mp4", "/v", middle, rest, src);
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-i") + 2)).toEqual(["-ss", "5.000000", "-copyts", "-i", "/v/source.mp4"]);
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(
      "[0:v]trim=start=6.000000:end=12.000000,setpts=PTS-0.000000/TB,split=2[in0][in1];[in0]scale=1280:720[out0];[in1]scale=1920:1080[out1]",
    );
    expect(args.filter((a) => a === "-avoid_negative_ts")).toHaveLength(2);
  });

  it("decodes the chunk once and writes one segment per rendition, video only", () => {
    const args = chunkArgs("/v/source.mp4", "/v", middle, rest, src);
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    expect(args.filter((a) => a.endsWith(".tmp"))).toEqual(["/v/720p/segment_0001.ts.tmp", "/v/1080p/segment_0001.ts.tmp"]);
    expect(args).not.toContain("0:a:0");
    // Capped CRF: a quality target per output, with the rung's bitrate as a ceiling.
    expect(args.filter((a) => a === "-crf")).toHaveLength(2);
    expect(args[args.indexOf("-maxrate") + 1]).toBe("2996k");
  });

  it("runs the last chunk to the end of the file and offsets by the file's start time", () => {
    const args = chunkArgs("/v/source.mp4", "/v", last, small, { ...src, startSeconds: 1.5 });
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(
      "[0:v]trim=start=19.500000,setpts=PTS-1.500000/TB,split=1[in0];[in0]scale=640:360[out0]",
    );
  });

  it("does not seek before the start of the file", () => {
    const args = chunkArgs("/v/source.mp4", "/v", chunks[0], small, src);
    expect(args[args.indexOf("-ss") + 1]).toBe("0.000000");
  });
});
