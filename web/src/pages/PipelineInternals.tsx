import { DELIVERY, explainEvent, type EdgeId, type NodeId } from "../internals";
import { formatBytes } from "../format";
import { describeEvent, formatElapsed, type PipelineEvent, type PipelineState } from "../pipeline";

/** The system as deployed by docker-compose, laid out left to right in the order a video moves through it. */
const NODES: { id: NodeId; x: number; y: number; name: string; role: string }[] = [
  { id: "browser", x: 20, y: 122, name: "Browser", role: "uploader.ts · hls.js" },
  { id: "nginx", x: 175, y: 122, name: "nginx", role: "web :80, reverse proxy" },
  { id: "api", x: 330, y: 122, name: "API", role: "Express :4000" },
  { id: "postgres", x: 500, y: 18, name: "Postgres", role: "videos · chunks · events" },
  { id: "disk", x: 500, y: 122, name: "Volume /data", role: "parts · source · HLS" },
  { id: "redis", x: 500, y: 226, name: "Redis", role: "BullMQ queue" },
  { id: "ffmpeg", x: 700, y: 122, name: "ffmpeg", role: "child processes" },
  { id: "worker", x: 700, y: 226, name: "Worker", role: "Node, concurrency 1" },
];
const W = 136;
const H = 58;
const EDGES: { id: EdgeId; from: NodeId; to: NodeId }[] = [
  { id: "browser-nginx", from: "browser", to: "nginx" },
  { id: "nginx-api", from: "nginx", to: "api" },
  { id: "api-postgres", from: "api", to: "postgres" },
  { id: "api-disk", from: "api", to: "disk" },
  { id: "api-redis", from: "api", to: "redis" },
  { id: "redis-worker", from: "redis", to: "worker" },
  { id: "worker-postgres", from: "worker", to: "postgres" },
  { id: "worker-ffmpeg", from: "worker", to: "ffmpeg" },
  { id: "ffmpeg-disk", from: "ffmpeg", to: "disk" },
  { id: "worker-disk", from: "worker", to: "disk" },
];
const center = (id: NodeId) => {
  const n = NODES.find((n) => n.id === id)!;
  return { x: n.x + W / 2, y: n.y + H / 2 };
};

/** A live counter under each component, from what has happened so far. */
function nodeMetric(id: NodeId, s: PipelineState, count: number) {
  const u = s.upload;
  const requests = u ? u.requests + 1 + (s.assembly ? 1 : 0) : 0;
  const segmentBytes = s.lanes.reduce((sum, l) => sum + l.segments.reduce<number>((a, b) => a + (b ?? 0), 0), 0);
  const running = s.stage === "encode" ? s.groups.filter((g) => g.renditions.some((r) => s.lanes.find((l) => l.name === r)?.publishedAt === null)).length : 0;
  switch (id) {
    case "browser":
    case "nginx":
    case "api":
      return requests ? `${requests} request${requests === 1 ? "" : "s"}` : "idle";
    case "postgres":
      return `${count} event row${count === 1 ? "" : "s"}`;
    case "disk":
      return `${formatBytes((u?.bytes ?? 0) + (s.assembly?.doneAt ? s.assembly.size : 0) + segmentBytes)} written`;
    case "redis":
      return !s.job ? "no job" : s.stage === "ready" ? "job completed" : s.stage === "failed" ? "job failed" : s.encodeStartedAt ? "job active" : "job waiting";
    case "worker":
      return s.stage === "probe" || s.stage === "encode" ? `attempt ${s.job?.attempt ?? s.attempts}` : s.stage === "ready" || s.stage === "failed" ? "done" : "idle";
    case "ffmpeg":
      return s.stage === "probe" ? "ffprobe, thumbnail" : running ? `${running} process${running === 1 ? "" : "es"}` : s.stage === "ready" ? "exited" : "not started";
  }
}

export function Architecture({ event, state, count }: { event: PipelineEvent | null; state: PipelineState; count: number }) {
  const ex = event ? explainEvent(event, state) : null;
  const activeNodes = new Set(ex?.nodes ?? []);
  const activeEdges = new Set(ex?.edges ?? []);
  return (
    <section className="panel pipeline-panel">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">System</h2>
        <span className="type-timecode pipeline-panel__nums">{event ? event.kind : ""}</span>
      </header>
      <p className="type-small pipeline-panel__lede">
        The components docker-compose runs. The ones the current step touches are outlined, with the hops between them moving.
      </p>
      <div className="arch">
        <svg className="arch__svg" viewBox="0 0 856 302" role="img" aria-label={`System diagram. Active: ${[...activeNodes].join(", ") || "none"}.`}>
          {EDGES.map((e) => {
            const a = center(e.from);
            const b = center(e.to);
            return <line key={e.id} className={`arch__edge${activeEdges.has(e.id) ? " arch__edge--active" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {NODES.map((n) => (
            <g key={n.id} className={`arch__node${activeNodes.has(n.id) ? " arch__node--active" : ""}`} transform={`translate(${n.x} ${n.y})`}>
              <rect width={W} height={H} rx={8} />
              <text className="arch__name" x={12} y={20}>{n.name}</text>
              <text className="arch__role" x={12} y={35}>{n.role}</text>
              <text className="arch__metric" x={12} y={50}>{nodeMetric(n.id, state, count)}</text>
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}

export function UnderTheHood({
  event,
  state,
  pinned,
  onFollow,
}: {
  event: PipelineEvent | null;
  state: PipelineState;
  pinned: boolean;
  onFollow: () => void;
}) {
  if (!event) return null;
  const ex = explainEvent(event, state);
  const start = state.startedAt ?? new Date(event.at).getTime();
  return (
    <section className="panel pipeline-panel hood">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">Under the hood</h2>
        {pinned ? (
          <button className="rl-btn rl-btn--ghost rl-btn--sm" onClick={onFollow}>Follow latest</button>
        ) : (
          <span className="type-small pipeline-panel__nums">latest step · pick one in the log</span>
        )}
      </header>
      <p className="type-small hood__title">{describeEvent(event, state.upload?.totalChunks)}</p>
      <p className="type-timecode hood__meta">
        event #{event.id} · {event.kind} · +{formatElapsed(new Date(event.at).getTime() - start)} · {new Date(event.at).toISOString().slice(11, 23)} UTC
      </p>
      <ol className="hood__ops">
        {ex.ops.map((op, i) => (
          <li key={i} className="hood__op">
            <span className="hood__layer type-label">{op.layer}</span>
            <code className="hood__code">{op.text}</code>
          </li>
        ))}
      </ol>
      {ex.why && <p className="type-small hood__why">{ex.why}</p>}
      <details className="hood__details">
        <summary className="type-small">How this page heard about it</summary>
        <ol className="hood__delivery type-timecode">
          {DELIVERY.map((line) => <li key={line}>{line.replace("<event id>", String(event.id))}</li>)}
        </ol>
      </details>
      <details className="hood__details">
        <summary className="type-small">Raw event</summary>
        <pre className="hood__json type-timecode">{JSON.stringify(event, null, 2)}</pre>
      </details>
    </section>
  );
}

/**
 * Every stage and every rendition's encode on one real-time axis, with a tick for each chunk and segment.
 * Unlike the replay clock, nothing is shortened here, so waits show at their true length.
 */
export function Waterfall({ state, endAt }: { state: PipelineState; endAt: number }) {
  const t0 = state.startedAt;
  if (t0 === null) return null;
  const span = Math.max(1, endAt - t0);
  const now = state.now ?? t0;
  const pos = (t: number) => `${((t - t0) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, b - a) / span) * 100}%`;
  type Row = { label: string; from: number | null; to: number | null; ticks?: (number | null)[]; mark?: number | null; tone?: "muted" };
  const u = state.upload;
  const rows: Row[] = [
    { label: "Upload", from: u?.startedAt ?? null, to: u ? (state.assembly?.startedAt ?? u.lastAt) : null, ticks: u?.chunkAt },
    { label: "Assemble", from: state.assembly?.startedAt ?? null, to: state.assembly ? (state.assembly.doneAt ?? now) : null },
    { label: "Queue wait", from: state.queuedAt, to: state.queuedAt !== null ? (state.encodeStartedAt ?? now) : null, tone: "muted" },
    { label: "Inspect", from: state.encodeStartedAt, to: state.encodeStartedAt !== null ? (state.plannedAt ?? now) : null },
    ...state.lanes
      .filter((l) => l.group >= 0)
      .map((l) => ({ label: `Encode ${l.name}`, from: l.startedAt, to: l.startedAt !== null ? (l.publishedAt ?? now) : null, ticks: l.segmentAt, mark: l.publishedAt })),
  ];
  const axis = [0, 0.25, 0.5, 0.75, 1].map((k) => ({ k, label: formatElapsed(span * k) }));
  return (
    <section className="panel pipeline-panel">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">Timeline</h2>
        <span className="type-timecode pipeline-panel__nums">real time, nothing shortened</span>
      </header>
      <p className="type-small pipeline-panel__lede">
        Each bar is a stage; ticks are chunks arriving and segments closing, and the dot is the moment a quality was published. Bars overlap where work runs in parallel.
      </p>
      <div className="wf">
        {rows.map((r) => (
          <div key={r.label} className="wf__row">
            <span className="wf__label type-timecode">
              <span>{r.label}</span>
              <span className="wf__dur">{r.from !== null && r.to !== null ? formatElapsed(r.to - r.from) : ""}</span>
            </span>
            <div className="wf__track">
              {r.from !== null && r.to !== null && (
                <span className={`wf__bar${r.tone ? " wf__bar--muted" : ""}`} style={{ left: pos(r.from), width: width(r.from, r.to) }} />
              )}
              {r.ticks?.map((t, i) => t !== null && <span key={i} className="wf__tick" style={{ left: pos(t) }} />)}
              {r.mark != null && <span className="wf__mark" style={{ left: pos(r.mark) }} title="published" />}
            </div>
          </div>
        ))}
        <div className="wf__row wf__row--axis">
          <span />
          <div className="wf__track wf__axis">
            {axis.map((a) => (
              <span key={a.k} className="wf__axis-label type-timecode" style={{ left: `${a.k * 100}%` }}>{a.label}</span>
            ))}
          </div>
        </div>
        <div className="wf__now" style={{ left: `calc(var(--wf-label) + (100% - var(--wf-label)) * ${(now - t0) / span})` }} aria-hidden="true" />
      </div>
    </section>
  );
}
