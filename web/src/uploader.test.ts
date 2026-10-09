import { describe, expect, it } from "vitest";
import { ApiError, type UploadSession } from "./api";
import { chunkRange, uploadFile } from "./uploader";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

/** A fake server that records which chunks arrived and can fail a chunk a set number of times. */
function fakeServer(opts: { size: number; chunkSize: number; received?: number[]; failures?: Record<number, number> }) {
  const total = Math.ceil(opts.size / opts.chunkSize);
  const got = new Set(opts.received ?? []);
  const failures = { ...opts.failures };
  const calls: string[] = [];
  const session = (): UploadSession => ({
    uploadId: "up1", videoId: "vid1", filename: "a.mp4", size: opts.size, chunkSize: opts.chunkSize,
    totalChunks: total, received: [...got].sort((a, b) => a - b), completed: false,
  });
  const request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/uploads") return session() as T;
    if (method === "GET" && path === "/api/uploads/up1") return session() as T;
    const m = path.match(/chunks\/(\d+)$/);
    if (method === "PUT" && m) {
      const i = Number(m[1]);
      if (failures[i]) {
        failures[i]--;
        throw new TypeError("network down");
      }
      expect((body as Blob).size).toBe(chunkRange(i, opts.chunkSize, opts.size).end - chunkRange(i, opts.chunkSize, opts.size).start);
      got.add(i);
      return {} as T;
    }
    if (method === "POST" && path.endsWith("/complete")) {
      if (got.size !== total) throw new ApiError(409, "missing chunks");
      return { videoId: "vid1" } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request: request as never, calls, got };
}

const file = (size: number) => new File([new Uint8Array(size)], "a.mp4", { lastModified: 1 });
const noSleep = async () => {};

describe("chunkRange", () => {
  it("covers the file exactly", () => {
    expect(chunkRange(0, 10, 25)).toEqual({ start: 0, end: 10 });
    expect(chunkRange(2, 10, 25)).toEqual({ start: 20, end: 25 });
  });
});

describe("uploadFile", () => {
  it("sends every chunk once, then completes", async () => {
    const server = fakeServer({ size: 25, chunkSize: 10 });
    const progress: number[] = [];
    const id = await uploadFile(file(25), { request: server.request, storage: memoryStorage(), sleep: noSleep, onProgress: (p) => progress.push(p.doneBytes) });
    expect(id).toBe("vid1");
    expect(server.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(3);
    expect(progress.at(-1)).toBe(25);
  });

  it("retries a chunk after a network error", async () => {
    const server = fakeServer({ size: 30, chunkSize: 10, failures: { 1: 2 } });
    await uploadFile(file(30), { request: server.request, storage: memoryStorage(), sleep: noSleep });
    expect(server.calls.filter((c) => c.endsWith("chunks/1"))).toHaveLength(3);
  });

  it("gives up after the retry limit and remembers the upload", async () => {
    const storage = memoryStorage();
    const server = fakeServer({ size: 30, chunkSize: 10, failures: { 2: 10 } });
    await expect(uploadFile(file(30), { request: server.request, storage, sleep: noSleep, retries: 2 })).rejects.toThrow("network down");
    expect([...storage.m.values()]).toEqual(["up1"]);
  });

  it("resumes by sending only the missing chunks", async () => {
    const storage = memoryStorage();
    storage.setItem("reel-upload:a.mp4:40:1", "up1");
    const server = fakeServer({ size: 40, chunkSize: 10, received: [0, 2] });
    await uploadFile(file(40), { request: server.request, storage, sleep: noSleep });
    expect(server.calls).not.toContain("POST /api/uploads");
    expect(server.calls.filter((c) => c.startsWith("PUT")).sort()).toEqual(["PUT /api/uploads/up1/chunks/1", "PUT /api/uploads/up1/chunks/3"]);
    expect(storage.m.size).toBe(0);
  });
});
