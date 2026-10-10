import { type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAgentAccess, getAgentStatus, subscribeAgentAccess } from "../agent/agent-access.ts";
import type { Engine } from "../scene/Engine.ts";
import { clockLabel } from "../scene/sky-model.ts";
import type { Settings } from "../settings-url.ts";
import type { WorldInfo } from "../worlds.ts";
import { openHomeTab } from "./Home.tsx";
import { type LayoutPreset, type LayoutState, withPreset } from "./layout.ts";
import { ProjectSettingsDialog } from "./ProjectSettings.tsx";
import { canLockKeys, toggleFullscreen } from "./tab-guard.ts";
import { useStore } from "./useStore.ts";

interface TopBarProps {
  engine: Engine;
  info: WorldInfo | null;
  settings: Settings;
  layout: LayoutState;
  onLayout: (layout: LayoutState) => void;
  onSettings: (s: Settings) => void;
  busy: boolean;
  /** False when the renderer fell back to WebGL, which has no light volumes. */
  volumeLighting: boolean;
  onSave: () => void;
  onNew: () => void;
  /** The name the user typed. Empty and over-long names are refused here. */
  onRename: (name: string) => void;
  onNote: (note: string) => void;
  devOpen: boolean;
  onDev: () => void;
  palettesOpen: boolean;
  onPalettes: () => void;
  onHome: () => void;
  keysOpen: boolean;
  onKeys: () => void;
}

/**
 * The editor's top bar: the project (its name, which renames on click, and whether it is
 * saved), undo and redo, a new project, and how the view looks.
 */
const PRESETS: readonly { preset: LayoutPreset; label: string; title: string }[] = [
  { preset: "single", label: "Full", title: "One view, the whole window" },
  { preset: "columns", label: "Side", title: "Two views side by side" },
  { preset: "rows", label: "Stack", title: "Two views, one above the other" },
  { preset: "grid", label: "Grid", title: "Four views" },
];

export function TopBar({
  engine,
  info,
  settings,
  layout,
  onLayout,
  onSettings,
  busy,
  volumeLighting,
  onSave,
  onNew,
  onRename,
  onNote,
  devOpen,
  onDev,
  palettesOpen,
  onPalettes,
  onHome,
  keysOpen,
  onKeys,
}: TopBarProps) {
  const history = useStore(engine.history);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const name = useStore(engine.projectName) || info?.name || "";
  const rename = () => {
    const next = prompt("Project name", name);
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === "" || trimmed.length > 120) {
      if (trimmed.length > 120) alert("A project name can be at most 120 characters.");
      return;
    }
    onRename(trimmed);
  };
  // Buttons give keys back to the view after a click, so Space flies rather than re-clicks.
  const click = (action: () => void) => (e: MouseEvent<HTMLButtonElement>) => {
    action();
    e.currentTarget.blur();
  };
  return (
    <header className="topbar">
      <button
        type="button"
        className="brand"
        title="Home: your builds, palettes and blocks"
        onClick={click(onHome)}
      >
        <img className="brand-mark" src="/conduit-pillar.png" alt="" />
        Voxyl
      </button>
      <button type="button" title="Your builds, palettes and blocks" onClick={click(onHome)}>
        Home
      </button>
      <button
        type="button"
        className="project-title"
        disabled={!info}
        title="Rename"
        onClick={click(rename)}
      >
        {info ? name : "–"}
      </button>
      <button
        type="button"
        disabled={!info}
        title="Project settings: name, real north, the major grid"
        onClick={click(() => setSettingsOpen(true))}
      >
        Project
      </button>
      {info && settingsOpen && (
        <ProjectSettingsDialog
          engine={engine}
          info={info}
          onRename={onRename}
          onNote={onNote}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {info &&
        (info.saved ? (
          <span className="save-state">Saved in this browser</span>
        ) : (
          <>
            <span className="save-state">Not saved</span>
            <button type="button" disabled={busy} onClick={click(onSave)}>
              Save
            </button>
          </>
        ))}
      <span className="topbar-gap" />
      <button
        type="button"
        disabled={history.undo === null}
        title={history.undo === null ? "Nothing to undo" : `Undo ${history.undo} (Ctrl+Z)`}
        onClick={click(() => engine.undo())}
      >
        Undo
      </button>
      <button
        type="button"
        disabled={history.redo === null}
        title={history.redo === null ? "Nothing to redo" : `Redo ${history.redo} (Ctrl+Y)`}
        onClick={click(() => engine.redo())}
      >
        Redo
      </button>
      <button type="button" disabled={busy} onClick={click(onNew)}>
        New project
      </button>
      <span className="topbar-gap wide" />
      <span className="layout-presets">
        {PRESETS.map((item) => (
          <button
            key={item.preset}
            type="button"
            aria-pressed={layout.preset === item.preset}
            title={item.title}
            onClick={click(() => onLayout(withPreset(layout, item.preset)))}
          >
            {item.label}
          </button>
        ))}
      </span>
      <button type="button" aria-pressed={palettesOpen} onClick={click(onPalettes)}>
        Palettes
      </button>
      <ViewMenu
        settings={settings}
        onSettings={onSettings}
        busy={busy}
        volumeLighting={volumeLighting}
      />
      <button
        type="button"
        aria-pressed={keysOpen}
        title="Every key and mouse button"
        onClick={click(onKeys)}
      >
        Keys
      </button>
      <AgentsButton onHome={onHome} />
      <FullscreenButton />
      <button type="button" aria-pressed={devOpen} onClick={click(onDev)}>
        Dev
      </button>
    </header>
  );
}

/** Shows whether an agent can reach this editor; a click opens Home, Agents. */
function AgentsButton({ onHome }: { onHome: () => void }) {
  const access = useSyncExternalStore(subscribeAgentAccess, getAgentAccess);
  const status = useSyncExternalStore(subscribeAgentAccess, getAgentStatus);
  if (!access.enabled) return null;
  const live = status.state === "connected";
  return (
    <button
      type="button"
      title={live ? "Agents can use this editor" : "Agent access is on, but not connected"}
      onClick={() => {
        openHomeTab("agents");
        onHome();
      }}
    >
      <span className={live ? "agent-dot live" : "agent-dot"} aria-hidden="true" />
      Agents
    </button>
  );
}

/**
 * Fullscreen the page's own way. That is the only state where the browser lets the editor
 * keep Ctrl+W (and Ctrl+T, Ctrl+N, Ctrl+1-9) from closing or switching tabs while you fly.
 */
function FullscreenButton() {
  const [full, setFull] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const change = () => setFull(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  return (
    <button
      type="button"
      aria-pressed={full}
      title={
        canLockKeys()
          ? "Fullscreen. Ctrl+W, Ctrl+T and Ctrl+N then stay in the editor instead of closing the tab"
          : "Fullscreen (this browser can't keep Ctrl+W from closing the tab)"
      }
      onClick={(e) => {
        toggleFullscreen().catch(() => {});
        e.currentTarget.blur();
      }}
    >
      Fullscreen
    </button>
  );
}

/** The time of day as a clock, with midnight and noon named. */
export function timeLabel(hours: number): string {
  if (hours === 0 || hours === 24) return "midnight";
  if (hours === 12) return "noon";
  return clockLabel(hours);
}

/** Minecraft's names for the ends and middle of its Brightness slider. */
function brightnessLabel(brightness: number): string {
  if (brightness === 0) return "Moody";
  if (brightness === 50) return "50%";
  if (brightness === 100) return "Bright";
  return `${brightness}%`;
}

/** Lighting and brightness. Time of day is each 3D pane's own slider; a 2D pane has neither. */
function ViewMenu({
  settings,
  onSettings,
  busy,
  volumeLighting,
}: Pick<TopBarProps, "settings" | "onSettings" | "busy" | "volumeLighting">) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => {
          setOpen(!open);
          e.currentTarget.blur();
        }}
      >
        Light
      </button>
      {open && (
        <div className="menu-panel">
          <label>
            Lighting
            <select
              value={settings.lighting}
              disabled={busy}
              onChange={(e) =>
                onSettings({ ...settings, lighting: e.target.value as Settings["lighting"] })
              }
            >
              <option value="off">Off</option>
              <option value="volume" disabled={!volumeLighting}>
                On
              </option>
            </select>
          </label>
          <label>
            Brightness {brightnessLabel(settings.brightness)}
            <input
              type="range"
              min={0}
              max={100}
              value={settings.brightness}
              disabled={settings.lighting === "off"}
              onChange={(e) => onSettings({ ...settings, brightness: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
    </div>
  );
}
