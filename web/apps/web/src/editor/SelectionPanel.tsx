import { type MouseEvent, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { SelectionRow } from "../world/protocol.ts";
import { countText, grouped, stacks } from "./counts.ts";
import type { EditorTool } from "./tool.ts";
import { useStore } from "./useStore.ts";

const MODE_KEY = "voxyl.countMode";

/**
 * What the selection holds, and how to change its shape. Open while Select is the
 * tool and something is selected. Things done *to* the cells live in the actions menu.
 */
export function SelectionPanel({ engine, tool }: { engine: Engine; tool: EditorTool }) {
  const selection = useStore(engine.selection);
  const anchor = useStore(engine.anchor);
  const notice = useStore(engine.notice);
  const [mode, setMode] = useState<"semantics" | "blocks">(() =>
    localStorage.getItem(MODE_KEY) === "blocks" ? "blocks" : "semantics",
  );
  const [copied, setCopied] = useState(false);

  if (tool !== "select") return null;
  if (selection.cells === 0 && anchor === null) return null;

  const rows = mode === "semantics" ? selection.semantics : selection.materials;
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
      {selection.cells === 0 && anchor && (
        <p className="selection-lead">
          First corner at {anchor.join(", ")}. Right-click the opposite corner.
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
                void navigator.clipboard.writeText(listText(selection.bounds, rows)).then(
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
            {rows.length === 0 && selection.occupied > 0 && (
              <p className="selection-lead">Nothing in it.</p>
            )}
          </div>
        </>
      )}
      <div className="selection-actions">
        <button
          type="button"
          disabled={selection.cells === 0}
          title="Grow one cell in every direction, including diagonals, so a box stays a box. Shift+click grows five."
          onClick={(event) => step(event, (amount) => engine.growSelection(amount, true), 1)}
        >
          Grow
        </button>
        <button
          type="button"
          disabled={selection.cells === 0}
          title="Grow through faces only, skipping diagonals. A box stops being a box. Shift+click grows five."
          onClick={(event) => step(event, (amount) => engine.growSelection(amount, false), 1)}
        >
          Faces
        </button>
        <button
          type="button"
          disabled={selection.cells === 0}
          title="Shrink one cell through every face. Shift+click shrinks five."
          onClick={(event) => step(event, (amount) => engine.shrinkSelection(amount), 1)}
        >
          Shrink
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

function Row({ row }: { row: SelectionRow }) {
  const breakdown = stacks(row.count);
  return (
    <div className="selection-row">
      <span className="selection-swatch" style={{ background: row.color }} />
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
): string {
  const lines = [bounds ? sizeOf(bounds) : "Selection"];
  for (const row of rows) {
    const name = row.detail ? `${row.name} (${row.detail})` : row.name;
    lines.push(`${name}\t${countText(row.count)}`);
  }
  return lines.join("\n");
}
