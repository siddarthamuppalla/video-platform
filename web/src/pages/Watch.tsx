import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type Video } from "../api";
import { Player } from "../components/Player";
import { StatusBadge } from "../components/StatusBadge";
import { formatDuration, formatViews, timeAgo } from "../format";

export function Watch() {
  const { id } = useParams();
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVideo(null);
    setError(null);
    api<{ video: Video }>("GET", `/api/videos/${id}`)
      .then((r) => setVideo(r.video))
      .catch((e) => setError(e.message));
  }, [id]);

  // Owners can open a video that is still encoding; poll until it is playable.
  useEffect(() => {
    if (!video || video.status === "ready" || video.status === "failed") return;
    const t = setTimeout(() => {
      api<{ video: Video }>("GET", `/api/videos/${id}`).then((r) => setVideo(r.video));
    }, 2000);
    return () => clearTimeout(t);
  }, [video, id]);

  if (error) return <main className="page"><p className="notice notice--error">{error}</p></main>;
  if (!video) return <main className="page watch"><div className="player skeleton" /></main>;

  return (
    <main className="page watch">
      {video.hlsUrl ? (
        <Player
          src={video.hlsUrl}
          poster={video.thumbnailUrl ?? undefined}
          onFirstPlay={() => {
            api<{ views: number }>("POST", `/api/videos/${video.id}/view`).then((r) => setVideo((v) => v && { ...v, views: r.views }));
          }}
        />
      ) : (
        <div className="player player--pending">
          <StatusBadge video={video} />
          <p>{video.status === "failed" ? video.error ?? "Encoding failed." : "This video will play here as soon as encoding finishes."}</p>
        </div>
      )}
      <section className="watch__info">
        <h1 className="type-display watch__title">{video.title}</h1>
        <p className="watch__meta">
          {video.owner.username} · {formatViews(video.views)} · {timeAgo(video.createdAt)}
        </p>
        {video.status === "ready" && (
          <p className="watch__tech type-timecode">
            {formatDuration(video.durationSeconds)} · source {video.width}×{video.height} · {video.renditions.map((r) => r.name).join(" / ")}
          </p>
        )}
        {video.description && <p className="watch__description">{video.description}</p>}
      </section>
    </main>
  );
}
