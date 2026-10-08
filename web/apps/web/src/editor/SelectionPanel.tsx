import type { MouseEvent } from "react";
import type { Engine } from "../scene/Engine.ts";
import { grouped } from "./counts.ts";
import { Manifest } from "./Manifest.tsx";
import { SelectionActions, SelectionToolbar } from "./selection-actions.tsx";
import type { EditorTool } from "./tool.ts";
import { useStore } from "./useStore.ts";

/**
 * The selection and everything to do with it: what it holds, cut / copy / save as prefab /
 * export along the top, how to change its shape, and the other actions. Open while Select is
 * the tool and something is selected.
 */
export function SelectionPanel({ engine, tool }: { engine: Engine; tool: EditorTool }) {
  const selection = useStore(engine.selection);
  const anchor = useStore(engine.anchor);
  const notice = useStore(engine.notice);
  if (tool !== "select") return null;
  if (selection.cells === 0 && anchor === null) return null;

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
      {selection.cells > 0 && <SelectionToolbar engine={engine} />}
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
          <Manifest
            title={selection.bounds ? sizeOf(selection.bounds) : "Selection"}
            semantics={selection.semantics}
            materials={selection.materials}
            empty={selection.occupied > 0 ? "Nothing in it." : undefined}
          />
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
      {selection.cells > 0 && <SelectionActions engine={engine} />}
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
