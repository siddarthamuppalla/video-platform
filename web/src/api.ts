export type User = { id: string; email: string; username: string };
export type VideoStatus = "uploading" | "queued" | "processing" | "ready" | "failed";
export type Rendition = { name: string; width: number; height: number; bandwidth: number };
export type Video = {
  id: string;
  title: string;
  description: string;
  status: VideoStatus;
  progress: number;
  stage: string | null;
  error: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  renditions: Rendition[];
  views: number;
  createdAt: string;
  owner: { id: string; username: string };
  /** True once the smallest rendition is encoded; larger ones may still be on the way. */
  playable: boolean;
  thumbnailUrl: string | null;
  hlsUrl: string | null;
};
export type UploadSession = {
  uploadId: string;
  videoId: string;
  filename: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  received: number[];
  completed: boolean;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const isBinary = body instanceof Blob;
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    headers: body === undefined || isBinary ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : isBinary ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed with ${res.status}.`);
  return data as T;
}
