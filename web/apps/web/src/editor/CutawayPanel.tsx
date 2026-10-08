import type { Engine } from "../scene/Engine.ts";
import { useStore } from "./useStore.ts";
import { blurAfter } from "./ViewBar.tsx";

const AXES = ["X", "Y", "Z"] as const;

/**
 * The cutaway's box, a face at a time. Open while you adjust it: the box is outlined in the
 * 3D views. Shift moves five cells. Nothing in the build changes; the cells in the box are only
 * hidden, so what is behind them can be seen and built on.
 */
export function CutawayPanel({ engine }: { engine: Engine }) {
  const open = useStore(engine.cutPanel);
  const cutaway = useStore(engine.cutaway);
  if (!open || cutaway.box === null) return null;
  const { box, on } = cutaway;
  const step = (axis: number, end: "min" | "max", direction: number) =>
    blurAfter(() => engine.nudgeCutaway(axis, end, direction));
  return (
    <section className="cutaway-panel" aria-label="Cutaway bounds">
      <header>
        <strong>Cutaway</strong>
        <label className="cutaway-on" title="Switch the cut off and on (H or End)">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              engine.toggleCutaway();
              e.currentTarget.blur();
            }}
          />
          On
        </label>
      </header>
      <p className="home-sub">
        Cells in this box are hidden in the 3D views. Move a face a cell at a time.
      </p>
      {AXES.map((name, axis) => (
        <div key={name} className="cutaway-row">
          <span>{name}</span>
          {(["min", "max"] as const).map((end) => (
            <span key={end} className="cutaway-face">
              <button
                type="button"
                aria-label={`${name} ${end} minus`}
                onClick={(e) => step(axis, end, e.shiftKey ? -5 : -1)(e)}
              >
                −
              </button>
              <output>{box[end][axis]}</output>
              <button
                type="button"
                aria-label={`${name} ${end} plus`}
                onClick={(e) => step(axis, end, e.shiftKey ? 5 : 1)(e)}
              >
                +
              </button>
              {end === "min" && <span className="cutaway-to">to</span>}
            </span>
          ))}
        </div>
      ))}
      <footer>
        <button type="button" onClick={blurAfter(() => engine.setCutPanel(false))}>
          Done
        </button>
        <button type="button" onClick={blurAfter(() => engine.setCutaway(null))}>
          Clear the cut
        </button>
      </footer>
    </section>
  );
}
