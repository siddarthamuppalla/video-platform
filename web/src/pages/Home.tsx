import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Video } from "../api";
import { VideoCard } from "../components/VideoCard";
import { useAuth } from "../auth";

export function Home() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const { user } = useAuth();
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVideos(null);
    api<{ videos: Video[] }>("GET", `/api/videos${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setVideos(r.videos))
      .catch((e) => setError(e.message));
  }, [q]);

  return (
    <main className="page">
      <h1 className="type-title page__heading">{q ? `Results for “${q}”` : "Latest videos"}</h1>
      {error && <p className="notice notice--error">{error}</p>}
      {videos === null && !error && <div className="rl-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" />)}</div>}
      {videos?.length === 0 && (
        <div className="empty">
          <p className="type-heading">{q ? "No videos match that search." : "No videos yet."}</p>
          {!q && (
            <p className="empty__hint">
              {user ? <Link to="/upload">Upload the first one.</Link> : <><Link to="/signup">Create an account</Link> to upload the first one.</>}
            </p>
          )}
        </div>
      )}
      {videos && videos.length > 0 && (
        <div className="rl-grid">
          {videos.map((v) => (
            <VideoCard key={v.id} video={v} />
          ))}
        </div>
      )}
    </main>
  );
}
