import { useCallback, useEffect, useRef, useState } from "react";
import { type BenchResult, runBench } from "./bench/bench.ts";
import { BenchPanel, Hud } from "./Hud.tsx";
import { PALETTES, paletteAt } from "./palettes.ts";
import { type Backend, Engine, type EngineStats } from "./scene/Engine.ts";
import { buildWorld, CHUNK_SIZES, WORLD_KINDS, type WorldKind } from "./worlds.ts";

export interface Settings {
  world: WorldKind;
  chunk: number;
  palette: number;
}

function readSettings(): Settings {
  const params = new URLSearchParams(location.search);
  const world = WORLD_KINDS.find((w) => w.kind === params.get("world"))?.kind ?? "city-1m";
  const chunk = Number(params.get("chunk"));
  const palette = PALETTES.findIndex((p) => p.name.toLowerCase() === params.get("palette"));
  return {
    world,
    chunk: (CHUNK_SIZES as readonly number[]).includes(chunk) ? chunk : 64,
    palette: Math.max(0, palette),
  };
}

function writeSettings(s: Settings): void {
  const params = new URLSearchParams({
    world: s.world,
    chunk: String(s.chunk),
    palette: PALETTES[s.palette]?.name.toLowerCase() ?? "concrete",
  });
  history.replaceState(null, "", `?${params}`);
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [settings, setSettings] = useState(readSettings);
  const [loading, setLoading] = useState<string | null>("Starting renderer");
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [locked, setLocked] = useState(false);
  const [benchStep, setBenchStep] = useState<string | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);

  // One Engine per mount. React's dev-mode double mount disposes the first cleanly.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const created = new Engine(host);
    let disposed = false;
    created.init().then(
      (b) => {
        if (disposed || b === null) return;
        setBackend(b);
        setEngine(created);
      },
      (error: unknown) => {
        // Disposing mid-start can make the renderer's init reject; only a live engine matters.
        if (!disposed) throw error;
      },
    );
    const onLock = () => setLocked(document.pointerLockElement === created.renderer.domElement);
    document.addEventListener("pointerlockchange", onLock);
    return () => {
      disposed = true;
      document.removeEventListener("pointerlockchange", onLock);
      created.dispose();
    };
  }, []);

  // The palette is read through a ref when a world loads, so switching palettes never
  // regenerates the world: it only goes to setPalette below.
  const paletteRef = useRef(settings.palette);
  paletteRef.current = settings.palette;
  const { world: worldKind, chunk: chunkSize } = settings;

  // Rebuild the world when its kind or chunk size changes.
  useEffect(() => {
    if (!engine) return;
    const label = WORLD_KINDS.find((w) => w.kind === worldKind)?.label ?? worldKind;
    setLoading(`Generating ${label}`);
    setBench(null);
    // Let the overlay paint before generation blocks the main thread.
    const timer = setTimeout(() => {
      engine.load(buildWorld(worldKind, chunkSize), paletteAt(paletteRef.current));
      setLoading(null);
    }, 30);
    return () => clearTimeout(timer);
  }, [engine, worldKind, chunkSize]);

  useEffect(() => {
    writeSettings(settings);
    engine?.setPalette(paletteAt(settings.palette));
  }, [engine, settings]);

  useEffect(() => {
    if (!engine) return;
    const timer = setInterval(() => setStats(engine.stats()), 250);
    return () => clearInterval(timer);
  }, [engine]);

  const startBench = useCallback(async () => {
    if (!engine || !backend) return;
    setBench(null);
    const world = WORLD_KINDS.find((w) => w.kind === settings.world)?.label ?? settings.world;
    try {
      const result = await runBench(engine, { backend, world }, setBenchStep);
      setBench(result);
      (window as { __voxylBench?: BenchResult }).__voxylBench = result;
      console.log("voxyl bench", JSON.stringify(result));
    } finally {
      setBenchStep(null);
    }
  }, [engine, backend, settings.world]);

  return (
    <div className="app">
      <div ref={hostRef} className="viewport" />
      {locked && <div className="crosshair" />}
      <Hud
        backend={backend}
        stats={stats}
        settings={settings}
        onSettings={setSettings}
        busy={loading !== null || benchStep !== null}
        onBench={startBench}
        onHome={() => engine?.home()}
      />
      {(loading || benchStep) && <div className="banner">{benchStep ?? loading}…</div>}
      {bench && <BenchPanel result={bench} onClose={() => setBench(null)} />}
      {!locked && !loading && !benchStep && (
        <div className="hint">
          Click the view to fly · WASD / arrows move · Space, right Ctrl or right Alt up · Shift or
          / down · \ sprint · wheel sets speed · left click erases · right click places · middle
          click picks · Esc releases
        </div>
      )}
    </div>
  );
}
