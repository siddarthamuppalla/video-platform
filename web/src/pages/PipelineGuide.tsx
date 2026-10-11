import type { ReactNode } from "react";

/**
 * The dashboard's teaching text, kept in one place. Every panel answers the same two questions in the
 * same order: what you are looking at, and why the system is built that way.
 */
export function Explainer({ what, why }: { what: ReactNode; why: ReactNode }) {
  return (
    <div className="explainer type-small">
      <p>
        <span className="explainer__label type-label">What you see</span>
        {what}
      </p>
      <p>
        <span className="explainer__label type-label">Why it works this way</span>
        {why}
      </p>
    </div>
  );
}

export const EXPLAIN = {
  system: {
    what: "The services that run the platform, as docker-compose starts them. When a step happens, the services it involves are outlined and the connections it travels along move. The small line under each service counts what it has done so far.",
    why: "Each service has one job. The API answers requests quickly and never encodes; the worker does the slow encoding in the background; Postgres is the record of truth; Redis holds the queue of work; the volume holds the files. Splitting them this way means a slow encode never makes the website slow, and each part can be scaled or restarted on its own.",
  },
  upload: (chunk: string) => ({
    what: `Each square is one ${chunk} piece of the file. It fills when the server has saved that piece. When every piece is in, they slide down into one bar: the original file, put back together in order.`,
    why: "Sending a big file in pieces means a dropped connection only loses one piece, not the whole upload, and the upload can resume later from where it stopped. The browser sends three pieces at a time to use the connection well, so they can arrive in any order; the server puts them back in order by number.",
  }),
  inspect: {
    what: "Once the file is whole, the API hands the video to a background job queue and replies straight away. A worker picks the job up, reads the file's size, length and audio track with ffprobe, and grabs a thumbnail.",
    why: "Encoding takes far longer than an HTTP request should. A queue lets the website stay fast while the work waits for a free worker, and it retries the job automatically if it fails. Reading the file first decides everything after it: which qualities to make (never larger than the original) and how many segments each will have.",
  },
  encode: (seconds: number) => ({
    what: `One row per quality. Each box is a ${seconds}-second chunk of the video, which becomes one segment. It turns grey while a worker encodes it and dark when it is written. Chunks are encoded in parallel, so boxes can fill out of order. A quality is marked Playable the moment all its chunks are done and its playlist is written.`,
    why: `Instead of one long ffmpeg run per quality, the video is cut into ${seconds}-second chunks and each chunk is its own task in the queue, so every free CPU core, on any worker, can encode a different chunk at the same time. The smallest quality's chunks and the soundtrack go to the front of the queue, so people can start watching as early as possible; the bigger qualities' chunks follow. Every quality is cut at exactly the same ${seconds}-second marks, and every chunk starts with a keyframe, which is what lets a player switch quality between any two segments without a glitch.`,
  }),
  timeline: {
    what: "The whole journey on one clock, in real time. Each bar is how long a stage took; small ticks are pieces arriving and segments being finished; the green dot is when a quality became watchable. The dashed line is the current moment.",
    why: "Bars that overlap are running at the same time. Here you can see the payoff of the design: the smallest quality is watchable long before the larger ones finish, and the queue wait shows how long work sat waiting for a free worker.",
  },
  playlist: {
    what: "The master playlist, the first file a video player downloads. It lists every quality that is ready, with its resolution and the bandwidth it needs.",
    why: "This is how adaptive streaming works: the player measures your connection and picks the best quality that fits, segment by segment. Adding a line as each quality finishes is what makes the video playable before encoding is complete.",
  },
  hood: {
    what: "The exact operations behind one step, grouped by the part of the system they happen in. Pick any step in the event log to see it here.",
  },
  log: {
    what: "Every recorded step, newest first, with the time since the upload began. Click a row to explain it above.",
  },
};

/** The layers "Under the hood" groups operations by, in plain words. */
export const LAYERS: Record<string, string> = {
  HTTP: "a request between the browser and the server",
  SQL: "a statement run against the Postgres database",
  Disk: "a file read or written on the shared volume",
  Queue: "a call to the BullMQ job queue stored in Redis",
  Process: "a program the worker runs, such as ffmpeg",
  Player: "what the video player in the browser does",
};

const TERMS: { term: string; meaning: string }[] = [
  { term: "Chunk", meaning: "On upload, one fixed-size piece of the file, sent separately and put back together on the server. On encode, one 6-second stretch of the video, encoded on its own." },
  { term: "Idempotent", meaning: "Safe to repeat. Sending the same chunk twice leaves the same result as sending it once, so retries can't corrupt anything." },
  { term: "Job queue", meaning: "A list of work waiting to be done (here BullMQ, stored in Redis). The API adds jobs; workers take them, several at once." },
  { term: "Rendition", meaning: "One quality of the video, such as 360p or 1080p. Each is a complete copy at a different size and bitrate." },
  { term: "Bitrate", meaning: "How many bits of data one second of video uses. Higher looks better but needs a faster connection." },
  { term: "HLS segment", meaning: "A short file (6 seconds here) holding one slice of one rendition. Players download segments one after another." },
  { term: "Keyframe", meaning: "A frame stored in full rather than as a change from the one before. Every segment starts with one, so it can play on its own." },
  { term: "Master playlist", meaning: "master.m3u8: the index of renditions a player reads first to decide which quality to fetch." },
  { term: "Adaptive streaming", meaning: "The player switching quality while you watch, to match your connection speed." },
  { term: "Encode task", meaning: "One job in the encode-chunk queue: one chunk of one tier of qualities, or the whole soundtrack. Any worker can take any task, and a failed one is retried on its own." },
  { term: "Queue priority", meaning: "The order the queue hands tasks out in. Priority 1 (the soundtrack and the smallest quality) always goes before priority 2, across every video." },
  { term: "LISTEN / NOTIFY", meaning: "Postgres's built-in messaging. A trigger announces each new event, and the API, which is listening, is told instantly." },
  { term: "Server-Sent Events", meaning: "A long-lived HTTP response the server keeps writing to. It is how this page receives each step live without asking repeatedly." },
  { term: "Atomic rename", meaning: "Writing to a temporary name and then renaming it. Readers see either the old file or the new one, never half of one." },
];

export function ReadingGuide() {
  return (
    <details className="panel pipeline-panel guide" open>
      <summary className="type-heading guide__summary">How to read this page</summary>
      <ol className="guide__steps type-small">
        <li>
          <strong>Watch or replay.</strong> While a video is processing the page updates live. Afterwards, press Play to watch the whole run again,
          drag the bar to jump to any moment, and change the speed. Long waits are shortened in the replay; the Timeline panel always shows real time.
        </li>
        <li>
          <strong>Follow the path.</strong> The stages along the top run left to right. The System diagram shows which services each step uses, and the
          panels below show the detail of each stage.
        </li>
        <li>
          <strong>Ask "what happened here?"</strong> Click any line in the event log. Under the hood shows the exact request, database statement, file
          operation or command behind it, and why the system does it that way.
        </li>
        <li>
          <strong>Unfamiliar word?</strong> The glossary at the bottom of the page explains the terms used here.
        </li>
      </ol>
    </details>
  );
}

export function Glossary() {
  return (
    <section className="panel pipeline-panel" id="glossary">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">Glossary</h2>
      </header>
      <dl className="glossary type-small">
        {TERMS.map((t) => (
          <div key={t.term} className="glossary__item">
            <dt className="glossary__term">{t.term}</dt>
            <dd>{t.meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
