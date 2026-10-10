import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.js";
import { query } from "./db.js";
import {
  bandwidthFor,
  encodeRenditions,
  encodeGroups,
  makeThumbnail,
  masterPlaylist,
  planRenditions,
  probe,
  type PlannedRendition,
} from "./transcode.js";

/**
 * Each encode group after the first runs this many nice levels lower, so smaller renditions get the CPU
 * first. At 10 the low-priority process gets roughly a tenth of a contested core.
 */
const NICE_STEP = 10;

async function setProgress(videoId: string, progress: number, stage: string) {
  await query("UPDATE videos SET progress = $2, stage = $3 WHERE id = $1", [videoId, Math.round(progress), stage]);
}

/** Write to a temp file and rename, so a player fetching the playlist never reads a half-written one. */
async function writeAtomic(file: string, contents: string) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, file);
}

const summary = (r: PlannedRendition, hasAudio: boolean) => ({
  name: r.name,
  width: r.width,
  height: r.height,
  bandwidth: bandwidthFor(r, hasAudio),
});

export async function processVideo(videoId: string) {
  const dir = paths.videoDir(videoId);
  const source = (await fsp.readdir(dir)).find((f) => f.startsWith("source."));
  if (!source) throw new Error("The uploaded file is missing.");
  const sourcePath = path.join(dir, source);

  const { rows } = await query<{ renditions: { name: string }[] }>("SELECT renditions FROM videos WHERE id = $1", [videoId]);
  await query("UPDATE videos SET status = 'processing', progress = 0, stage = 'Reading file', error = NULL WHERE id = $1", [videoId]);
  const info = await probe(sourcePath);
  await query("UPDATE videos SET duration_seconds = $2, width = $3, height = $4 WHERE id = $1", [
    videoId, info.durationSeconds, info.width, info.height,
  ]);

  await setProgress(videoId, 2, "Making thumbnail");
  await makeThumbnail(sourcePath, dir, info);

  const plan = planRenditions(info.width, info.height);
  // A retry keeps renditions an earlier attempt already published, so the video stays playable while it runs.
  const published = new Set(
    (rows[0]?.renditions ?? []).map((r) => r.name).filter((name) => fs.existsSync(path.join(dir, name, "index.m3u8"))),
  );
  const done = plan.filter((r) => published.has(r.name));
  const groups = encodeGroups(plan.filter((r) => !published.has(r.name)));

  // Weight each rendition by pixel count so the bar moves at an even pace.
  const weight = (rs: PlannedRendition[]) => rs.reduce((sum, r) => sum + r.width * r.height, 0);
  const totalWeight = weight(plan);
  const keptWeight = weight(done);
  const fractions = groups.map(() => 0);
  const stage = () => {
    const left = plan.filter((r) => !done.includes(r)).reverse();
    if (left.length === 0) return "Finishing";
    return `Encoding ${left.length === 1 ? left[0].name : `${left[0].name}–${left[left.length - 1].name}`}`;
  };

  // Progress writes and publishes go through one chain, so they land in order and never race each other.
  let writes: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<unknown>) => (writes = writes.then(fn));
  let lastWrite = 0;
  const reportProgress = () => {
    const now = Date.now();
    if (now - lastWrite < 1000) return;
    lastWrite = now;
    const encoded = keptWeight + groups.reduce((sum, g, i) => sum + weight(g) * fractions[i], 0);
    const pct = 5 + (encoded / totalWeight) * 93;
    const label = stage();
    enqueue(() => setProgress(videoId, pct, label));
  };

  // Publishing a rendition makes it playable: it goes into the master playlist and the video's rendition list.
  const publish = () => {
    const ladder = plan.filter((r) => done.includes(r));
    return enqueue(async () => {
      await writeAtomic(path.join(dir, "master.m3u8"), masterPlaylist(ladder, info.hasAudio));
      await query(
        "UPDATE videos SET renditions = $2, stage = $3, playable_at = COALESCE(playable_at, now()) WHERE id = $1",
        [videoId, JSON.stringify(ladder.map((r) => summary(r, info.hasAudio))), stage()],
      );
    });
  };
  if (done.length > 0) await publish();

  // Every group starts at once and they share the CPU, but each later (larger) group runs at a lower
  // priority. The smallest rendition finishes about as fast as if it ran alone, the cores are never idle,
  // and the larger renditions decode the source once between them. The benchmark is in the README.
  // If one group fails, stop the others rather than leave ffmpeg writing into the folder a retry will use.
  const abort = new AbortController();
  await Promise.all(
    groups.map(async (group, i) => {
      await encodeRenditions(
        sourcePath,
        dir,
        group,
        info,
        (fraction) => {
          fractions[i] = fraction;
          reportProgress();
        },
        { nice: Math.min(19, i * NICE_STEP), signal: abort.signal },
      ).catch((err) => {
        abort.abort();
        throw err;
      });
      done.push(...group);
      await publish();
    }),
  ).finally(() => writes);

  await query(
    `UPDATE videos SET status = 'ready', progress = 100, stage = NULL, ready_at = now() WHERE id = $1`,
    [videoId],
  );
}
