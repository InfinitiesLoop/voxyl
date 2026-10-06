import { CITY_THEMES } from "@voxyl/fixtures";
import type { LightingMode, ProjectEntry } from "@voxyl/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BenchResult, runBench } from "./bench/bench.ts";
import { BenchPanel, Hud } from "./Hud.tsx";
import { type Backend, Engine, type EngineStats } from "./scene/Engine.ts";
import {
  CHUNK_SIZES,
  sampleKind,
  savedId,
  savedSource,
  WORLD_KINDS,
  type WorldInfo,
  type WorldSource,
} from "./worlds.ts";

export interface Settings {
  /** A sample's kind, or a saved project as "saved:<id>". */
  world: WorldSource;
  chunk: number;
  /** The city theme of the sample builds (CITY_THEMES). */
  theme: number;
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
  const requested = params.get("world") ?? "";
  const world = sampleKind(requested) || savedId(requested) ? requested : "city-1m";
  const chunk = Number(params.get("chunk"));
  // "palette" is the name earlier versions used.
  const themeName = params.get("theme") ?? params.get("palette");
  const theme = CITY_THEMES.findIndex((t) => t.name.toLowerCase() === themeName);
  const lighting = params.get("lighting");
  return {
    world,
    chunk: (CHUNK_SIZES as readonly number[]).includes(chunk) ? chunk : 64,
    theme: Math.max(0, theme),
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
    theme: CITY_THEMES[s.theme]?.name.toLowerCase() ?? "concrete",
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
  /** What is open, once loaded. */
  const [info, setInfo] = useState<WorldInfo | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);

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

  // The theme is read through a ref when a sample is generated, so switching themes never
  // regenerates the world: it only goes to setTheme below, a palette_sync of looks.
  const themeRef = useRef(settings.theme);
  themeRef.current = settings.theme;
  const { world: source, chunk: chunkSize, theme, lighting, daylight, brightness } = settings;

  const refreshProjects = useCallback(async () => {
    if (engine) setProjects(await engine.world.request({ type: "projects" }));
  }, [engine]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  // Generate a sample or open a saved project when the source or chunk size changes. Both
  // happen (and, with lighting on, light) in the world worker, so the page stays responsive.
  // A sample that was just saved is already on screen: only the source changed.
  const justSaved = useRef<string | null>(null);
  // Only a theme the user picks is applied (as a palette_sync); opening a saved project keeps
  // the looks it was saved with, and the picker follows them.
  const appliedTheme = useRef(settings.theme);
  useEffect(() => {
    if (!engine) return;
    const id = savedId(source);
    if (id !== null && id === justSaved.current) return;
    justSaved.current = null;
    setBench(null);
    const sample = WORLD_KINDS.find((w) => w.kind === sampleKind(source));
    const label = sample ? `Generating ${sample.label}` : "Opening the project";
    const work = engine.load(source, chunkSize, themeRef.current).then((loaded) => {
      if (!loaded) return;
      setInfo(loaded);
      // The theme picker shows what the project looks like; picking another re-skins it.
      const shown = loaded.theme;
      if (shown === null) return;
      appliedTheme.current = shown;
      setSettings((s) => (s.theme === shown ? s : { ...s, theme: shown }));
    });
    work.catch((error: unknown) => console.error(`Couldn't open ${source}`, error));
    track(label, work);
  }, [engine, source, chunkSize, track]);

  useEffect(() => {
    if (!engine || theme === appliedTheme.current) return;
    appliedTheme.current = theme;
    void engine.setTheme(theme);
  }, [engine, theme]);

  const project = {
    save: async () => {
      if (!engine) return;
      const entry = await engine.world.request({ type: "save" });
      justSaved.current = entry.id;
      setInfo((i) => i && { ...i, saved: entry.id });
      setSettings((s) => ({ ...s, world: savedSource(entry.id) }));
      await refreshProjects();
    },
    export: async (id: string, name: string) => {
      if (!engine) return;
      const bytes = await engine.world.request({ type: "exportProject", id });
      download(new Blob([bytes as Uint8Array<ArrayBuffer>]), `${name}.voxyl`);
    },
    import: async (file: File) => {
      if (!engine) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entry = await engine.world.request({ type: "importProject", bytes });
      await refreshProjects();
      setSettings((s) => ({ ...s, world: savedSource(entry.id) }));
    },
    delete: async (id: string, name: string) => {
      if (!engine || !confirm(`Delete ${name}? This can't be undone.`)) return;
      await engine.world.request({ type: "deleteProject", id });
      await refreshProjects();
      // The open project is gone: show a sample instead.
      if (savedId(settings.world) === id) setSettings((s) => ({ ...s, world: "city-1m" }));
    },
  };

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
    const world = info?.name ?? settings.world;
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
  }, [engine, backend, info, settings.world]);

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
        info={info}
        projects={projects}
        project={project}
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

/** Saves a file through the browser's download. */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
