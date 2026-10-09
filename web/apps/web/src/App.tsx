import type { ProjectEntry } from "@voxyl/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BenchResult, runBench } from "./bench/bench.ts";
import { download } from "./download.ts";
import { CutawayPanel } from "./editor/CutawayPanel.tsx";
import { Home, openHomeTab } from "./editor/Home.tsx";
import { HotbarBar } from "./editor/HotbarBar.tsx";
import { Inventory } from "./editor/Inventory.tsx";
import { clearBlockIcons } from "./editor/icons.tsx";
import { KeysPanel } from "./editor/KeysPanel.tsx";
import {
  focusedPane,
  type LayoutState,
  readLayout,
  saveLayout,
  withTime,
} from "./editor/layout.ts";
import { NotePanel } from "./editor/NotePanel.tsx";
import type { NoteTarget } from "./editor/note.ts";
import { PaletteDrawer } from "./editor/PaletteDrawer.tsx";
import { Panes } from "./editor/Panes.tsx";
import { PasteOverlay } from "./editor/PasteOverlay.tsx";
import { RegionDialog } from "./editor/RegionDialog.tsx";
import { SelectionPanel } from "./editor/SelectionPanel.tsx";
import { Toast } from "./editor/Toast.tsx";
import { ToolBadge } from "./editor/Tools.tsx";
import { TopBar } from "./editor/TopBar.tsx";
import { installTabGuard } from "./editor/tab-guard.ts";
import { useStore } from "./editor/useStore.ts";
import { BenchPanel, Hud } from "./Hud.tsx";
import { type Backend, Engine, type EngineStats } from "./scene/Engine.ts";
import { SUNSET } from "./scene/sky-model.ts";
import { readSettings, type Settings, settingsQuery } from "./settings-url.ts";
import type { LibraryInfo } from "./world/protocol.ts";
import {
  CHUNK_SIZE,
  MC_BLOCKS_NOTE,
  sampleKind,
  savedId,
  savedSource,
  WORLD_KINDS,
  type WorldInfo,
  type WorldKind,
} from "./worlds.ts";

export type { Settings };

const DEV_KEY = "voxyl.dev";
const PALETTES_KEY = "voxyl.palettes";

/** A sample opened with no time of its own starts at sunset. An explicit `time` stays. */
function sampleOnArrival(world: string, params: URLSearchParams): boolean {
  return sampleKind(world) !== null && !params.has("time") && !params.has("daylight");
}

/** Puts the current link in the address bar. Home, and a build at every default, stay clean. */
function syncAddress(settings: Settings, home: boolean): void {
  const qs = settingsQuery(settings, home);
  const next = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`;
  if (`${location.pathname}${location.search}${location.hash}` !== next) {
    history.replaceState(null, "", next);
  }
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [settings, setSettings] = useState(() =>
    readSettings(new URLSearchParams(location.search)),
  );
  const [layout, setLayout] = useState<LayoutState>(() => {
    const params = new URLSearchParams(location.search);
    const stored = readLayout(settings.time, params);
    // A sample linked with no time of its own opens at sunset; an explicit time stays.
    return sampleOnArrival(settings.world, params) ? withTime(stored, SUNSET) : stored;
  });
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
  /** Set after the first library list, so a missing jar isn't guessed before that. */
  const [librariesReady, setLibrariesReady] = useState(false);
  /** The opening note on screen, from a project or from a demo that can't start yet. */
  const [openingNote, setOpeningNote] = useState<string | null>(null);
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
  const [homeOpen, setHomeOpen] = useState(() => settings.world === "");
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

  // Ctrl+W while flying closes the tab: ask first (see editor/tab-guard.ts for what holds).
  const infoRef = useRef(info);
  infoRef.current = info;
  useEffect(() => {
    if (!engine) return;
    return installTabGuard(() => ({
      hasProject: infoRef.current !== null,
      saved: Boolean(infoRef.current?.saved),
      flying: engine.flying.get(),
    }));
  }, [engine]);

  // The project's north is a setting that can change (and undo) while it is open.
  useEffect(() => {
    if (!engine) return;
    return engine.north.subscribe(() => {
      const north = engine.north.get();
      setInfo((current) => (current && current.north !== north ? { ...current, north } : current));
    });
  }, [engine]);

  useEffect(() => syncAddress(settings, homeOpen), [settings, homeOpen]);

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
  const { world: source, theme, lighting, brightness } = settings;
  // A link that names an hour keeps it for the build it opened. The next sample sets sunset.
  const pinnedTime = useRef(
    new URLSearchParams(location.search).has("time") ||
      new URLSearchParams(location.search).has("daylight"),
  );

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
    setLibrariesReady(true);
    engine.libraries.set(list);
  }, [engine]);

  useEffect(() => {
    void refreshLibraries();
  }, [refreshLibraries]);

  // Lighting is applied before a load in this commit, so a world opened with lighting on is lit
  // while it is built rather than rebuilt dark and then lit. The banner is for turning it on
  // under a world already on screen; the first open lights as part of generating.
  useEffect(() => {
    if (!engine) return;
    const turningOn = lighting !== "off" && engine.lighting === "off" && info !== null;
    const work = engine.setLighting(lighting);
    if (turningOn) track("Lighting the world", work);
  }, [engine, lighting, track, info]);

  // Generate a sample or open a saved project when the source changes. Both happen (and, with
  // lighting on, light) in the world worker, so the page stays responsive.
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
    const sample = WORLD_KINDS.find((w) => w.kind === source);
    if (sample && !pinnedTime.current) setLayout((current) => withTime(current, SUNSET));
    pinnedTime.current = false;
    const label = sample ? `Generating ${sample.label}` : "Opening the project";
    const work = engine.load(source, CHUNK_SIZE, themeRef.current).then((loaded) => {
      if (!loaded) return;
      setInfo(loaded);
      setOpeningNote(loaded.note || null);
      // The theme picker shows what the project looks like; picking another re-skins it.
      const shown = loaded.theme;
      if (shown === null) return;
      appliedTheme.current = shown;
      setSettings((s) => (s.theme === shown ? s : { ...s, theme: shown }));
    });
    work.catch((error: unknown) => {
      console.error(`Couldn't open ${source}`, error);
      if (source === "mc-blocks") {
        setSettings((s) => (s.world === "mc-blocks" ? { ...s, world: "" } : s));
        setHomeOpen(true);
        setOpeningNote(MC_BLOCKS_NOTE);
      }
    });
    track(label, work);
    // reloads only asks for the same source again.
    void reloads;
  }, [engine, source, track, reloads]);

  const openSample = (kind: WorldKind) => {
    const missingJar =
      kind === "mc-blocks" &&
      librariesReady &&
      !libraries.some((library) => library.id === "minecraft");
    if (missingJar) {
      setOpeningNote(MC_BLOCKS_NOTE);
      return;
    }
    pinnedTime.current = false;
    setOpeningNote(null);
    setSettings((s) => ({ ...s, world: kind }));
    setHomeOpen(false);
  };

  const followNote = (target: NoteTarget) => {
    setOpeningNote(null);
    if ("tab" in target) {
      openHomeTab(target.tab);
      setHomeOpen(true);
      return;
    }
    openSample(target.sample);
  };

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
    /** Libraries were stored by the import worker: read them in and show them. */
    reload: async () => {
      if (!engine) return;
      await engine.world.request({ type: "reloadLibraries" });
      await refreshLibraries();
      clearBlockIcons(engine);
    },
    delete: async (id: string, name: string) => {
      if (!engine || !confirm(`Remove ${name} from this browser?`)) return;
      await engine.world.request({ type: "deleteLibrary", id });
      clearBlockIcons(engine);
      await refreshLibraries();
    },
    deleteMany: async (items: readonly { id: string; name: string }[]) => {
      if (!engine || items.length === 0) return;
      const list =
        items.length <= 5 ? items.map((i) => i.name).join(", ") : `${items.length} libraries`;
      if (!confirm(`Remove ${list} from this browser?`)) return;
      for (const item of items) await engine.world.request({ type: "deleteLibrary", id: item.id });
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
          onNote={(note) => setInfo((current) => (current ? { ...current, note } : current))}
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
          onSample={openSample}
          project={project}
          libraries={libraries}
          library={library}
        />
      )}
      {openingNote !== null && (
        <NotePanel note={openingNote} onClose={() => setOpeningNote(null)} onGo={followNote} />
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
