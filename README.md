# Reel

A small video platform for learning how uploading, encoding and adaptive streaming work.

## Running it

```sh
docker compose up --build
```

The API listens on http://localhost:4000. Uploaded and encoded files live in the `media` volume.

To run without Docker you need Node 22, ffmpeg, Postgres and Redis:

```sh
cd server
npm install
npm run dev:api      # terminal 1
npm run dev:worker   # terminal 2
```
