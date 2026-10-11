import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Video } from "../api";
import { formatBytes, formatDuration } from "../format";
import { Architecture, UnderTheHood, Waterfall } from "./PipelineInternals";
import { EXPLAIN, Explainer, Glossary, ReadingGuide } from "./PipelineGuide";
import {
  STAGES,
  describeEvent,
  eventsBy,
  formatElapsed,
  interpolatedFractions,
  laneMetrics,
  masterPlaylistLines,
  pipelineState,
  replayTimes,
  type Lane,
  type PipelineEvent,
  type PipelineState,
  type Stage,
} from "../pipeline";

/** During a replay, quiet stretches longer than this (a long queue wait, a paused upload) are shortened to it. */
const IDLE_GAP_MS = 1500;
const SPEEDS = [0.5, 1, 2, 4, 8];

const finished = (events: PipelineEvent[]) => {
  const last = events[events.length - 1];
  return last?.kind === "ready" || (last?.kind === "failed" && last.data?.final);
};
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function Pipeline() {
  const { id } = useParams();
  const [video, setVideo] = useState<Video | null>(null);
  const [events, setEvents] = useState<PipelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  // Playback: `following` pins the playhead to the newest event; otherwise `t` (ms on the replay clock) drives it.
  const [following, setFollowing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [skipIdle, setSkipIdle] = useState(true);
  // The event "Under the hood" explains: one picked in the log, or else the latest step.
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    setVideo(null);
    setEvents(null);
    setError(null);
    setLive(false);
    setSelectedId(null);
    tRef.current = 0;
    setT(0);
    let source: EventSource | undefined;
    let cancelled = false;
    api<{ video: Video; events: PipelineEvent[] }>("GET", `/api/videos/${id}/pipeline`)
      .then((r) => {
        if (cancelled) return;
        setVideo(r.video);
        setEvents(r.events);
        const done = finished(r.events) || r.video.status === "ready" || r.video.status === "failed";
        if (done) {
          // A finished video opens as a replay from the start.
          setFollowing(false);
          setPlaying(!reducedMotion() && r.events.length > 0);
          return;
        }
        // Still moving: stream new events as the API and the worker record them.
        setLive(true);
        setFollowing(true);
        const after = r.events[r.events.length - 1]?.id ?? 0;
        source = new EventSource(`/api/videos/${id}/pipeline/live?after=${after}`);
        source.onmessage = (msg) => {
          const e: PipelineEvent = JSON.parse(msg.data);
          setEvents((prev) => (!prev || prev.some((p) => p.id >= e.id) ? prev : [...prev, e]));
          if (finished([e])) {
            source?.close();
            setLive(false);
          }
        };
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [id]);

  const list = events ?? [];
  const times = useMemo(() => replayTimes(list, skipIdle ? IDLE_GAP_MS : Infinity), [list, skipIdle]);
  const total = times[times.length - 1] ?? 0;
  const playhead = following ? total : Math.min(t, total);
  const count = following ? list.length : eventsBy(times, playhead);
  const state = useMemo(() => pipelineState(list, count), [list, count]);
  const shown = list.slice(0, count);
  const picked = selectedId !== null ? (shown.find((e) => e.id === selectedId) ?? null) : null;
  // Progress ticks arrive every second and say little; the latest real step is more useful to explain.
  let latest: PipelineEvent | null = null;
  for (let i = shown.length - 1; i >= 0 && !latest; i--) if (shown[i].kind !== "encode_progress") latest = shown[i];
  const focus = picked ?? latest;
  const endAt = list.length ? new Date(list[list.length - 1].at).getTime() : 0;
  const fractions = following ? new Map(state.lanes.map((l) => [l.name, l.fraction])) : interpolatedFractions(state, list, times, count, playhead);

  // The replay clock. `tRef` is its source of truth so each frame advances from the last one, not from
  // whatever React last rendered. Reaching the end of a live video rejoins the live edge.
  const tRef = useRef(0);
  const totalRef = useRef(total);
  totalRef.current = total;
  const moveTo = (value: number) => {
    tRef.current = value;
    setT(value);
  };
  useEffect(() => {
    if (!playing || following) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(totalRef.current, tRef.current + (now - last) * speed);
      last = now;
      moveTo(next);
      if (next >= totalRef.current) {
        setPlaying(false);
        if (live) setFollowing(true);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, following, speed, live]);

  function replay() {
    setFollowing(false);
    moveTo(0);
    setPlaying(true);
  }
  function togglePlay() {
    if (following) {
      replay();
      return;
    }
    if (!playing && playhead >= total) moveTo(0);
    setPlaying(!playing);
  }
  function seek(value: number) {
    setFollowing(false);
    moveTo(value);
  }
  function toggleSkipIdle(next: boolean) {
    // Keep the playhead on the same event when the clock is rescaled.
    const nextTimes = replayTimes(list, next ? IDLE_GAP_MS : Infinity);
    moveTo(count > 0 ? nextTimes[count - 1] : 0);
    setSkipIdle(next);
  }

  if (error) return <main className="page"><p className="notice notice--error">{error}</p></main>;
  if (!video || !events) return <main className="page"><div className="pipeline-skeleton skeleton" /></main>;

  return (
    <main className={`page pipeline${following ? " pipeline--live-edge" : ""}`}>
      <div className="page__heading pipeline__heading">
        <div className="pipeline__titles">
          <p className="type-label pipeline__eyebrow">Upload and encoding</p>
          <h1 className="type-display">{video.title}</h1>
        </div>
        <Link className="rl-btn rl-btn--secondary" to={`/watch/${video.id}`}>Back to video</Link>
      </div>

      {events.length === 0 ? (
        <div className="panel empty">
          <p className="type-heading">There's nothing to replay for this video.</p>
          <p className="empty__hint">It was uploaded before Reel started recording each step, so only videos uploaded from now on have a replay.</p>
        </div>
      ) : (
        <>
          <ReadingGuide />
          <Transport
            live={live}
            following={following}
            playing={playing}
            playhead={playhead}
            total={total}
            times={times}
            events={events}
            speed={speed}
            skipIdle={skipIdle}
            onTogglePlay={togglePlay}
            onReplay={replay}
            onGoLive={() => {
              setPlaying(false);
              setFollowing(true);
            }}
            onSeek={seek}
            onSpeed={setSpeed}
            onSkipIdle={toggleSkipIdle}
          />
          <StageRail state={state} />
          <div className="pipeline__grid">
            <div className="pipeline__main">
              <Architecture event={focus} state={state} count={count} />
            </div>
            <aside className="pipeline__side">
              <UnderTheHood event={focus} state={state} pinned={picked !== null} onFollow={() => setSelectedId(null)} />
            </aside>
          </div>
          <Stats state={state} />
          <div className="pipeline__grid">
            <div className="pipeline__main">
              <UploadPanel state={state} />
              <InspectPanel state={state} videoId={video.id} />
              <EncodePanel state={state} fractions={fractions} />
              <Waterfall state={state} endAt={endAt} />
            </div>
            <aside className="pipeline__side">
              <PlaylistPanel lanes={state.lanes} />
              <EventLog events={events} count={count} state={state} selectedId={focus?.id ?? null} onSelect={setSelectedId} />
              <Glossary />
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

function Transport(props: {
  live: boolean;
  following: boolean;
  playing: boolean;
  playhead: number;
  total: number;
  times: number[];
  events: PipelineEvent[];
  speed: number;
  skipIdle: boolean;
  onTogglePlay: () => void;
  onReplay: () => void;
  onGoLive: () => void;
  onSeek: (t: number) => void;
  onSpeed: (s: number) => void;
  onSkipIdle: (v: boolean) => void;
}) {
  const { live, following, playing, playhead, total, times, events } = props;
  // Tick marks where each stage begins, so the scrubber reads as a map of the pipeline.
  const marks = useMemo(() => {
    const starts: Record<string, string> = { upload_started: "Upload", assembly_started: "Assemble", encode_started: "Encode", published: "Playable", ready: "Ready" };
    const seen = new Set<string>();
    return events.flatMap((e, i) => {
      const label = starts[e.kind];
      if (!label || seen.has(label)) return [];
      seen.add(label);
      return [{ label, at: times[i] }];
    });
  }, [events, times]);
  const pct = total > 0 ? (playhead / total) * 100 : 100;
  // Stages that start close together keep their tick but drop the label, so labels never overlap.
  let lastLabelled = -Infinity;
  const placed = marks.map((m) => {
    const left = total > 0 ? (m.at / total) * 100 : 0;
    const labelled = left - lastLabelled >= 12;
    if (labelled) lastLabelled = left;
    return { ...m, left, labelled };
  });

  return (
    <section className="panel pipeline-transport" aria-label="Playback">
      <div className="pipeline-transport__controls">
        {live && following ? (
          <span className="pipeline-live" role="status">
            <span className="pipeline-live__dot" aria-hidden="true" />
            Live
          </span>
        ) : (
          // Secondary: the playhead is this view's one tally-red element.
          <button className="rl-btn rl-btn--secondary rl-btn--sm" onClick={props.onTogglePlay}>
            {playing ? "Pause" : playhead >= total && !live ? "Replay" : "Play"}
          </button>
        )}
        {live && following && (
          <button className="rl-btn rl-btn--secondary rl-btn--sm" onClick={props.onReplay}>Replay from start</button>
        )}
        {live && !following && (
          <button className="rl-btn rl-btn--secondary rl-btn--sm" onClick={props.onGoLive}>Go live</button>
        )}
        <span className="type-timecode pipeline-transport__time">
          {formatElapsed(playhead)} / {formatElapsed(total)}
        </span>
        <span className="pipeline-transport__spacer" />
        <label className="pipeline-transport__option type-small">
          <span>Speed</span>
          <select className="pipeline-select" value={props.speed} onChange={(e) => props.onSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <label className="pipeline-transport__option type-small">
          <input type="checkbox" checked={props.skipIdle} onChange={(e) => props.onSkipIdle(e.target.checked)} />
          <span>Shorten waits</span>
        </label>
      </div>
      <div className="pipeline-scrubber">
        <div className="pipeline-scrubber__track" aria-hidden="true">
          <div className="pipeline-scrubber__fill" style={{ width: `${pct}%` }} />
          {placed.map((m) => (
            <span key={m.label} className={`pipeline-scrubber__mark${m.left > 88 ? " pipeline-scrubber__mark--end" : ""}`} style={{ left: `${m.left}%` }} title={m.label}>
              {m.labelled && <span className="pipeline-scrubber__label">{m.label}</span>}
            </span>
          ))}
        </div>
        <input
          className="pipeline-scrubber__input"
          type="range"
          min={0}
          max={Math.max(1, Math.round(total))}
          step={1}
          value={Math.round(playhead)}
          aria-label="Replay position"
          aria-valuetext={formatElapsed(playhead)}
          onChange={(e) => props.onSeek(Number(e.target.value))}
        />
      </div>
    </section>
  );
}

const stageStart = (s: PipelineState, stage: Stage) =>
  ({
    upload: s.upload?.startedAt,
    assemble: s.assembly?.startedAt,
    queue: s.queuedAt,
    probe: s.encodeStartedAt,
    encode: s.plannedAt,
    ready: s.readyAt,
    failed: s.failed?.at,
  })[stage] ?? null;

function StageRail({ state }: { state: PipelineState }) {
  const current = STAGES.findIndex((st) => st.id === state.stage);
  return (
    <ol className="pipeline-stages" aria-label="Pipeline stages">
      {STAGES.map((st, i) => {
        const status = state.stage === "failed" && i >= Math.max(current, 0) ? "waiting" : i < current || state.stage === "ready" ? "done" : i === current ? "now" : "waiting";
        const start = stageStart(state, st.id);
        const end = STAGES.slice(i + 1).map((n) => stageStart(state, n.id)).find((v) => v !== null) ?? null;
        const duration = start !== null && end !== null ? end - start : null;
        return (
          <li key={st.id} className={`pipeline-stage pipeline-stage--${status}`} aria-current={status === "now" ? "step" : undefined}>
            <span className="pipeline-stage__name type-heading">{st.label}</span>
            <span className="pipeline-stage__detail type-timecode">
              {status === "done" ? (st.id === "ready" ? "Done" : duration !== null ? formatElapsed(duration) : "Done") : status === "now" ? "Now" : "Waiting"}
            </span>
          </li>
        );
      })}
      {state.stage === "failed" && (
        <li className="pipeline-stage pipeline-stage--failed">
          <span className="pipeline-stage__name type-heading">Failed</span>
          <span className="pipeline-stage__detail type-small">{state.failed?.error}</span>
        </li>
      )}
    </ol>
  );
}

function Stats({ state }: { state: PipelineState }) {
  const u = state.upload;
  const uploadMs = u ? u.lastAt - u.startedAt : 0;
  const sentAt = state.assembly?.doneAt ?? state.queuedAt;
  const segmentsDone = state.lanes.reduce((sum, l) => sum + l.segmentsDone, 0);
  const segmentsTotal = state.lanes.reduce((sum, l) => sum + l.segments.length, 0);
  const tiles = [
    {
      label: "Uploaded",
      value: u ? `${u.chunks.filter((c) => c > 0).length} / ${u.totalChunks} chunks` : "Not started",
      detail: u ? `${formatBytes(u.bytes)} of ${formatBytes(u.size)}${uploadMs > 0 && u.bytes > 0 ? ` · ${formatBytes((u.bytes / uploadMs) * 1000)}/s` : ""}` : "",
    },
    {
      label: "Playable after",
      value: state.playableAt !== null && sentAt !== null ? formatElapsed(state.playableAt - sentAt) : "Not yet",
      detail: "from upload finished to first quality",
    },
    {
      label: "All qualities after",
      value: state.readyAt !== null && sentAt !== null ? formatElapsed(state.readyAt - sentAt) : "Not yet",
      detail: state.lanes.length ? `${state.lanes.filter((l) => l.publishedAt !== null).length} of ${state.lanes.length} published` : "",
    },
    {
      label: "HLS segments",
      value: segmentsTotal ? `${segmentsDone} / ${segmentsTotal}` : "Not yet",
      detail: state.segmentCount ? `${state.segmentCount} per quality, ${state.segmentSeconds} s each` : "",
    },
  ];
  return (
    <dl className="pipeline-stats">
      {tiles.map((tile) => (
        <div key={tile.label} className="pipeline-stat">
          <dt className="type-label pipeline-stat__label">{tile.label}</dt>
          <dd className="pipeline-stat__value type-title">{tile.value}</dd>
          <dd className="pipeline-stat__detail type-small">{tile.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function UploadPanel({ state }: { state: PipelineState }) {
  const u = state.upload;
  const a = state.assembly;
  const assembled = a?.doneAt != null;
  return (
    <section className="panel pipeline-panel">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">Chunked upload</h2>
        <span className="type-timecode pipeline-panel__nums">
          {u ? `${u.chunks.filter((c) => c > 0).length} / ${u.totalChunks}` : ""}
          {u && u.resent > 0 ? ` · ${u.resent} re-sent` : ""}
        </span>
      </header>
      <Explainer {...EXPLAIN.upload(u ? formatBytes(u.chunkSize) : "fixed-size")} />
      {u && (
        <ul className={`pipeline-chunks${assembled ? " pipeline-chunks--merged" : ""}`} aria-label={`${u.chunks.filter((c) => c > 0).length} of ${u.totalChunks} chunks received`}>
          {u.chunks.map((c, i) => (
            <li
              key={i}
              className={`pipeline-chunk pipeline-chunk--${c === 0 ? "waiting" : c === 1 ? "received" : "merged"}${u.lastIndex === i && c === 1 ? " pipeline-chunk--latest" : ""}`}
              // The merge sweeps left to right, in the order the chunks are stitched together.
              style={c === 2 ? { transitionDelay: `${Math.round((i / u.totalChunks) * 600)}ms` } : undefined}
              title={`Chunk ${i} · bytes ${i * u.chunkSize}–${Math.min(u.size, (i + 1) * u.chunkSize) - 1}${u.chunkMs[i] != null ? ` · server ${u.chunkMs[i]} ms` : ""}`}
            />
          ))}
        </ul>
      )}
      {u && <UploadNumbers state={state} />}
      {u && (
        <div className="pipeline-source">
          <div className="pipeline-source__row type-small">
            <span className="type-timecode">source file</span>
            <span className="type-timecode pipeline-panel__nums">
              {assembled ? `${formatBytes(a!.size)} · stitched in ${formatElapsed(a!.doneAt! - a!.startedAt)}` : a ? "Stitching chunks in order…" : "Waits for every chunk"}
            </span>
          </div>
          <div className="rl-progress">
            <div className={`rl-progress__fill pipeline-source__fill${assembled ? " pipeline-source__fill--done" : ""}`} style={{ width: assembled ? "100%" : a ? "50%" : "0%" }} />
          </div>
        </div>
      )}
    </section>
  );
}

function UploadNumbers({ state }: { state: PipelineState }) {
  const u = state.upload!;
  const ms = u.chunkMs.filter((m): m is number => m !== null).sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  const elapsed = u.lastAt - u.startedAt;
  return (
    <dl className="pipeline-facts type-small">
      <dt>Requests</dt>
      <dd className="type-timecode">
        POST /uploads · {u.requests} × PUT /chunks/:i{u.resent ? ` (${u.resent} re-sent)` : ""}{state.assembly ? " · POST /complete" : ""}
      </dd>
      <dt>Server time</dt>
      <dd className="type-timecode">{ms.length ? `p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${ms[ms.length - 1]} ms per chunk` : "No chunks yet"}</dd>
      <dt>Throughput</dt>
      <dd className="type-timecode">
        {elapsed > 0 ? `${formatBytes((u.bytes / elapsed) * 1000)}/s over ${formatElapsed(elapsed)} · ${((u.received / elapsed) * 1000).toFixed(1)} chunks/s` : "Measuring"} · 3 in flight
      </dd>
    </dl>
  );
}

function InspectPanel({ state, videoId }: { state: PipelineState; videoId: string }) {
  const p = state.probe;
  const waited = state.queuedAt !== null && state.encodeStartedAt !== null ? state.encodeStartedAt - state.queuedAt : null;
  return (
    <section className="panel pipeline-panel pipeline-inspect">
      <div className={`pipeline-inspect__thumb rl-card__thumb${state.thumbnail ? " pipeline-inspect__thumb--shown" : ""}`}>
        {state.thumbnail && <img src={`/media/${videoId}/thumbnail.jpg`} alt="" />}
      </div>
      <div className="pipeline-inspect__body">
        <header className="pipeline-panel__head">
          <h2 className="type-heading">Queue and inspect</h2>
          {state.attempts > 1 && <span className="rl-badge">Attempt {state.attempts}</span>}
        </header>
        <dl className="pipeline-facts type-small">
          <dt>Queue</dt>
          <dd className="type-timecode">{state.queuedAt === null ? "Not yet" : waited === null ? "Waiting for the encoder" : `waited ${formatElapsed(waited)}`}</dd>
          {state.job && (
            <>
              <dt>Job</dt>
              <dd className="type-timecode">
                BullMQ "{state.job.queue}" · jobId {state.job.jobId.slice(0, 8)}… · attempt {state.job.attempt || "–"} of {state.job.maxAttempts} · backoff {state.job.backoffMs / 1000} s
                {state.job.pid ? ` · worker pid ${state.job.pid}` : ""}
              </dd>
            </>
          )}
          <dt>Source</dt>
          <dd className="type-timecode">{p ? `${p.width}×${p.height} · ${formatDuration(p.durationSeconds)} · ${p.hasAudio ? "audio" : "no audio"}` : "Not read yet"}</dd>
          <dt>Thumbnail</dt>
          <dd className="type-timecode">{state.thumbnail ? "captured 10% in" : "Not yet"}</dd>
        </dl>
        <Explainer {...EXPLAIN.inspect} />
        {state.failed && !state.failed.final && <p className="type-small pipeline-inspect__error">Attempt failed: {state.failed.error} It will be retried.</p>}
      </div>
    </section>
  );
}

function EncodePanel({ state, fractions }: { state: PipelineState; fractions: Map<string, number> }) {
  return (
    <section className="panel pipeline-panel">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">Encoding</h2>
        <span className="type-timecode pipeline-panel__nums">{state.lanes.length ? `${state.lanes.length} qualities` : ""}</span>
      </header>
      <Explainer {...EXPLAIN.encode(state.segmentSeconds)} />
      {state.lanes.length === 0 ? (
        <p className="type-small pipeline-panel__empty">The plan appears once the encoder has read the file.</p>
      ) : (
        <ul className="pipeline-lanes">
          {state.lanes.map((lane) => (
            <LaneRow
              key={lane.name}
              lane={lane}
              fraction={fractions.get(lane.name) ?? lane.fraction}
              segmentSeconds={state.segmentSeconds}
              duration={state.probe?.durationSeconds ?? 0}
              since={state.plannedAt}
              now={state.now}
            />
          ))}
        </ul>
      )}
      {state.groups.length > 0 && (
        <div className="pipeline-commands">
          <h3 className="type-label pipeline-commands__title">ffmpeg runs</h3>
          {state.groups.map((g, i) => (
            <details key={i} className="hood__details">
              <summary className="type-small">
                Run {i + 1}: {g.renditions.join(", ")} · {g.nice ? `nice ${g.nice}` : "full priority"}
              </summary>
              <pre className="hood__json type-timecode">{formatCommand(g.command, g.nice)}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

/** One option per line, the way you would write it in a shell script. */
function formatCommand(argv: string[], nice: number) {
  const lines: string[] = [nice ? `nice -n ${nice} ${argv[0]}` : argv[0]];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const quote = (v: string) => (/[\s;()[\]]/.test(v) ? `'${v}'` : v);
    if (a.startsWith("-") && next !== undefined && !next.startsWith("-")) {
      lines.push(`  ${a} ${quote(next)}`);
      i++;
    } else {
      lines.push(`  ${quote(a)}`);
    }
  }
  return lines.join(" \\\n");
}

/** Long videos have hundreds of segments; past this many, each cell stands for a run of them. */
const MAX_CELLS = 180;

const LaneRow = memo(function LaneRow({
  lane,
  fraction,
  segmentSeconds,
  duration,
  since,
  now,
}: {
  lane: Lane;
  fraction: number;
  segmentSeconds: number;
  duration: number;
  since: number | null;
  now: number | null;
}) {
  const m = laneMetrics(lane, fraction, duration, segmentSeconds, now);
  const n = lane.segments.length;
  const cells = Math.min(n, MAX_CELLS);
  const per = n / Math.max(1, cells);
  // Where ffmpeg is in the source, in segments. The segment it is writing fills as it goes.
  const head = lane.publishedAt !== null ? n : Math.min(n, (fraction * duration) / segmentSeconds);
  const fills = Array.from({ length: cells }, (_, j) => {
    const from = j * per;
    const to = (j + 1) * per;
    let done = 0;
    for (let k = Math.floor(from); k < Math.ceil(to); k++) if (lane.segments[k] !== null) done++;
    const written = done / Math.max(1, Math.ceil(to) - Math.floor(from));
    const writing = Math.min(1, Math.max(0, (head - from) / (to - from)));
    return { written, writing: Math.max(written, writing) };
  });
  const bytes = lane.segments.reduce<number>((sum, b) => sum + (b ?? 0), 0);
  const status =
    lane.publishedAt !== null ? (lane.group < 0 ? "Kept" : "Playable") : fraction > 0 ? `${Math.floor(fraction * 100)}%` : "Waiting";
  const role =
    lane.group < 0 ? "kept from an earlier attempt" : lane.group === 0 ? "encoded first, full priority" : `shared run, nice ${lane.nice ?? 0}`;

  return (
    <li className={`pipeline-lane${lane.publishedAt !== null ? " pipeline-lane--published" : ""}`}>
      <div className="pipeline-lane__label">
        <span className="type-timecode pipeline-lane__name">{lane.name}</span>
        <span className="type-small pipeline-lane__meta">
          {lane.width}×{lane.height} · {(lane.videoKbps / 1000).toFixed(1)} Mb/s · {role}
        </span>
      </div>
      <div className="pipeline-lane__track">
        <div className={`pipeline-segments${cells < n ? " pipeline-segments--dense" : ""}`} aria-hidden="true">
          {fills.map((f, j) => (
            <span key={j} className="pipeline-segment">
              <span className="pipeline-segment__writing" style={{ transform: `scaleX(${f.writing})` }} />
              <span className="pipeline-segment__written" style={{ opacity: f.written }} />
            </span>
          ))}
        </div>
        <div className="pipeline-lane__nums type-timecode">
          <span>
            {lane.segmentsDone} / {n} segments{bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
          </span>
          {m.speed !== null && <span>{m.speed.toFixed(2)}× realtime</span>}
          {m.kbps !== null && <span>measured {Math.round(m.kbps)} kb/s incl. audio · target {lane.videoKbps} video</span>}
          {lane.publishedAt !== null && since !== null && lane.group >= 0 && <span>published at +{formatElapsed(lane.publishedAt - since)}</span>}
        </div>
      </div>
      <span
        className={`rl-badge pipeline-lane__status${lane.publishedAt !== null ? " rl-badge--ready" : fraction > 0 ? " rl-badge--processing" : ""}`}
        role="status"
      >
        {status}
      </span>
    </li>
  );
});

function PlaylistPanel({ lanes }: { lanes: Lane[] }) {
  const lines = masterPlaylistLines(lanes);
  return (
    <section className="panel pipeline-panel">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">master.m3u8</h2>
      </header>
      <Explainer {...EXPLAIN.playlist} />
      <pre className="pipeline-playlist type-timecode">
        {lines.length > 2 ? (
          lines.map((line, i) => <span key={line} className={`pipeline-playlist__line${i >= 2 ? " pipeline-playlist__line--added" : ""}`}>{line}{"\n"}</span>)
        ) : (
          <span className="pipeline-playlist__empty">Not written yet. It appears when the first quality is ready.</span>
        )}
      </pre>
    </section>
  );
}

/** The log shows the newest steps first. Progress ticks are left out; the lanes show them. */
const LOG_LIMIT = 80;

function EventLog({
  events,
  count,
  state,
  selectedId,
  onSelect,
}: {
  events: PipelineEvent[];
  count: number;
  state: PipelineState;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const rows: { e: PipelineEvent; text: string }[] = [];
  for (let i = count - 1; i >= 0 && rows.length < LOG_LIMIT; i--) {
    const e = events[i];
    const text = describeEvent(e, state.upload?.totalChunks);
    if (text && e.kind !== "encode_progress") rows.push({ e, text });
  }
  const start = state.startedAt ?? 0;
  return (
    <section className="panel pipeline-panel">
      <header className="pipeline-panel__head">
        <h2 className="type-heading">Event log</h2>
        <span className="type-timecode pipeline-panel__nums">{count} / {events.length}</span>
      </header>
      <p className="type-small pipeline-panel__lede">{EXPLAIN.log.what}</p>
      <ol className="pipeline-log">
        {rows.map(({ e, text }, i) => (
          <li key={e.id}>
            <button
              className={`pipeline-log__row${i === 0 ? " pipeline-log__row--latest" : ""}${e.id === selectedId ? " pipeline-log__row--selected" : ""}`}
              aria-pressed={e.id === selectedId}
              onClick={() => onSelect(e.id)}
            >
              <span className="type-timecode pipeline-log__time">+{formatElapsed(new Date(e.at).getTime() - start)}</span>
              <span className="type-small">{text}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
