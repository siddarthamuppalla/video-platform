import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type Video } from "../api";
import { uploadFile, type UploadProgress } from "../uploader";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes } from "../format";

type Phase =
  | { kind: "pick" }
  | { kind: "details"; file: File }
  | { kind: "uploading"; file: File; progress?: UploadProgress }
  | { kind: "paused"; file: File; progress?: UploadProgress; message: string }
  | { kind: "encoding"; file: File; videoId: string; video?: Video };

const titleFromName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();

export function Upload() {
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function pick(file: File | undefined) {
    if (!file) return;
    setTitle(titleFromName(file.name));
    setPhase({ kind: "details", file });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files[0]);
  }

  async function start(file: File) {
    const controller = new AbortController();
    abortRef.current = controller;
    let last: UploadProgress | undefined;
    setPhase({ kind: "uploading", file });
    try {
      const videoId = await uploadFile(
        file,
        {
          title,
          description,
          onProgress: (p) => {
            last = p;
            setPhase({ kind: "uploading", file, progress: p });
          },
        },
        controller.signal,
      );
      setPhase({ kind: "encoding", file, videoId });
    } catch (err) {
      const message = controller.signal.aborted
        ? "Upload paused. Chunks already sent are kept."
        : `${(err as Error).message} Chunks already sent are kept, so resuming picks up where it stopped.`;
      setPhase({ kind: "paused", file, progress: last, message });
    }
  }

  // Poll the encoder's progress once the bytes are on the server.
  const encodingId = phase.kind === "encoding" ? phase.videoId : null;
  const encodingStatus = phase.kind === "encoding" ? phase.video?.status : undefined;
  useEffect(() => {
    if (!encodingId || encodingStatus === "ready" || encodingStatus === "failed") return;
    const t = setTimeout(async () => {
      const { video } = await api<{ video: Video }>("GET", `/api/videos/${encodingId}`);
      setPhase((p) => (p.kind === "encoding" ? { ...p, video } : p));
    }, encodingStatus ? 1500 : 300);
    return () => clearTimeout(t);
  }, [encodingId, encodingStatus, phase]);

  return (
    <main className="page page--medium">
      <h1 className="type-display page__heading">Upload a video</h1>

      {phase.kind === "pick" && (
        <div
          className={`rl-dropzone${over ? " rl-dropzone--over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <strong className="type-heading dropzone__title">Drop a video here</strong>
          <span className="type-small">MP4, MOV, MKV, WebM, AVI or M4V up to 2 GB</span>
          <button className="rl-btn rl-btn--secondary rl-btn--sm" onClick={() => inputRef.current?.click()}>
            Choose file
          </button>
          <input
            id="file"
            ref={inputRef}
            type="file"
            accept="video/*,.mkv"
            hidden
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </div>
      )}

      {phase.kind === "details" && (
        <form
          className="panel upload-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            start(phase.file);
          }}
        >
          <p className="upload-form__file type-timecode">
            {phase.file.name} · {formatBytes(phase.file.size)}
          </p>
          <label className="rl-field">
            <span className="rl-field__label">Title</span>
            <input id="title" className="rl-field__input" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="rl-field">
            <span className="rl-field__label">Description</span>
            <textarea
              id="description"
              className="rl-field__input upload-form__textarea"
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="rl-field__hint">Optional.</span>
          </label>
          <div className="upload-form__actions">
            <button type="button" className="rl-btn rl-btn--secondary" onClick={() => setPhase({ kind: "pick" })}>
              Choose another file
            </button>
            <button className="rl-btn rl-btn--primary" disabled={!title.trim()}>
              Upload video
            </button>
          </div>
        </form>
      )}

      {(phase.kind === "uploading" || phase.kind === "paused") && (
        <div className="rl-upload">
          <div className="rl-upload__row">
            <span className="rl-upload__name">{phase.file.name}</span>
            <span className="rl-upload__nums">
              {phase.progress
                ? `chunk ${phase.progress.doneChunks} / ${phase.progress.totalChunks} · ${formatBytes(phase.progress.doneBytes)} / ${formatBytes(phase.progress.totalBytes)}`
                : "Starting…"}
            </span>
          </div>
          <div className="rl-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(phase.progress)}>
            <div className="rl-progress__fill" style={{ width: `${pct(phase.progress)}%` }} />
          </div>
          <div className="rl-upload__row">
            <span className="type-small upload__message">{phase.kind === "paused" ? phase.message : "Uploading in chunks. You can pause and resume at any time."}</span>
            {phase.kind === "uploading" ? (
              <button className="rl-btn rl-btn--secondary rl-btn--sm" onClick={() => abortRef.current?.abort()}>
                Pause
              </button>
            ) : (
              <button className="rl-btn rl-btn--primary rl-btn--sm" onClick={() => start(phase.file)}>
                Resume
              </button>
            )}
          </div>
        </div>
      )}

      {phase.kind === "encoding" && (
        <div className="rl-upload">
          <div className="rl-upload__row">
            <span className="rl-upload__name">{phase.file.name}</span>
            {phase.video ? <StatusBadge video={phase.video} /> : <span className="rl-badge">Queued</span>}
          </div>
          <div className={`rl-progress${phase.video?.status === "ready" ? " rl-progress--done" : ""}`}>
            <div className="rl-progress__fill" style={{ width: `${phase.video?.progress ?? 0}%` }} />
          </div>
          <div className="rl-upload__row">
            <span className="type-small upload__message">
              {phase.video?.status === "ready"
                ? "Encoding finished. Your video is live."
                : phase.video?.status === "failed"
                  ? phase.video.error ?? "Encoding failed."
                  : "Upload complete. The encoder is making 1080p, 720p and 360p versions."}
            </span>
            {phase.video?.status === "ready" ? (
              <Link className="rl-btn rl-btn--primary rl-btn--sm" to={`/watch/${phase.videoId}`}>
                Watch
              </Link>
            ) : (
              <Link className="rl-btn rl-btn--secondary rl-btn--sm" to="/my-videos">
                Your videos
              </Link>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function pct(p?: UploadProgress) {
  return p && p.totalBytes > 0 ? Math.round((p.doneBytes / p.totalBytes) * 100) : 0;
}
