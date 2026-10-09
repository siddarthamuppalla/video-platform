import { api, ApiError, type UploadSession } from "./api";

export type UploadProgress = { doneChunks: number; totalChunks: number; doneBytes: number; totalBytes: number };

type Options = {
  title?: string;
  description?: string;
  concurrency?: number;
  retries?: number;
  onProgress?: (p: UploadProgress) => void;
  onSession?: (s: UploadSession) => void;
  /** Injected for tests; defaults to the real API and localStorage. */
  request?: typeof api;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  sleep?: (ms: number) => Promise<void>;
};

const resumeKey = (f: File) => `reel-upload:${f.name}:${f.size}:${f.lastModified}`;

function safeStorage(): Options["storage"] {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Which byte range of the file belongs to chunk `index`. */
export function chunkRange(index: number, chunkSize: number, size: number) {
  const start = index * chunkSize;
  return { start, end: Math.min(size, start + chunkSize) };
}

/**
 * Uploads a file in chunks, a few at a time, retrying each chunk on failure.
 * The upload id is remembered per file, so choosing the same file again after
 * a refresh or a dropped connection sends only the chunks the server is missing.
 */
export async function uploadFile(file: File, opts: Options = {}, signal?: AbortSignal) {
  const request = opts.request ?? api;
  const storage = opts.storage ?? safeStorage();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = opts.concurrency ?? 3;
  const retries = opts.retries ?? 3;

  let session: UploadSession | undefined;
  const savedId = storage?.getItem(resumeKey(file));
  if (savedId) {
    try {
      session = await request<UploadSession>("GET", `/api/uploads/${savedId}`, undefined, signal);
      if (session.completed) session = undefined;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      session = undefined; // Unknown or someone else's upload: start fresh.
    }
  }
  if (!session) {
    session = await request<UploadSession>("POST", "/api/uploads", { filename: file.name, size: file.size, title: opts.title, description: opts.description }, signal);
    storage?.setItem(resumeKey(file), session.uploadId);
  }
  opts.onSession?.(session);

  const s = session;
  const done = new Set(s.received);
  let doneBytes = s.received.reduce((sum, i) => {
    const r = chunkRange(i, s.chunkSize, s.size);
    return sum + (r.end - r.start);
  }, 0);
  const report = () => opts.onProgress?.({ doneChunks: done.size, totalChunks: s.totalChunks, doneBytes, totalBytes: s.size });
  report();

  const queue = Array.from({ length: s.totalChunks }, (_, i) => i).filter((i) => !done.has(i));

  async function sendChunk(index: number) {
    const { start, end } = chunkRange(index, s.chunkSize, s.size);
    const blob = file.slice(start, end);
    for (let attempt = 0; ; attempt++) {
      try {
        await request("PUT", `/api/uploads/${s.uploadId}/chunks/${index}`, blob, signal);
        break;
      } catch (err) {
        // A 4xx means the request itself is wrong; retrying won't help.
        const clientError = err instanceof ApiError && err.status >= 400 && err.status < 500;
        if (signal?.aborted || clientError || attempt >= retries) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    done.add(index);
    doneBytes += end - start;
    report();
  }

  async function lane() {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await sendChunk(next);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, lane));

  const result = await request<{ videoId: string }>("POST", `/api/uploads/${s.uploadId}/complete`, undefined, signal);
  storage?.removeItem(resumeKey(file));
  return result.videoId;
}
