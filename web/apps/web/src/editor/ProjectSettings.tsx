import type { Direction } from "@voxyl/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine } from "../scene/Engine.ts";
import type { WorldInfo } from "../worlds.ts";
import { useStore } from "./useStore.ts";

const NORTHS: readonly { id: Direction; label: string; hint: string }[] = [
  {
    id: "north",
    label: "Up the screen (−Z)",
    hint: "The default: north is −Z, the far end of a new build.",
  },
  { id: "east", label: "East (+X)", hint: "The build's +X end is the real north." },
  { id: "south", label: "South (+Z)", hint: "The build's +Z end is the real north." },
  { id: "west", label: "West (−X)", hint: "The build's −X end is the real north." },
];

/**
 * The build's settings: its name, which of its own directions is the real north, and where the
 * major grid lines fall. North only orients the compass and the camera presets, and turns what
 * crosses between builds (a prefab keeps its north); no cell moves when it changes. All of it
 * undoes.
 */
export function ProjectSettingsDialog({
  engine,
  info,
  onRename,
  onClose,
}: {
  engine: Engine;
  info: WorldInfo;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const north = useStore(engine.north);
  const currentName = useStore(engine.projectName) || info.name;
  const [name, setName] = useState(currentName);
  const [grid, setGrid] = useState<[number, number]>([info.grid[0], info.grid[1]]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);

  const run = (work: Promise<void>) =>
    void work.then(
      () => setError(null),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  const setOffset = (axis: 0 | 1, value: number) => {
    const clamped = Math.max(0, Math.min(15, Math.round(value) || 0));
    const next: [number, number] = [...grid];
    next[axis] = clamped;
    setGrid(next);
    run(engine.setProjectSettings({ grid: next }));
  };
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 120) {
      setName(currentName);
      return;
    }
    if (trimmed !== currentName) onRename(trimmed);
  };
  const hint = NORTHS.find((n) => n.id === north)?.hint;

  return createPortal(
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={onClose} />
      <div className="keys-card project-settings" role="dialog" aria-label="Project settings">
        <header>
          <strong>Project settings</strong>
          <span />
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {error && <p className="palette-error">{error}</p>}
        <label>
          Name
          <input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <label>
          Real north
          <select
            value={north}
            onChange={(e) => run(engine.setProjectSettings({ north: e.target.value as Direction }))}
          >
            {NORTHS.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <p className="home-sub">
          {hint} It sets the compass and the camera presets. No cell moves; prefabs and copies keep
          their own north, so they land the right way round.
        </p>
        <div className="project-grid">
          <span>Major grid lines every 16 cells, starting at</span>
          <label>
            x
            <input
              type="number"
              min={0}
              max={15}
              value={grid[0]}
              onChange={(e) => setOffset(0, e.target.valueAsNumber)}
            />
          </label>
          <label>
            z
            <input
              type="number"
              min={0}
              max={15}
              value={grid[1]}
              onChange={(e) => setOffset(1, e.target.valueAsNumber)}
            />
          </label>
        </div>
        <p className="home-sub">
          Where the heavier lines fall on the ground grid and in the 2D view, so they can match the
          build's own layout (a 16-wide hall starts on a line).
        </p>
      </div>
    </div>,
    document.body,
  );
}
