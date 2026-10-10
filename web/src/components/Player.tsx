import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Level = { index: number; height: number; name: string };

/**
 * HLS playback with a quality picker. hls.js reads the master playlist, measures bandwidth
 * and picks a rendition for each segment on Auto; choosing a rendition pins it.
 *
 * `version` changes when the server publishes another rendition while a video is still encoding.
 * Players read the master playlist once, so the player reloads it, keeping the position, whether it
 * was playing, and the chosen quality.
 */
export function Player({
  src,
  version,
  poster,
  onFirstPlay,
}: {
  src: string;
  version?: string;
  poster?: string;
  onFirstPlay?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [selected, setSelected] = useState(-1); // -1 = Auto
  const [playing, setPlaying] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const played = useRef(false);
  // The chosen quality by name, so it survives a reload that renumbers the levels.
  const selectedName = useRef<string | null>(null);
  // Where playback was when the playlist was last reloaded for the same video.
  const resume = useRef<{ src: string; time: number; paused: boolean } | null>(null);

  useEffect(() => {
    const video = videoRef.current!;
    const from = resume.current?.src === src ? resume.current : null;
    if (!from) selectedName.current = null;
    setError(null);
    const restore = () => {
      if (!from) return;
      if (from.time > 0) video.currentTime = from.time;
      if (!from.paused) video.play().catch(() => {});
    };
    const remember = () => {
      resume.current = { src, time: video.currentTime, paused: video.paused };
    };
    if (Hls.isSupported()) {
      const hls = new Hls({ startPosition: from?.time ?? -1 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        const parsed = data.levels.map((l, index) => ({ index, height: l.height, name: l.name || `${l.height}p` }));
        setLevels(parsed.sort((a, b) => b.height - a.height));
        const pinned = parsed.find((l) => l.name === selectedName.current);
        setSelected(pinned ? pinned.index : -1);
        if (pinned) hls.currentLevel = pinned.index;
        if (from && !from.paused) video.play().catch(() => {});
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setPlaying(data.level));
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError("This video couldn't be loaded. Refresh the page to try again.");
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => {
        remember();
        hls.destroy();
        hlsRef.current = null;
      };
    }
    // Safari plays HLS natively and picks quality on its own.
    setLevels([]);
    video.src = src;
    video.addEventListener("loadedmetadata", restore, { once: true });
    return () => {
      remember();
      video.removeEventListener("loadedmetadata", restore);
      video.removeAttribute("src");
    };
  }, [src, version]);

  function choose(index: number) {
    setSelected(index);
    selectedName.current = levels.find((l) => l.index === index)?.name ?? null;
    setMenuOpen(false);
    // currentLevel switches right away; -1 hands the choice back to the bandwidth estimator.
    if (hlsRef.current) hlsRef.current.currentLevel = index;
  }

  const playingName = levels.find((l) => l.index === playing)?.name;
  const label = selected === -1 ? `Auto${playingName ? ` · ${playingName}` : ""}` : levels.find((l) => l.index === selected)?.name;

  return (
    <div className="player">
      <video
        ref={videoRef}
        className="player__video"
        controls
        playsInline
        poster={poster}
        onError={() => setError("This video can't play in this browser. Try a recent Chrome, Firefox, Edge or Safari.")}
        onPlay={() => {
          if (!played.current) {
            played.current = true;
            onFirstPlay?.();
          }
        }}
      />
      {error && <p className="player__error">{error}</p>}
      {levels.length > 0 && (
        <div className="player__quality">
          <button
            className="player__quality-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {label}
          </button>
          {menuOpen && (
            <div className="rl-menu player__menu" role="menu" aria-label="Quality">
              <div className="rl-menu__title">Quality</div>
              <button className="rl-menu__item" role="menuitemradio" aria-checked={selected === -1} onClick={() => choose(-1)}>
                Auto{playingName && selected === -1 ? ` · ${playingName}` : ""}
              </button>
              {levels.map((l) => (
                <button
                  key={l.index}
                  className="rl-menu__item"
                  role="menuitemradio"
                  aria-checked={selected === l.index}
                  onClick={() => choose(l.index)}
                >
                  {l.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
