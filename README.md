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
  W->>W: ffprobe, thumbnail, encode each rendition
  W->>D: progress, then status = ready
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
4. **Encodes each rendition** to H.264 and AAC with `ffmpeg -f hls`, which writes six-second `.ts` segments plus a playlist (`720p/index.m3u8`) listing them. Keyframes are forced every 6 seconds (`-force_key_frames expr:gte(t,n_forced*6)`), so every rendition's segments start at the same timestamps. That alignment is what lets a player jump from 720p segment 4 to 360p segment 5 without a glitch. Progress comes from ffmpeg's `-progress` output and is written to the database about once a second, weighted by each rendition's pixel count.
5. **Writes the master playlist**, `master.m3u8`, which lists every rendition with its bandwidth and resolution:

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

### Accounts

`server/src/auth.ts`

Passwords are hashed with bcrypt. Signing in sets an `httpOnly`, `SameSite=Lax` cookie holding a random 32-byte token. The `sessions` table stores only the token's SHA-256 hash, so a leaked database can't be used to sign in. Uploads, editing and deleting require a session. Unfinished videos are visible only to their owner.

## Project layout

```
docker-compose.yml   postgres, redis, api, worker, web (nginx)
server/              Express API and encoding worker (one image, two commands)
  src/uploads.ts     chunked upload endpoints
  src/transcode.ts   ffprobe, the bitrate ladder, ffmpeg HLS encoding, playlists
  src/pipeline.ts    one video's encode, start to finish
  src/worker.ts      queue consumer
  test/              end to end test against real Postgres, Redis and ffmpeg
web/                 React + Vite frontend
  src/uploader.ts    the chunking and resume logic
  src/styles/        tokens and component styles copied from the design system
```

## Tests

```sh
cd server && npm test                 # unit tests: ladder, playlists, chunk sizes
cd server && npm run test:integration # needs Postgres, Redis and ffmpeg: sign up, upload out of order, resume, encode, fetch HLS
cd web && npm test                    # uploader retry and resume, formatting
```

CI runs all three on every pull request.

## Ideas for going further

- Store chunks and output in S3 or MinIO and have clients upload chunks straight to presigned URLs.
- Encode with hardware acceleration, or split a long video into pieces and encode them on several workers in parallel.
- Package as fMP4/CMAF and add DASH alongside HLS.
- Add a checksum per chunk so the server can detect corruption, not just wrong lengths.
