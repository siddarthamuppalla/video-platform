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

The server reads `DATABASE_URL` (default `postgres://reel:reel@localhost:5432/reel`), `REDIS_URL` (default `redis://localhost:6379`), `STORAGE_DIR` (default `./data`), `CHUNK_SIZE` (default 5 MB) and `MAX_UPLOAD_BYTES` (default 2 GB).

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
  W->>Q: take job
  W->>W: ffprobe, thumbnail, encode 360p first and the rest alongside
  W->>D: publish 360p (now playable), progress, then status = ready
  B->>A: GET /media/:id/master.m3u8, then segments
```

### 1. Chunked, resumable upload

`web/src/uploader.ts` and `server/src/uploads.ts`

A 2 GB file sent in one request fails completely if the connection drops at 99%. So the browser slices the file with `File.slice()` into 5 MB chunks and sends them separately, three at a time.

- **Announce.** `POST /api/uploads` sends the file name and size. The server picks the chunk size, works out how many chunks there are, and creates the video row straight away so it appears in "Your videos" while bytes are still arriving.
- **Send.** Each `PUT /api/uploads/:id/chunks/:n` carries raw bytes. The server checks the length (every chunk is full except the last), writes it to a temp file, and renames it into place, so a half-written chunk is never mistaken for a whole one. Each chunk gets a row in `upload_chunks`. Sending the same chunk twice just overwrites it, which makes retries safe.
- **Retry and resume.** A failed chunk is retried with exponential backoff (1 s, 2 s, 4 s). The upload id is saved in `localStorage` against the file's name, size and modified time. Pick the same file after a refresh and the client calls `GET /api/uploads/:id`, gets the list of chunks the server already has, and sends only the rest.
- **Complete.** `POST /api/uploads/:id/complete` refuses until every chunk is present, then appends the chunks in order into `videos/<id>/source.<ext>`, checks the total size, deletes the chunks and puts a job on the queue.

### 2. Background encoding

`server/src/worker.ts`, `pipeline.ts` and `transcode.ts`

Encoding takes far longer than an HTTP request should, so the API hands the work to a separate worker through a [BullMQ](https://docs.bullmq.io/) queue in Redis. The job id is the video id, so a video can't be queued twice. A failed job is retried once before the video is marked failed with ffmpeg's error.

For each video the worker:

1. **Probes** the file with `ffprobe` to get the duration, dimensions and whether there is audio. Phone videos are often stored sideways with a rotation flag, so the width and height are swapped when the flag says 90° or 270°.
2. **Grabs a thumbnail** 10% of the way in, which skips black intro frames more often than the first frame does.
3. **Plans renditions** from the ladder: 2160p at 16 Mbps, 1440p at 9 Mbps, 1080p at 5 Mbps, 720p at 2.8 Mbps and 360p at 0.8 Mbps. It only uses rungs at or below the source's resolution, because upscaling adds bytes without adding detail, so a 4K upload gets all five and a 720p upload gets two. The number is the frame's short side, so a 1080×1920 phone video counts as 1080p. Each rung pins its H.264 profile and level (High 5.2 for 2160p, down to Main 4.0 for 720p and 360p), and the master playlist advertises the same values so players know in advance whether they can decode a rendition.
4. **Encodes the renditions, smallest first**, to H.264 and AAC with `ffmpeg -f hls`, which writes six-second `.ts` segments plus a playlist (`720p/index.m3u8`) listing them. **Every rendition gets its own ffmpeg process, and they all start at once**, each at a lower CPU priority than the one below it: 360p at normal priority, then `nice -n 10`, `15` and `19` for 720p, 1080p and the rest.

   Because of the priority steps the 360p encode gets the cores first and finishes almost as fast as it would alone, and each larger rendition finishes after the one below it, while whatever CPU is left is soaked up by the bigger ones, so nothing sits idle. Each quality is published the moment it is done: 360p, then 720p, then 1080p, instead of every quality above 360p arriving together at the end. Keyframes are forced every 6 seconds (`-force_key_frames expr:gte(t,n_forced*6)`) in every output, so every rendition's segments start at the same timestamps. That alignment is what lets a player jump from 720p segment 4 to 360p segment 5 without a glitch. Progress comes from ffmpeg's `-progress` output and is written to the database about once a second, weighted by each rendition's pixel count. If one process fails, the other is stopped.
5. **Publishes each rendition as soon as it is done.** The worker rewrites the master playlist, `master.m3u8`, to list every finished rendition (writing a temp file and renaming it, so a player never reads half a playlist) and saves the list in the `renditions` column. The first publish makes the video **playable**: it appears on the home page and can be watched in 360p while the larger qualities are still encoding. When the last rendition lands the status becomes `ready`. A finished master playlist looks like this:

   ```
   #EXTM3U
   #EXT-X-VERSION:3
   #EXT-X-STREAM-INF:BANDWIDTH=18972800,RESOLUTION=3840x2160,CODECS="avc1.640034,mp4a.40.2",NAME="2160p"
   2160p/index.m3u8
   #EXT-X-STREAM-INF:BANDWIDTH=10733800,RESOLUTION=2560x1440,CODECS="avc1.640033,mp4a.40.2",NAME="1440p"
   1440p/index.m3u8
   #EXT-X-STREAM-INF:BANDWIDTH=6025800,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2",NAME="1080p"
   1080p/index.m3u8
   ...
   ```

If the job fails and is retried, renditions that were already published are kept and not encoded again, so the video stays watchable during the retry. If the last attempt fails after 360p was published, the video stays up with the qualities it has, and the error is kept for its owner.

#### Why this encoding strategy

Before this, each rendition was encoded by its own ffmpeg process, largest first, and a video could only be watched once all of them were done. `server/bench/encode-strategies.mjs` times the alternatives with the same encoder settings (x264 `veryfast`, same bitrates and keyframes), on a 4-core machine:

| Strategy | 1080p clip, 76 s: playable / all done | 1080p clip, 33 s | 4K clip, 33 s |
|---|---|---|---|
| Before: one process per rendition, largest first | 75 s / 75 s | 26 s / 26 s | 155 s / 155 s |
| Same, smallest first | 15 s / 82 s | 5 s / 26 s | 16 s / 154 s |
| One process, decode once, all outputs | 60 s / 60 s | 20 s / 20 s | 101 s / 101 s |
| One process per rendition, all at once | 36 s / 64 s | 13 s / 22 s | 108 s / 152 s |
| Smallest alone, then the rest in one process | 14 s / 70 s | 5 s / 24 s | 16 s / 119 s |
| Smallest and the rest in one process, same priority | 27 s / 60 s | 10 s / 21 s | 52 s / 113 s |
| **Smallest and the rest in one process, rest at lower priority (used)** | **18 s / 60 s** | **6 s / 21 s** | **22 s / 113 s** |
| Three tiers (360p, 720p, the rest) at three priorities | not run | 7 s / 23 s | 27 s / 127 s |
| 360p `ultrafast` preview first, then everything in one process | 12 s / 73 s | 4 s / 26 s | 15 s / 119 s |

These measurements predate stepped publishing: "used" was 360p alone plus every larger rendition in one process at a lower priority. See [Publishing each quality as it finishes](#publishing-each-quality-as-it-finishes) for what changed and why.

"Playable" is when the first rendition is done; before this change a video wasn't watchable until everything was done. The chosen strategy makes a video watchable 4 to 7 times sooner and finishes the whole ladder 18 to 27% sooner. Decoding once is where the total saving comes from, and it grows with the source's resolution because decoding 4K is expensive. The fastest total (one process for everything) leaves nothing playable until the end; the priority split costs 12% on 4K to get 360p out in 22 s instead of 101 s. The 1080p clips are real footage from [intel-iot-devkit/sample-videos](https://github.com/intel-iot-devkit/sample-videos); the 4K clip is the 33 s one upscaled with light grain added, because no real 4K footage was reachable from the benchmark machine. Run it yourself with `node server/bench/encode-strategies.mjs <video> <scratch dir>`.

#### Publishing each quality as it finishes

The strategy above published 360p early but every larger quality together at the end, because one process encoded them all and its outputs advance in lockstep. Now each rendition has its own process and priority step, so each one is published as soon as it is done. Measured on a 4-core machine (a different one from the table above, so compare within this table only):

| | 360p | 720p | 1080p | 1440p | 2160p |
|---|---|---|---|---|---|
| 1080p clip, 76 s: 360p, then the rest in one process | 35.6 s | 102.7 s | 102.7 s | | |
| 1080p clip, 76 s: **one process per quality, stepped priority (used)** | **35.2 s** | **74.9 s** | **104.8 s** | | |
| 4K clip, 33 s: 360p, then the rest in one process | 50.5 s | 226.6 s | 226.6 s | 226.6 s | 226.6 s |
| 4K clip, 33 s: **one process per quality, stepped priority (used)** | **58.0 s** | **129.8 s** | **206.8 s** | **288.6 s** | **332.9 s** |

The tradeoff is decoding. One process for every larger quality decodes the source once; one process per quality decodes it once each.

- **Pro:** every quality in the middle arrives much sooner. 720p is watchable 28 s (27%) sooner on the 1080p clip and 97 s (43%) sooner on the 4K clip, and 1080p is 20 s sooner on 4K. A viewer on a decent connection gets a sharp picture far earlier.
- **Free for sources up to 1080p:** there, the extra decodes are cheap and the last quality lands within about 2% of the old time (104.8 s against 102.7 s).
- **Con for 4K sources:** decoding 4K is expensive, so doing it five times instead of twice makes the top qualities later: 1440p arrives 62 s later and 2160p 106 s (47%) later, and the whole job uses that much more CPU. The 4K test clip here is an upscale with heavy grain at about 200 Mbps, which is much harder to decode than typical 4K camera footage, so this is close to a worst case. Sharing one process between 1440p and 2160p won back only 33 s for 2160p and made 1440p 11 s later (both at 299.5 s), so every quality stays a separate step.

Run it with `node server/bench/encode-strategies.mjs <video> <scratch dir> niced stepped`.

The result on disk:

```
data/videos/<id>/
  source.mp4          the reassembled upload (never served)
  thumbnail.jpg
  master.m3u8
  2160p/index.m3u8  2160p/segment_0000.ts  segment_0001.ts ...
  1440p/...
  1080p/...
  720p/...
  360p/...
```

### 3. Adaptive playback

`web/src/components/Player.tsx`

The API serves the HLS files as static files under `/media`. Playlists are sent with `no-cache` and segments with a one-year immutable cache, because a segment never changes once written. The watch page passes `master.m3u8` to [hls.js](https://github.com/video-dev/hls.js), which feeds segments to the `<video>` element through Media Source Extensions. On **Auto**, hls.js measures how fast each segment downloads and picks the rendition for the next one. Choosing a quality from the menu sets `hls.currentLevel`, which pins that rendition until you go back to Auto. Safari plays HLS natively and chooses quality itself, so the menu doesn't appear there.

A video can be watched while it is still encoding. Players read the master playlist once, so while the video is still `processing` the watch page polls it, and when a new rendition is published the player reloads the master playlist and carries on from the same position, playing or paused as before, with the same quality picked. The new quality then shows up in the menu and Auto can switch up to it.

### 4. The pipeline dashboard

`server/src/events.ts`, `web/src/pages/Pipeline.tsx`

Every step a video takes is stored as a row in `pipeline_events` with a timestamp: the upload starting, each chunk arriving, assembly, the queue, probing, the encode plan, progress about once a second, each HLS segment as ffmpeg finishes writing it (read from ffmpeg's log, with its size), each rendition being published, and ready or failed. The API records the upload steps and the worker records the encode steps.

Open it from a video's page, from "Your videos", or with "Watch live" while uploading. While a video is still moving, the dashboard streams new events over Server-Sent Events: an insert trigger sends a Postgres `NOTIFY`, and the API, which holds one `LISTEN` connection, wakes the streams watching that video. A reconnecting browser resumes from the last event id it saw. Once a video is finished, the same rows replay as an animation, with a scrubber, speeds from 0.5× to 8×, and long waits shortened so the replay keeps moving. Both views run the same function over the events (`web/src/pipeline.ts`), so the replay shows exactly what the live view showed. It is meant to teach the system as much as to show progress: a diagram of the docker-compose services lights up the components and hops each step touches, "Under the hood" lists the HTTP request, SQL, file operations, queue call or process behind any event you pick (`web/src/internals.ts`), a real-time timeline shows stages and encodes overlapping with a tick per chunk and segment, and each quality shows its encode speed, measured bitrate and the exact ffmpeg command it ran. Videos uploaded before this was added have nothing to replay.

### Accounts

`server/src/auth.ts`

Passwords are hashed with bcrypt. Signing in sets an `httpOnly`, `SameSite=Lax` cookie holding a random 32-byte token. The `sessions` table stores only the token's SHA-256 hash, so a leaked database can't be used to sign in. Uploads, editing and deleting require a session. Unfinished videos are visible only to their owner.

## Project layout

```
docker-compose.yml   postgres, redis, api, worker, web (nginx)
server/              Express API and encoding worker (one image, two commands)
  src/uploads.ts     chunked upload endpoints
  src/transcode.ts   ffprobe, the bitrate ladder, ffmpeg HLS encoding, playlists
  src/pipeline.ts    one video's encode, start to finish, publishing each rendition as it lands
  src/events.ts      pipeline events: recording, and the LISTEN connection behind the live stream
  bench/             encode-strategies.mjs, the benchmark behind the encoding strategy
  src/worker.ts      queue consumer
  test/              end to end test against real Postgres, Redis and ffmpeg
web/                 React + Vite frontend
  src/uploader.ts    the chunking and resume logic
  src/pipeline.ts    folds pipeline events into what the dashboard draws, live or replayed
  src/styles/        tokens and component styles copied from the design system
```

## Tests

```sh
cd server && npm test                 # unit tests: ladder, playlists, chunk sizes
cd server && npm run test:integration # needs Postgres, Redis and ffmpeg: sign up, upload out of order, resume, encode, fetch HLS
cd web && npm test                    # uploader retry and resume, formatting, the dashboard's event model
```

CI runs all three on every pull request.

## Ideas for going further

- Store chunks and output in S3 or MinIO and have clients upload chunks straight to presigned URLs.
- Encode with hardware acceleration, or split a long video into pieces and encode them on several workers in parallel.
- Package as fMP4/CMAF and add DASH alongside HLS.
- Add a checksum per chunk so the server can detect corruption, not just wrong lengths.
