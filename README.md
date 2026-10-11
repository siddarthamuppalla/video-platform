# Reel

A small video platform built to learn how video sites actually move bytes around: chunked, resumable uploads, a background encoder that turns one file into several qualities (up to 4K), and a player that switches between them as your bandwidth changes.

It has accounts, uploads, a video list with search, a watch page with a quality menu, and a page for managing your own videos. The interface follows the [Reel design system](https://claude.ai/artifact/UXsCFyB3YWA4c3Da5YwGqk).

## Running it

```sh
docker compose up --build
```

Open http://localhost:8080, create an account and upload a video. The API also listens directly on http://localhost:4000.

To run without Docker you need Node 22, ffmpeg, Postgres 16 and Redis running locally:

```sh
cd server && npm install
npm run dev:api        # terminal 1, http://localhost:4000
npm run dev:worker     # terminal 2

cd web && npm install
npm run dev            # terminal 3, then open http://localhost:5173
```

The server reads `DATABASE_URL` (default `postgres://reel:reel@localhost:5432/reel`), `REDIS_URL` (default `redis://localhost:6379`), `STORAGE_DIR` (default `./data`), `CHUNK_SIZE` (default 5 MB), `MAX_UPLOAD_BYTES` (default 2 GB) and `ENCODE_CONCURRENCY` (chunk tasks a worker encodes at once, default one per core).

## How a video gets from your disk to the player

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as API
  participant D as Postgres
  participant Q as Redis queue
  participant W as Worker (ffmpeg)
  B->>A: POST /api/uploads (name, size)
  A->>D: create video + upload rows
  A-->>B: uploadId, chunkSize, totalChunks
  loop 3 chunks in flight
    B->>A: PUT /api/uploads/:id/chunks/:n
    A->>D: record chunk n
  end
  B->>A: POST /api/uploads/:id/complete
  A->>A: stitch chunks into source file
  A->>Q: enqueue transcode job
  W->>Q: take job: ffprobe, thumbnail, cut into 6 s chunks
  W->>Q: queue one task per chunk per tier, 360p first
  W->>W: workers encode chunks in parallel
  W->>D: last 360p chunk done: publish 360p (now playable), then the rest, then status = ready
  B->>A: GET /media/:id/master.m3u8, then segments
```

### 1. Chunked, resumable upload

`web/src/uploader.ts` and `server/src/uploads.ts`

A 2 GB file sent in one request fails completely if the connection drops at 99%. So the browser slices the file with `File.slice()` into 5 MB chunks and sends them separately, three at a time.

- **Announce.** `POST /api/uploads` sends the file name and size. The server picks the chunk size, works out how many chunks there are, and creates the video row straight away so it appears in "Your videos" while bytes are still arriving.
- **Send.** Each `PUT /api/uploads/:id/chunks/:n` carries raw bytes. The server checks the length (every chunk is full except the last), writes it to a temp file, and renames it into place, so a half-written chunk is never mistaken for a whole one. Each chunk gets a row in `upload_chunks`. Sending the same chunk twice just overwrites it, which makes retries safe.
- **Retry and resume.** A failed chunk is retried with exponential backoff (1 s, 2 s, 4 s). The upload id is saved in `localStorage` against the file's name, size and modified time. Pick the same file after a refresh and the client calls `GET /api/uploads/:id`, gets the list of chunks the server already has, and sends only the rest.
- **Complete.** `POST /api/uploads/:id/complete` refuses until every chunk is present, then appends the chunks in order into `videos/<id>/source.<ext>`, checks the total size, deletes the chunks and puts a job on the queue.

### 2. Chunked, parallel encoding

`server/src/worker.ts`, `pipeline.ts` and `transcode.ts`

Encoding takes far longer than an HTTP request should, so the API hands the work to workers through [BullMQ](https://docs.bullmq.io/) queues in Redis. Instead of encoding the whole file in one go, the video is cut into 6-second chunks and every chunk is encoded as its own task. Any number of worker processes can take tasks, so one video's chunks spread across all of them, the way YouTube and Netflix encode uploads ("split and stitch"). The design and the research behind it are in the [chunked encoding plan](https://claude.ai/code/artifact/05b845d3-11c0-4fab-add1-1071665cb1ee).

```mermaid
flowchart LR
  U[Upload complete] --> P[Planner job<br/>probe, thumbnail,<br/>chunk index]
  P --> T[(encode_tasks<br/>one row per task)]
  P --> Q[[encode-chunk queue<br/>priority 1: audio, 360p chunks<br/>priority 2: bigger chunks]]
  Q --> W1[Worker] & W2[Worker] & W3[Worker]
  W1 & W2 & W3 --> S[Publisher<br/>last chunk of a rendition?<br/>write its playlist]
  S --> M[master.m3u8]
```

**Step 1: plan** (the `transcode` job, one per video, `planVideo`). The planner:

1. **Probes** the file with `ffprobe` to get the duration, dimensions, start time and whether there is audio. Phone videos are often stored sideways with a rotation flag, so the width and height are swapped when the flag says 90° or 270°.
2. **Grabs a thumbnail** 10% of the way in, which skips black intro frames more often than the first frame does.
3. **Plans renditions** from the ladder: 2160p, 1440p, 1080p, 720p and 360p, capped at 16, 9, 5, 2.8 and 0.8 Mbps. It only uses rungs at or below the source's resolution, because upscaling adds bytes without adding detail, so a 4K upload gets all five and a 720p upload gets two. The number is the frame's short side, so a 1080×1920 phone video counts as 1080p. Each rung pins its H.264 profile and level (High 5.2 for 2160p, down to Main 4.0 for 720p and 360p), and the master playlist advertises the same values so players know in advance whether they can decode a rendition.
4. **Builds the chunk index**: chunk *i* covers source time [6*i*, 6*i* + 6), and the last chunk runs to the end (a leftover under a second joins the chunk before it). The chunks are virtual; the file is never cut up.
5. **Splits the work into tiers**: tier 0 is the smallest rendition on its own; tier 1 is every other rendition. One task is one tier of one chunk, plus one task for the audio. A 76 s 1080p video becomes 13 + 13 + 1 = 27 tasks.
6. **Records and queues the tasks**: one row per task in `encode_tasks` (the durable record), and one job per task on the `encode-chunk` queue. Audio and tier 0 go in at priority 1 and tier 1 at priority 2, so across every video in the queue, the 360p chunks are encoded before anyone's big renditions.

**Step 2: encode a chunk** (an `encode-chunk` job, `runTask`). One ffmpeg run per task:

- **Seek and cut exactly.** `-ss <start − 1> -copyts` jumps near the chunk keeping the source's own timestamps, and the `trim` filter keeps exactly the frames whose time is in the chunk. Neighbouring chunks never share or drop a frame, whatever the frame rate. (Cutting by `-ss`/`-t` alone duplicated a frame at some chunk edges of a 59.94 fps video, because 6 s isn't a whole number of frames there.)
- **Keep each frame's place on the timeline.** Timestamps are left as they are in the source, so segment 7 starts at 42 s and the player sees one continuous video. `-avoid_negative_ts disabled` stops the muxer from shifting the first chunk differently from the others.
- **Decode once, encode every rendition in the tier.** The trimmed frames are split into one scaler and encoder per rendition (`[0:v]trim=...,split=2[in0][in1];[in0]scale=1280:720[out0];...`), the way YouTube's "multiple output transcoding" does it.
- **One chunk is one segment.** Each output is exactly one `.ts` segment (`720p/segment_0007.ts`), written under a temporary name and renamed when ffmpeg finishes, so a crash never leaves half a segment. The segment's real length goes into its task row for the playlist.
- **Video only.** Audio is encoded once for the whole file by its own task (`audio/index.m3u8`), because AAC adds a short silence at the start of every encode, which would click at every chunk edge.

A worker process takes `ENCODE_CONCURRENCY` tasks at once (one per core by default), each with an equal share of the cores. A failed task is retried on its own up to 3 times, so a crash near the end of a long video costs one 6-second chunk instead of a whole rendition.

**Step 3: stitch and publish** (`syncVideo`, after every task, on whichever worker finished it). It locks the video's row, so when two workers finish a rendition's last two chunks at the same moment exactly one of them publishes it. When every chunk of a rendition (and the audio) is done, it writes that rendition's playlist from the recorded segment lengths and rewrites `master.m3u8` to include it (temp file and rename, so a player never reads half a playlist). Stitching is only writing a text file; no video is copied. The first publish makes the video **playable**: it appears on the home page and can be watched in 360p while larger qualities encode. When every task has finished the status becomes `ready`. If a task fails for good, the renditions that finished stay up and the error is kept for the owner. A finished master playlist looks like this:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=6025800,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2",NAME="1080p",AUDIO="audio"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3436400,RESOLUTION=1280x720,CODECS="avc1.4d4028,mp4a.40.2",NAME="720p",AUDIO="audio"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1082400,RESOLUTION=640x360,CODECS="avc1.4d4028,mp4a.40.2",NAME="360p",AUDIO="audio"
360p/index.m3u8
```

Every rendition's segments come from the same chunks, so they start at the same timestamps and each begins with a keyframe. That alignment is what lets a player jump from 720p segment 4 to 360p segment 5 without a glitch. `BANDWIDTH` is each rendition's peak (its bitrate cap plus audio and ~10% container overhead), which is what the player budgets for.

If the planning job fails it is retried once. A retry of a video keeps every task that already finished, so the renditions it published stay watchable.

To spread one video over more machines, run more `worker` processes against the same Postgres, Redis and storage. With Docker on one machine that adds no cores, so the default is one worker using every core.

#### Why chunks, and what they cost

Measured on a 4-core machine with the 76 s 1080p60 clip from [intel-iot-devkit/sample-videos](https://github.com/intel-iot-devkit/sample-videos) (`worker-zone-detection.mp4`), using `server/bench/encode-strategies.mjs`:

| Strategy | 360p playable | All done |
|---|---|---|
| Before: 360p alone + every other rendition in one process at lower priority, target bitrate | 38.6 s | 115.2 s |
| Same, capped CRF | 36.7 s | 101.4 s |
| **Chunked, capped CRF, 4 tasks at once (used)** | **24.6 s** | **109.2 s** |
| The real pipeline end to end (queue, Postgres, publisher), same settings | 25.6 s | 106.8 s |

On one machine, chunking gets 360p out about 1.5 times sooner: today's 360p process had to share the CPU with the big renditions, while now all four cores work only on 360p chunks until 360p is done. The total is about 8% slower than one whole-file process, because every task pays ffmpeg's start-up, a seek and some wasted decoding, and there are no extra cores to win that back. The real win is on more than one machine. Each chunk's encode took about 2.5 s for 360p and 8 s for 720p + 1080p on its own, so scheduling those times over several 4-core workers projects to:

| Workers | 360p playable | All done |
|---|---|---|
| 1 | 31.5 s | 134.7 s |
| 4 | 9.0 s | 36.7 s |
| 13 (one per chunk) | 2.6 s | 11.8 s |

That is a projection, not a measurement: it leaves out probing, the queue and shared storage. What matters is the shape: once there is a worker per chunk, the time to encode a video stops growing with its length.

**Quality.** Each chunk is encoded by a fresh encoder, so it can't plan bits across chunk edges. With a target bitrate (`-b:v`) that showed: the encoder starts every chunk with a cautious guess, and the first frames of each chunk came out at 43.3 dB PSNR against 50.6 dB in a whole-file encode, a faint pulse every 6 s. So the worker now uses **capped CRF** (`-crf 21` with each rung's bitrate as `-maxrate`), which aims for a constant quality and has no warm-up:

| 1080p, compared with the source frame by frame | Whole file | Chunked |
|---|---|---|
| Target bitrate 5 Mbps: average PSNR / first frames of each chunk | 49.0 dB / 50.6 dB | 48.3 dB / 43.3 dB |
| Capped CRF 21: average PSNR / first frames of each chunk | 45.3 dB / 47.4 dB | 45.2 dB / 46.3 dB |
| Capped CRF 21: size | 17.4 MB | 17.3 MB |

With capped CRF, chunking costs less than 0.1 dB on average. Capped CRF is also a lot smaller on easy footage like this static camera (17 MB instead of 49 MB at 1080p) while staying well above the ~40 dB where compression becomes hard to see; hard footage still gets up to the rung's cap.

**One known quirk.** Each segment is its own MPEG-TS file, so its continuity counters restart at 0. Players read segments independently and don't mind (hls.js checks them only inside a packet), but a tool that glues all the segments into one stream, like `ffmpeg -i master.m3u8`, warns "Packet corrupt" at each chunk edge while still decoding every frame. Packaging as fMP4 (CMAF) segments would remove this.

Run the benchmark yourself with `node server/bench/encode-strategies.mjs <video> <scratch dir> [strategy name prefix...]`; `RATE=crf` switches every strategy to capped CRF.

The result on disk:

```
data/videos/<id>/
  source.mp4          the reassembled upload (never served)
  thumbnail.jpg
  master.m3u8
  audio/index.m3u8  audio/segment_0000.ts ...    encoded once, shared by every rendition
  2160p/index.m3u8  2160p/segment_0000.ts  segment_0001.ts ...    one segment per chunk
  1440p/...
  1080p/...
  720p/...
  360p/...
```

### 3. Adaptive playback

`web/src/components/Player.tsx`

The API serves the HLS files as static files under `/media`. Playlists are sent with `no-cache` and segments with a one-year immutable cache, because a segment never changes once written. The watch page passes `master.m3u8` to [hls.js](https://github.com/video-dev/hls.js), which feeds segments to the `<video>` element through Media Source Extensions. On **Auto**, hls.js measures how fast each segment downloads and picks the rendition for the next one. Choosing a quality from the menu sets `hls.currentLevel`, which pins that rendition until you go back to Auto. Safari plays HLS natively and chooses quality itself, so the menu doesn't appear there.

A video can be watched while it is still encoding. Players read the master playlist once, so while the video is still `processing` the watch page polls it, and when a new rendition is published the player reloads the master playlist and carries on from the same position, playing or paused as before, with the same quality picked. The new quality then shows up in the menu and Auto can switch up to it.

### Accounts

`server/src/auth.ts`

Passwords are hashed with bcrypt. Signing in sets an `httpOnly`, `SameSite=Lax` cookie holding a random 32-byte token. The `sessions` table stores only the token's SHA-256 hash, so a leaked database can't be used to sign in. Uploads, editing and deleting require a session. Unfinished videos are visible only to their owner.

## Project layout

```
docker-compose.yml   postgres, redis, api, worker, web (nginx)
server/              Express API and encoding worker (one image, two commands)
  src/uploads.ts     chunked upload endpoints
  src/transcode.ts   ffprobe, the ladder, the chunk index, ffmpeg chunk and audio encoding, playlists
  src/pipeline.ts    plan a video, encode one chunk task, publish each rendition when its last chunk lands
  bench/             encode-strategies.mjs, the benchmark behind the encoding strategy
  src/worker.ts      consumes the planning and chunk queues
  test/              end to end test against real Postgres, Redis and ffmpeg
web/                 React + Vite frontend
  src/uploader.ts    the chunking and resume logic
  src/styles/        tokens and component styles copied from the design system
```

## Tests

```sh
cd server && npm test                 # unit tests: ladder, chunk index, ffmpeg arguments, playlists, upload chunk sizes
cd server && npm run test:integration # needs Postgres, Redis and ffmpeg: sign up, upload out of order, resume, chunked encode on real workers, seamless chunk edges, a failed chunk, fetch HLS
cd web && npm test                    # uploader retry and resume, formatting
```

CI runs all three on every pull request.

## Ideas for going further

- Store chunks and output in S3 or MinIO and have clients upload chunks straight to presigned URLs.
- Encode with hardware acceleration.
- Package as fMP4/CMAF (segments share one init segment and never restart MPEG-TS continuity counters) and add DASH alongside HLS.
- Add a checksum per chunk so the server can detect corruption, not just wrong lengths.
