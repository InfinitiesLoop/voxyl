import { ROOT_PALETTE, type SemanticArg } from "@voxyl/core";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo } from "../world/editing.ts";
import type { SelectionRow } from "../world/protocol.ts";
import { countText, grouped, stacks } from "./counts.ts";
import type { EditorTool } from "./tool.ts";
import { useStore } from "./useStore.ts";

const MODE_KEY = "voxyl.countMode";

interface Option {
  readonly key: string;
  readonly ref: SemanticArg;
  readonly label: string;
}

/**
 * What the selection holds, and the region commands on it. Open while Select or Wand is the
 * tool, and whenever something is selected.
 */
export function SelectionPanel({ engine, tool }: { engine: Engine; tool: EditorTool }) {
  const selection = useStore(engine.selection);
  const anchor = useStore(engine.anchor);
  const notice = useStore(engine.notice);
  const palettes = useStore(engine.palettes);
  const hotbar = useStore(engine.hotbar.state);
  const slot = hotbar.slots[hotbar.selected] ?? null;
  const [mode, setMode] = useState<"semantics" | "blocks">(() =>
    localStorage.getItem(MODE_KEY) === "blocks" ? "blocks" : "semantics",
  );
  const [copied, setCopied] = useState(false);
  const fromOptions = useMemo(() => semanticOptions(selection.semantics), [selection.semantics]);
  const toOptions = useMemo(() => paletteOptions(palettes), [palettes]);
  const [fromKey, setFromKey] = useState("");
  const [toKey, setToKey] = useState("");

  useEffect(() => {
    if (!fromOptions.some((option) => option.key === fromKey))
      setFromKey(fromOptions[0]?.key ?? "");
  }, [fromOptions, fromKey]);

  useEffect(() => {
    if (toOptions.some((option) => option.key === toKey)) return;
    const match = slot ? toOptions.find((option) => sameRef(option.ref, slot.ref)) : undefined;
    setToKey(match?.key ?? toOptions[0]?.key ?? "");
  }, [toOptions, toKey, slot]);

  if (tool === "build" && selection.cells === 0 && anchor === null) return null;

  const rows = mode === "semantics" ? selection.semantics : selection.materials;
  const empty = selection.cells - selection.occupied;
  const from = fromOptions.find((option) => option.key === fromKey);
  const to = toOptions.find((option) => option.key === toKey);
  const click = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    action();
    event.currentTarget.blur();
  };
  const step = (
    event: MouseEvent<HTMLButtonElement>,
    action: (amount: number) => void,
    direction: number,
  ) => {
    action((event.shiftKey ? 5 : 1) * direction);
    event.currentTarget.blur();
  };

  return (
    <aside className="selection-panel">
      <header>
        <strong>Selection</strong>
        {selection.bounds && <span>{sizeOf(selection.bounds)}</span>}
      </header>
      {selection.cells === 0 && (
        <p className="selection-lead">
          {anchor
            ? `First corner at ${anchor.join(", ")}. Right-click the opposite corner.`
            : tool === "wand"
              ? "Right-click a block to select every block of that kind touching it. Shift+click selects any kind."
              : "Right-click two corners of a box. A third click clears it."}
        </p>
      )}
      {selection.cells > 0 && (
        <>
          <p className="selection-lead">
            {grouped(selection.cells)} cells
            {selection.occupied !== selection.cells && ` · ${grouped(selection.occupied)} filled`}
            {!selection.exact && " · outline shows the box around them"}
          </p>
          <div className="selection-mode">
            <button
              type="button"
              className={mode === "semantics" ? "active" : undefined}
              onClick={click(() => {
                localStorage.setItem(MODE_KEY, "semantics");
                setMode("semantics");
                setCopied(false);
              })}
            >
              Semantics
            </button>
            <button
              type="button"
              className={mode === "blocks" ? "active" : undefined}
              onClick={click(() => {
                localStorage.setItem(MODE_KEY, "blocks");
                setMode("blocks");
                setCopied(false);
              })}
            >
              Blocks
            </button>
            <button
              type="button"
              onClick={click(() => {
                const text = listText(selection.bounds, rows, mode === "semantics" ? empty : 0);
                void navigator.clipboard.writeText(text).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              })}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="selection-scroll">
            {rows.map((row) => (
              <Row key={`${row.semantic}:${row.name}:${row.detail ?? ""}`} row={row} />
            ))}
            {mode === "semantics" && empty > 0 && (
              <Row
                row={{ semantic: 0, name: "Empty", color: "transparent", count: empty }}
                hollow
              />
            )}
            {rows.length === 0 && empty === 0 && <p className="selection-lead">Nothing in it.</p>}
          </div>
        </>
      )}
      <div className="selection-actions">
        <button
          type="button"
          disabled={selection.cells === 0}
          title="Grow one cell through every face. Shift+click grows five."
          onClick={(event) => step(event, (amount) => engine.growSelection(amount), 1)}
        >
          Grow
        </button>
        <button
          type="button"
          disabled={selection.cells === 0}
          title="Shrink one cell through every face. Shift+click shrinks five."
          onClick={(event) => step(event, (amount) => engine.shrinkSelection(amount), 1)}
        >
          Shrink
        </button>
        <button
          type="button"
          disabled={!slot || selection.cells === 0}
          title={slot ? `Fill every selected cell with ${slot.name}` : "Choose a hotbar slot first"}
          onClick={click(() => engine.fillSelection())}
        >
          Fill{slot ? ` with ${slot.name}` : ""}
        </button>
        <button
          type="button"
          disabled={selection.occupied === 0}
          title="Empty the selected cells. The Delete key does this too."
          onClick={click(() => engine.clearSelection())}
        >
          Clear
        </button>
        <button
          type="button"
          disabled={!slot || selection.occupied === 0}
          title={
            slot
              ? `Turn occupied cells into whole ${slot.name} blocks. Empty cells stay empty.`
              : "Choose a hotbar slot first"
          }
          onClick={click(() => engine.replaceSelection())}
        >
          Replace{slot ? ` with ${slot.name}` : ""}
        </button>
      </div>
      {selection.box && selection.bounds && (
        <div className="nudge">
          <p>Move a face. Shift+click moves five.</p>
          {([0, 1, 2] as const).map((axis) => (
            <div key={axis} className="nudge-row">
              <span>{["X", "Y", "Z"][axis]}</span>
              <Face
                value={selection.bounds?.[axis] ?? 0}
                onNudge={(event, direction) =>
                  step(event, (amount) => engine.nudgeSelection(axis, false, amount), direction)
                }
              />
              <span className="nudge-to">to</span>
              <Face
                value={selection.bounds?.[axis + 3] ?? 0}
                onNudge={(event, direction) =>
                  step(event, (amount) => engine.nudgeSelection(axis, true, amount), direction)
                }
              />
            </div>
          ))}
        </div>
      )}
      {selection.occupied > 0 && fromOptions.length > 0 && toOptions.length > 0 && (
        <div className="resemantic">
          <span>Re-semantic</span>
          <select
            aria-label="From"
            value={fromKey}
            onChange={(event) => setFromKey(event.target.value)}
          >
            {fromOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="resemantic-to">
            <span>to</span>
            <select
              aria-label="To"
              value={toKey}
              onChange={(event) => setToKey(event.target.value)}
            >
              {toOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={!from || !to || sameRef(from.ref, to.ref)}
            title="Switch one semantic for another, keeping each cell's shape"
            onClick={click(() => {
              if (from && to) engine.resemanticSelection(from.ref, to.ref);
            })}
          >
            Apply
          </button>
        </div>
      )}
      <button
        type="button"
        className="selection-deselect"
        disabled={selection.cells === 0 && anchor === null}
        onClick={click(() => engine.deselect())}
      >
        Deselect
      </button>
      {notice !== "" && <p className="selection-notice">{notice}</p>}
    </aside>
  );
}

function Row({ row, hollow = false }: { row: SelectionRow; hollow?: boolean }) {
  const breakdown = stacks(row.count);
  return (
    <div className={hollow ? "selection-row hollow" : "selection-row"}>
      <span className="selection-swatch" style={hollow ? undefined : { background: row.color }} />
      <span className="selection-name">
        {row.name}
        {row.detail && <small>{row.detail}</small>}
      </span>
      <span className="selection-count">
        {grouped(row.count)}
        {breakdown !== "" && <small>{breakdown}</small>}
      </span>
    </div>
  );
}

function Face({
  value,
  onNudge,
}: {
  value: number;
  onNudge: (event: MouseEvent<HTMLButtonElement>, direction: number) => void;
}) {
  return (
    <>
      <button type="button" onClick={(event) => onNudge(event, -1)} aria-label="Decrease">
        −
      </button>
      <span className="nudge-value">{value}</span>
      <button type="button" onClick={(event) => onNudge(event, 1)} aria-label="Increase">
        +
      </button>
    </>
  );
}

function sizeOf(bounds: readonly [number, number, number, number, number, number]): string {
  return `${bounds[3] - bounds[0] + 1} × ${bounds[4] - bounds[1] + 1} × ${bounds[5] - bounds[2] + 1}`;
}

function listText(
  bounds: readonly [number, number, number, number, number, number] | null,
  rows: readonly SelectionRow[],
  empty: number,
): string {
  const lines = [bounds ? sizeOf(bounds) : "Selection"];
  for (const row of rows) {
    const name = row.detail ? `${row.name} (${row.detail})` : row.name;
    lines.push(`${name}\t${countText(row.count)}`);
  }
  if (empty > 0) lines.push(`Empty\t${countText(empty)}`);
  return lines.join("\n");
}

function semanticOptions(rows: readonly SelectionRow[]): Option[] {
  const seen = new Map<number, Option & { count: number }>();
  for (const row of rows) {
    const prev = seen.get(row.semantic);
    if (prev && prev.count >= row.count) continue;
    seen.set(row.semantic, {
      key: `#${row.semantic}`,
      ref: row.semantic,
      label: row.name,
      count: row.count,
    });
  }
  return [...seen.values()];
}

function paletteOptions(palettes: readonly PaletteInfo[]): Option[] {
  const many = palettes.length > 1;
  return palettes.flatMap((palette) =>
    palette.semantics.map((semantic) => ({
      key: refKey(semantic.ref),
      ref: semantic.ref,
      label:
        many && palette.id !== ROOT_PALETTE ? `${palette.name} · ${semantic.name}` : semantic.name,
    })),
  );
}

function refKey(ref: SemanticArg): string {
  return typeof ref === "number" ? `#${ref}` : `${ref.palette}:${ref.base}`;
}

function sameRef(a: SemanticArg, b: SemanticArg): boolean {
  if (typeof a === "number" || typeof b === "number") return a === b;
  return a.palette === b.palette && a.base === b.base;
}
