import fsp from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.js";
import { query } from "./db.js";
import { encodeRendition, makeThumbnail, masterPlaylist, planRenditions, probe, bandwidthFor } from "./transcode.js";

async function setProgress(videoId: string, progress: number, stage: string) {
  await query("UPDATE videos SET progress = $2, stage = $3 WHERE id = $1", [videoId, Math.round(progress), stage]);
}

export async function processVideo(videoId: string) {
  const dir = paths.videoDir(videoId);
  const source = (await fsp.readdir(dir)).find((f) => f.startsWith("source."));
  if (!source) throw new Error("The uploaded file is missing.");
  const sourcePath = path.join(dir, source);

  await query("UPDATE videos SET status = 'processing', progress = 0, stage = 'Reading file', error = NULL WHERE id = $1", [videoId]);
  const info = await probe(sourcePath);
  await query("UPDATE videos SET duration_seconds = $2, width = $3, height = $4 WHERE id = $1", [
    videoId, info.durationSeconds, info.width, info.height,
  ]);

  await setProgress(videoId, 2, "Making thumbnail");
  await makeThumbnail(sourcePath, dir, info);

  const plan = planRenditions(info.width, info.height);
  // Weight each rendition by pixel count so the bar moves at an even pace.
  const weights = plan.map((r) => r.width * r.height);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let done = 0;
  for (const [i, r] of plan.entries()) {
    let lastWrite = 0;
    let pending: Promise<void> = Promise.resolve();
    await encodeRendition(sourcePath, dir, r, info, (fraction) => {
      const now = Date.now();
      if (now - lastWrite < 1000 && fraction < 1) return;
      lastWrite = now;
      const pct = 5 + ((done + weights[i] * fraction) / totalWeight) * 93;
      pending = pending.then(() => setProgress(videoId, pct, `Encoding ${r.name}`));
    });
    // Let the last progress write land before moving on, so it can't overwrite a later status.
    await pending;
    done += weights[i];
  }

  await fsp.writeFile(path.join(dir, "master.m3u8"), masterPlaylist(plan, info.hasAudio));
  const renditions = plan.map((r) => ({ name: r.name, width: r.width, height: r.height, bandwidth: bandwidthFor(r, info.hasAudio) }));
  await query(
    `UPDATE videos SET status = 'ready', progress = 100, stage = NULL, renditions = $2, ready_at = now() WHERE id = $1`,
    [videoId, JSON.stringify(renditions)],
  );
}

