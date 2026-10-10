import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Video } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { formatDuration, formatViews, timeAgo } from "../format";

export function MyVideos() {
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = () => api<{ videos: Video[] }>("GET", "/api/videos/mine").then((r) => setVideos(r.videos));
  useEffect(() => {
    load();
  }, []);

  // Keep polling while anything is still moving through the pipeline.
  const busy = videos?.some((v) => v.status === "queued" || v.status === "processing");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [busy]);

  async function remove(id: string) {
    await api("DELETE", `/api/videos/${id}`);
    setConfirming(null);
    setVideos((vs) => vs?.filter((v) => v.id !== id) ?? null);
  }

  return (
    <main className="page page--medium">
      <div className="page__heading page__heading--row">
        <h1 className="type-display">Your videos</h1>
        <Link className="rl-btn rl-btn--primary" to="/upload">Upload video</Link>
      </div>
      {videos?.length === 0 && (
        <div className="empty">
          <p className="type-heading">You haven't uploaded anything yet.</p>
        </div>
      )}
      <ul className="mine">
        {videos?.map((v) => (
          <li key={v.id} className="mine__row">
            <Link className="mine__thumb rl-card__thumb" to={`/watch/${v.id}`} aria-label={v.title}>
              {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" />}
              {v.durationSeconds != null && <span className="rl-card__duration">{formatDuration(v.durationSeconds)}</span>}
            </Link>
            <div className="mine__body">
              <Link className="mine__title type-heading" to={`/watch/${v.id}`}>{v.title}</Link>
              <p className="type-small mine__meta">
                {v.playable ? `${formatViews(v.views)} · ` : ""}uploaded {timeAgo(v.createdAt)}
              </p>
              {v.status === "failed" && v.error && <p className="type-small mine__error">{v.error}</p>}
              {v.status === "processing" && (
                <div className="rl-progress mine__progress">
                  <div className="rl-progress__fill" style={{ width: `${v.progress}%` }} />
                </div>
              )}
            </div>
            <div className="mine__actions">
              <StatusBadge video={v} />
              {confirming === v.id ? (
                <span className="mine__confirm">
                  <button className="rl-btn rl-btn--secondary rl-btn--sm" onClick={() => setConfirming(null)}>Keep</button>
                  <button className="rl-btn rl-btn--primary rl-btn--sm" onClick={() => remove(v.id)}>Delete</button>
                </span>
              ) : (
                <button className="rl-btn rl-btn--ghost rl-btn--sm" onClick={() => setConfirming(v.id)}>Delete</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
