import { CITY_THEMES } from "@voxyl/fixtures";
import type { LightingMode, ProjectEntry } from "@voxyl/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BenchResult, runBench } from "./bench/bench.ts";
import { download } from "./download.ts";
import { CutawayPanel } from "./editor/CutawayPanel.tsx";
import { Home } from "./editor/Home.tsx";
import { HotbarBar } from "./editor/HotbarBar.tsx";
import { Inventory } from "./editor/Inventory.tsx";
import { clearBlockIcons } from "./editor/icons.tsx";
import { KeysPanel } from "./editor/KeysPanel.tsx";
import {
  focusedPane,
  type LayoutPreset,
  type LayoutState,
  presetFromParams,
  readLayout,
  saveLayout,
} from "./editor/layout.ts";
import { PaletteDrawer } from "./editor/PaletteDrawer.tsx";
import { Panes } from "./editor/Panes.tsx";
import { PasteOverlay } from "./editor/PasteOverlay.tsx";
import { RegionDialog } from "./editor/RegionDialog.tsx";
import { SelectionPanel } from "./editor/SelectionPanel.tsx";
import { Toast } from "./editor/Toast.tsx";
import { ToolBadge } from "./editor/Tools.tsx";
import { TopBar } from "./editor/TopBar.tsx";
import { useStore } from "./editor/useStore.ts";
import { BenchPanel, Hud } from "./Hud.tsx";
import { type Backend, Engine, type EngineStats } from "./scene/Engine.ts";
import { NOON, wrapHours } from "./scene/sky-model.ts";
import type { LibraryInfo } from "./world/protocol.ts";
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
  /** A sample's kind, a saved project as "saved:<id>", or "" for none (Home). */
  world: WorldSource;
  chunk: number;
  /** The city theme of the sample builds (CITY_THEMES). */
  theme: number;
  lighting: LightingMode;
  /** Time of day in hours, 0 (midnight) to 24; 12 is noon. */
  time: number;
  /** Minecraft's Brightness, 0 (Moody) to 100 (Bright); 50 is its default. */
  brightness: number;
  /** Which arrangement of panes is showing. Each pane's kind and time live with the layout. */
  layout: LayoutPreset;
}

function percent(value: string | null, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

/** `time` in hours; earlier versions had `daylight`, 0 (midnight) to 100 (noon). */
function readTime(params: URLSearchParams): number {
  const time = Number(params.get("time") ?? Number.NaN);
  if (Number.isFinite(time)) return wrapHours(time);
  if (params.has("daylight")) return (percent(params.get("daylight"), 100) / 100) * NOON;
  return NOON;
}

function readSettings(): Settings {
  const params = new URLSearchParams(location.search);
  const requested = params.get("world") ?? "";
  const world = sampleKind(requested) || savedId(requested) ? requested : "";
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
    time: readTime(params),
    brightness: percent(params.get("brightness"), 50),
    layout: presetFromParams(params) ?? "single",
  };
}

const DEV_KEY = "voxyl.dev";
const PALETTES_KEY = "voxyl.palettes";

function writeSettings(s: Settings): void {
  const params = new URLSearchParams({
    ...(s.world !== "" && { world: s.world }),
    chunk: String(s.chunk),
    theme: CITY_THEMES[s.theme]?.name.toLowerCase() ?? "concrete",
    lighting: s.lighting,
    time: String(s.time),
    brightness: String(s.brightness),
    layout: s.layout,
  });
  history.replaceState(null, "", `?${params}`);
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [settings, setSettings] = useState(readSettings);
  const [layout, setLayout] = useState<LayoutState>(() =>
    readLayout(readSettings().time, new URLSearchParams(location.search)),
  );
  /** Work in progress, shown in the banner (latest last); the controls wait for it. */
  const [tasks, setTasks] = useState<string[]>(["Starting renderer"]);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [locked, setLocked] = useState(false);
  const [benchStep, setBenchStep] = useState<string | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  /** What is open, once loaded. */
  const [info, setInfo] = useState<WorldInfo | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  /** Bumped to open the same source again (a sample whose library just arrived). */
  const [reloads, setReloads] = useState(0);
  /** The dev panel (samples, stats, benchmark), remembered across visits. */
  const [devOpen, setDevOpen] = useState(() => localStorage.getItem(DEV_KEY) === "1");
  const toggleDev = useCallback(() => {
    setDevOpen((open) => {
      localStorage.setItem(DEV_KEY, open ? "0" : "1");
      return !open;
    });
  }, []);
  /** The palette drawer, open until the user closes it. */
  const [palettesOpen, setPalettesOpen] = useState(
    () => localStorage.getItem(PALETTES_KEY) !== "0",
  );
  /** Home: where the app opens when the link names no build, and the top bar's Home. */
  const [homeOpen, setHomeOpen] = useState(() => readSettings().world === "");
  /** The key bindings panel. */
  const [keysOpen, setKeysOpen] = useState(false);
  const closeKeys = useCallback(() => setKeysOpen(false), []);
  const togglePalettes = useCallback(() => {
    setPalettesOpen((open) => {
      localStorage.setItem(PALETTES_KEY, open ? "0" : "1");
      return !open;
    });
  }, []);

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

  // The project's north is a setting that can change (and undo) while it is open.
  useEffect(() => {
    if (!engine) return;
    return engine.north.subscribe(() => {
      const north = engine.north.get();
      setInfo((current) => (current && current.north !== north ? { ...current, north } : current));
    });
  }, [engine]);

  useEffect(() => writeSettings(settings), [settings]);

  // The focused 3D pane's time is the one a link records. The other panes stay in storage.
  useEffect(() => {
    saveLayout(layout);
    const pane = focusedPane(layout);
    setSettings((current) => {
      const time = pane.kind === "3d" ? pane.time : current.time;
      if (current.layout === layout.preset && current.time === time) return current;
      return { ...current, layout: layout.preset, time };
    });
  }, [layout]);

  // The theme is read through a ref when a sample is generated, so switching themes never
  // regenerates the world: it only goes to setTheme below, a palette_sync of looks.
  const themeRef = useRef(settings.theme);
  themeRef.current = settings.theme;
  const { world: source, chunk: chunkSize, theme, lighting, brightness } = settings;

  const refreshProjects = useCallback(async () => {
    if (engine) setProjects(await engine.world.request({ type: "projects" }));
  }, [engine]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const refreshLibraries = useCallback(async () => {
    if (!engine) return;
    const list = await engine.world.request({ type: "libraries" });
    setLibraries(list);
    engine.libraries.set(list);
  }, [engine]);

  useEffect(() => {
    void refreshLibraries();
  }, [refreshLibraries]);

  // Generate a sample or open a saved project when the source or chunk size changes. Both
  // happen (and, with lighting on, light) in the world worker, so the page stays responsive.
  // A sample that was just saved is already on screen: only the source changed.
  const justSaved = useRef<string | null>(null);
  // Only a theme the user picks is applied (as a palette_sync); opening a saved project keeps
  // the looks it was saved with, and the picker follows them.
  const appliedTheme = useRef(settings.theme);
  useEffect(() => {
    if (!engine || source === "") return;
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
    // reloads only asks for the same source again.
    void reloads;
  }, [engine, source, chunkSize, track, reloads]);

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
      setHomeOpen(false);
    },
    create: async () => {
      if (!engine) return;
      const entry = await engine.world.request({ type: "createProject", name: "New build" });
      await refreshProjects();
      setSettings((s) => ({ ...s, world: savedSource(entry.id) }));
      setHomeOpen(false);
    },
    rename: async (name: string) => {
      if (!engine) return;
      try {
        const applied = await engine.world.request({ type: "rename", name });
        if (!applied) return;
        const savedId = info?.saved ?? null;
        setInfo((current) => (current ? { ...current, name } : current));
        if (savedId !== null) {
          setProjects((list) => list.map((p) => (p.id === savedId ? { ...p, name } : p)));
        }
      } catch (error) {
        alert(`Couldn't rename: ${error instanceof Error ? error.message : error}`);
      }
    },
    delete: async (id: string, name: string) => {
      if (!engine || !confirm(`Delete ${name}? This can't be undone.`)) return;
      await engine.world.request({ type: "deleteProject", id });
      await refreshProjects();
      // The open project is gone: show a sample instead.
      if (savedId(settings.world) === id) {
        engine.unload();
        setInfo(null);
        setSettings((s) => ({ ...s, world: "" }));
        setHomeOpen(true);
      }
    },
  };

  const library = {
    importJar: async (file: File) => {
      if (!engine) return;
      const work = (async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imported = await engine.world.request({ type: "importJar", bytes });
        console.log(
          `Imported ${imported.name}: ${imported.blocks} blocks in ${imported.ms.toFixed(0)} ms ` +
            `(${imported.skipped} drawn by the game itself left out)`,
        );
        await refreshLibraries();
        clearBlockIcons(engine);
        if (source === "mc-blocks") setReloads((n) => n + 1);
      })();
      track("Importing the Minecraft jar", work);
      await work.catch((error: unknown) =>
        alert(`Couldn't import ${file.name}: ${error instanceof Error ? error.message : error}`),
      );
    },
    delete: async (id: string, name: string) => {
      if (!engine || !confirm(`Remove ${name} from this browser?`)) return;
      await engine.world.request({ type: "deleteLibrary", id });
      clearBlockIcons(engine);
      await refreshLibraries();
    },
  };

  useEffect(() => {
    if (engine) engine.paused = homeOpen;
  }, [engine, homeOpen]);

  useEffect(() => {
    engine?.setBrightness(brightness / 100);
  }, [engine, brightness]);

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
    <div className={palettesOpen ? "app palettes-open" : "app"}>
      <div className="panes">
        <div ref={hostRef} className="viewport" />
        {engine && (
          <Panes engine={engine} info={info} layout={layout} onLayout={setLayout} locked={locked} />
        )}
        {engine && <PasteOverlay engine={engine} />}
        {engine && (
          <HotbarBar hotbar={engine.hotbar} engine={engine} aside={<ToolBadge engine={engine} />} />
        )}
      </div>
      {engine && (
        <TopBar
          engine={engine}
          info={info}
          settings={settings}
          layout={layout}
          onLayout={setLayout}
          onSettings={setSettings}
          busy={loading !== null || benchStep !== null}
          volumeLighting={engine.volumeLighting}
          onSave={() => void project.save()}
          onNew={() => void project.create()}
          onRename={(name) => void project.rename(name)}
          devOpen={devOpen}
          onDev={toggleDev}
          palettesOpen={palettesOpen}
          onPalettes={togglePalettes}
          onHome={() => setHomeOpen(true)}
          keysOpen={keysOpen}
          onKeys={() => setKeysOpen((open) => !open)}
        />
      )}
      {engine && <EditorTools engine={engine} />}
      {engine && <Inventory engine={engine} />}
      {engine && <Toast engine={engine} />}
      {engine && <CutawayPanel engine={engine} />}
      {engine && <RegionDialog engine={engine} />}
      {engine && keysOpen && <KeysPanel tool={engine.tool.get()} onClose={closeKeys} />}
      {engine && palettesOpen && <PaletteDrawer engine={engine} />}
      <Hud
        backend={backend}
        stats={stats}
        settings={settings}
        onSettings={setSettings}
        busy={loading !== null || benchStep !== null}
        onBench={startBench}
        onHome={() => engine?.home()}
        open={devOpen}
        info={info}
        projects={projects}
        project={project}
        libraries={libraries}
        library={library}
      />
      {engine && homeOpen && (
        <Home
          engine={engine}
          projects={projects}
          openName={source !== "" && info ? info.name : null}
          onBack={() => setHomeOpen(false)}
          onOpen={(id) => {
            setSettings((s) => ({ ...s, world: savedSource(id) }));
            setHomeOpen(false);
          }}
          onNew={() => void project.create()}
          onSample={(kind) => {
            setSettings((s) => ({ ...s, world: kind }));
            setHomeOpen(false);
          }}
          project={project}
          libraries={libraries}
          library={library}
        />
      )}
      {(loading || benchStep) && <div className="banner">{benchStep ?? loading}…</div>}
      {bench && <BenchPanel result={bench} onClose={() => setBench(null)} />}
    </div>
  );
}

/** The selection panel and its actions. The panel follows the tool in hand. */
function EditorTools({ engine }: { engine: Engine }) {
  const tool = useStore(engine.tool);
  return <SelectionPanel engine={engine} tool={tool} />;
}
