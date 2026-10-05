import type { LightingMode } from "@voxyl/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BenchResult, runBench } from "./bench/bench.ts";
import { BenchPanel, Hud } from "./Hud.tsx";
import { PALETTES, paletteAt } from "./palettes.ts";
import { type Backend, Engine, type EngineStats } from "./scene/Engine.ts";
import { CHUNK_SIZES, WORLD_KINDS, type WorldKind } from "./worlds.ts";

export interface Settings {
  world: WorldKind;
  chunk: number;
  palette: number;
  lighting: LightingMode;
  /** Time of day, 0 (midnight) to 100 (noon). */
  daylight: number;
  /** Minecraft's Brightness, 0 (Moody) to 100 (Bright); 50 is its default. */
  brightness: number;
}

function percent(value: string | null, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

function readSettings(): Settings {
  const params = new URLSearchParams(location.search);
  const world = WORLD_KINDS.find((w) => w.kind === params.get("world"))?.kind ?? "city-1m";
  const chunk = Number(params.get("chunk"));
  const palette = PALETTES.findIndex((p) => p.name.toLowerCase() === params.get("palette"));
  const lighting = params.get("lighting");
  return {
    world,
    chunk: (CHUNK_SIZES as readonly number[]).includes(chunk) ? chunk : 64,
    palette: Math.max(0, palette),
    // "on" and "vertex" are from earlier versions; any lighting now means the light volume.
    lighting: lighting === null || lighting === "off" ? "off" : "volume",
    daylight: percent(params.get("daylight"), 100),
    brightness: percent(params.get("brightness"), 50),
  };
}

function writeSettings(s: Settings): void {
  const params = new URLSearchParams({
    world: s.world,
    chunk: String(s.chunk),
    palette: PALETTES[s.palette]?.name.toLowerCase() ?? "concrete",
    lighting: s.lighting,
    daylight: String(s.daylight),
    brightness: String(s.brightness),
  });
  history.replaceState(null, "", `?${params}`);
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [settings, setSettings] = useState(readSettings);
  /** Work in progress, shown in the banner (latest last); the controls wait for it. */
  const [tasks, setTasks] = useState<string[]>(["Starting renderer"]);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [locked, setLocked] = useState(false);
  const [benchStep, setBenchStep] = useState<string | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);

  const track = useCallback((label: string, work: Promise<unknown>) => {
    setTasks((t) => [...t, label]);
    const done = () =>
      setTasks((t) => {
        const i = t.indexOf(label);
        return i < 0 ? t : [...t.slice(0, i), ...t.slice(i + 1)];
      });
    work.then(done, done);
  }, []);

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
        setTasks((t) => t.filter((label) => label !== "Starting renderer"));
        // Development only: lets dev tools (pnpm shot, scratch scripts) drive the scene.
        if (import.meta.env.DEV) (window as { __voxylEngine?: Engine }).__voxylEngine = created;
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

  useEffect(() => writeSettings(settings), [settings]);

  // The palette is read through a ref when a world loads, so switching palettes never
  // regenerates the world: it only goes to setPalette below.
  const paletteRef = useRef(settings.palette);
  paletteRef.current = settings.palette;
  const { world: worldKind, chunk: chunkSize, palette, lighting, daylight, brightness } = settings;

  // Rebuild the world when its kind or chunk size changes. It is generated (and, with
  // lighting on, lit) in the world worker, so the page stays responsive meanwhile.
  useEffect(() => {
    if (!engine) return;
    const label = WORLD_KINDS.find((w) => w.kind === worldKind)?.label ?? worldKind;
    setBench(null);
    track(`Generating ${label}`, engine.load(worldKind, chunkSize, paletteAt(paletteRef.current)));
  }, [engine, worldKind, chunkSize, track]);

  useEffect(() => {
    if (engine) void engine.setPalette(paletteAt(palette));
  }, [engine, palette]);

  useEffect(() => {
    engine?.setDaylight(daylight / 100);
    engine?.setBrightness(brightness / 100);
  }, [engine, daylight, brightness]);

  // Turning lighting on lights the whole world in the worker: the world stays on screen,
  // unlit, until each chunk's light arrives.
  useEffect(() => {
    if (!engine) return;
    const turningOn = lighting !== "off" && engine.lighting === "off";
    const work = engine.setLighting(lighting);
    if (turningOn) track("Lighting the world", work);
  }, [engine, lighting, track]);

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
      const result = await runBench(
        engine,
        { backend, world, lighting: engine.lighting },
        setBenchStep,
      );
      setBench(result);
      (window as { __voxylBench?: BenchResult }).__voxylBench = result;
      console.log("voxyl bench", JSON.stringify(result));
    } finally {
      setBenchStep(null);
    }
  }, [engine, backend, settings.world]);

  const loading = tasks.at(-1) ?? null;
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
        volumeLighting={engine?.volumeLighting ?? true}
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
