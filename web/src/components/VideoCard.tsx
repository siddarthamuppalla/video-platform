import { Link } from "react-router-dom";
import type { Video } from "../api";
import { formatDuration, formatViews, timeAgo } from "../format";

export function VideoCard({ video }: { video: Video }) {
  return (
    <Link className="rl-card" to={`/watch/${video.id}`}>
      <div className="rl-card__thumb">
        {video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" loading="lazy" />}
        {video.durationSeconds != null && <span className="rl-card__duration">{formatDuration(video.durationSeconds)}</span>}
      </div>
      <div>
        <h3 className="rl-card__title">{video.title}</h3>
        <p className="rl-card__meta">
          {video.owner.username} · {formatViews(video.views)} · {timeAgo(video.createdAt)}
        </p>
      </div>
    </Link>
  );
}
