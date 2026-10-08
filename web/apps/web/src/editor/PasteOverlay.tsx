import type { Engine } from "../scene/Engine.ts";
import { KEYMAP, keyLabel } from "./keymap.ts";
import { useStore } from "./useStore.ts";
import { blurAfter } from "./ViewBar.tsx";

/** The keys for an action, for a tooltip. */
function keyHint(action: "rotateBlock" | "mirrorPaste"): string {
  const k = KEYMAP[action];
  return [...k.binding, ...k.alternate].map(keyLabel).join(" or ");
}

const AXES = ["x", "y", "z"] as const;

/**
 * The paste's own small panel, for the clipboard and for a prefab being placed (both are the
 * Paste tool). Flying, it is a quiet line that says what is held and how to drive it. Middle
 * click frees the cursor and the panel turns into the controls: turn, mirror, shift, place.
 * The paste stays drawn where it was aimed, so the result can be watched while it is adjusted.
 * It sits in a corner, away from the build.
 */
export function PasteOverlay({ engine }: { engine: Engine }) {
  const tool = useStore(engine.tool);
  const clipboard = useStore(engine.clipboard);
  const paste = useStore(engine.paste);
  const lock = useStore(engine.pasteLock);
  const flying = useStore(engine.flying);
  const inventory = useStore(engine.inventoryOpen);
  if (tool !== "paste" || inventory) return null;
  const name = clipboard
    ? `${clipboard.from === "selection" ? "Clipboard" : clipboard.from} · ${clipboard.size.join("×")}`
    : "Nothing to paste";
  const shifted = paste.offset.some((v) => v !== 0);
  if (flying) {
    return (
      <section className="paste-overlay quiet" aria-label="Paste">
        <strong className="paste-title">Paste</strong>
        <span className="paste-name">{name}</span>
        {(paste.turn !== 0 || paste.mirror || shifted) && (
          <span className="paste-state">
            {[
              paste.turn !== 0 && `turn ${paste.turn * 90}°`,
              paste.mirror && "mirrored",
              shifted && `shift ${paste.offset.join(", ")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
        {lock && <span className="paste-locked">pinned</span>}
        <span className="paste-keys">
          Left click pins · right click places · middle click adjusts · Esc cancels
        </span>
      </section>
    );
  }
  return (
    <section className="paste-overlay" aria-label="Paste">
      <header>
        <strong className="paste-title">Paste</strong>
        <span className="paste-name">{name}</span>
      </header>
      <div className="paste-row">
        <button
          type="button"
          title={`Turn it a quarter turn the other way (Shift + ${keyHint("rotateBlock")})`}
          onClick={blurAfter(() => engine.turnPaste(-1))}
        >
          ⟲
        </button>
        <button
          type="button"
          title={`Turn it a quarter turn (${keyHint("rotateBlock")})`}
          onClick={blurAfter(() => engine.turnPaste(1))}
        >
          ⟳
        </button>
        <output title="Turned this far">{paste.turn * 90}°</output>
        <button
          type="button"
          aria-pressed={paste.mirror}
          title={`Mirror it, east for west (${keyHint("mirrorPaste")})`}
          onClick={blurAfter(() => engine.mirrorPaste())}
        >
          Mirror
        </button>
      </div>
      <div className="paste-row offsets">
        {AXES.map((axis, i) => (
          <span key={axis} className="paste-offset" title={`Shift it along ${axis}`}>
            <span className={`axis ${axis}`}>{axis}</span>
            <button
              type="button"
              aria-label={`${axis} minus`}
              onClick={blurAfter(() => engine.nudgePaste(i, -1))}
            >
              −
            </button>
            <output>{paste.offset[i]}</output>
            <button
              type="button"
              aria-label={`${axis} plus`}
              onClick={blurAfter(() => engine.nudgePaste(i, 1))}
            >
              +
            </button>
          </span>
        ))}
      </div>
      <div className="paste-row">
        <label title="The clipboard's empty cells clear what they land on">
          <input
            type="checkbox"
            checked={paste.air}
            onChange={(e) => {
              engine.setPaste({ air: e.target.checked });
              e.currentTarget.blur();
            }}
          />
          Clear what it lands on
        </label>
        <button
          type="button"
          title="Back to turn 0, no mirror, no shift"
          onClick={blurAfter(() => engine.setPaste({ turn: 0, mirror: false, offset: [0, 0, 0] }))}
        >
          Reset
        </button>
      </div>
      <footer>
        <button
          type="button"
          className="primary"
          disabled={!clipboard}
          title="Put it down where it is shown (right click does the same while flying)"
          onClick={blurAfter(() => void engine.placePaste())}
        >
          Place
        </button>
        <button
          type="button"
          aria-pressed={lock !== null}
          title="Pin it where it is, so it stays when you fly (left click while flying)"
          onClick={blurAfter(() => engine.togglePasteLock())}
        >
          {lock ? "Pinned" : "Pin"}
        </button>
        <button
          type="button"
          title="Back to flying with the paste still in hand"
          onClick={blurAfter(() => engine.closePasteAdjust())}
        >
          Fly
        </button>
        <button
          type="button"
          title="Stop pasting (Esc)"
          onClick={blurAfter(() => engine.cancelPaste())}
        >
          Cancel
        </button>
      </footer>
    </section>
  );
}
