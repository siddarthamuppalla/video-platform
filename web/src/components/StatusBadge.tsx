import type { Video } from "../api";

export function StatusBadge({ video }: { video: Pick<Video, "status" | "progress" | "stage"> }) {
  switch (video.status) {
    case "ready":
      return <span className="rl-badge rl-badge--ready">Ready</span>;
    case "failed":
      return <span className="rl-badge rl-badge--failed">Failed</span>;
    case "processing":
      return <span className="rl-badge rl-badge--processing">{video.stage ?? "Processing"} · {video.progress}%</span>;
    case "uploading":
      return <span className="rl-badge">Uploading</span>;
    default:
      return <span className="rl-badge">Queued</span>;
  }
}
