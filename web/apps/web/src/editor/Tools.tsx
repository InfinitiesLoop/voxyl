import type { Engine } from "../scene/Engine.ts";
import { KEYMAP, keyLabel } from "./keymap.ts";
import { type EditorTool, usesBrush } from "./tool.ts";
import { useStore } from "./useStore.ts";
import { blurAfter } from "./ViewBar.tsx";

export const TOOLS: readonly { id: EditorTool; label: string; hint: string }[] = [
  { id: "build", label: "Build", hint: "Right click places a block; left click removes one." },
  {
    id: "column",
    label: "Build to me",
    hint: "Right click lays a column from the face you aim at toward you, as wide as the brush.",
  },
  {
    id: "wand",
    label: "Wand",
    hint: "Right click a face: every open face of that kind of block in its plane, touching it, gets a block. A wall grows a layer; a floor rises one.",
  },
  {
    id: "exchange",
    label: "Exchange",
    hint: "Right click swaps the block you aim at, and the same blocks touching it within the brush, for the hotbar's, in place.",
  },
  {
    id: "select",
    label: "Select",
    hint: "Right click two corners of a box; a third click clears. Shift+right click selects the blocks touching the one clicked.",
  },
];

const BRUSHES = [1, 3, 5, 7, 9] as const;

/** How to switch tools from the keyboard, for the tooltips. */
function toolKeys(): string {
  const k = KEYMAP.nextTool;
  return [...k.binding, ...k.alternate].map(keyLabel).join(" or ");
}

/**
 * The tools, inside the inventory beside its hotbar (as in the Godot app): the pointer stays
 * with the view while flying, and Q (or Num *) steps through them. Below the buttons, what
 * the tool in hand does, and its options.
 */
export function ToolStrip({ engine }: { engine: Engine }) {
  const tool = useStore(engine.tool);
  const brush = useStore(engine.brush);
  const connectAny = useStore(engine.connectAny);
  const current = TOOLS.find((item) => item.id === tool);
  return (
    <div className="tool-strip">
      <div className="tool-strip-buttons" role="toolbar" aria-label="Tools">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tool === item.id}
            title={`${item.hint} (${toolKeys()} steps through the tools)`}
            onClick={blurAfter(() => engine.setTool(item.id))}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="tool-strip-hint">{current?.hint}</p>
      {usesBrush(tool) && (
        <div className="tool-options">
          <span className="tool-options-label">Brush</span>
          {BRUSHES.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={brush === size}
              onClick={blurAfter(() => engine.setBrush(size))}
            >
              {size}×{size}
            </button>
          ))}
        </div>
      )}
      {tool === "select" && (
        <label className="tool-options">
          <input
            type="checkbox"
            checked={connectAny}
            onChange={(e) => {
              engine.connectAny.set(e.target.checked);
              e.currentTarget.blur();
            }}
          />
          Shift+right click takes touching blocks of any kind
        </label>
      )}
    </div>
  );
}

/**
 * Which tool is in hand, beside the workspace hotbar, with its brush. A click opens the
 * inventory, where tools are chosen.
 */
export function ToolBadge({ engine }: { engine: Engine }) {
  const tool = useStore(engine.tool);
  const brush = useStore(engine.brush);
  const current = TOOLS.find((item) => item.id === tool);
  return (
    <button
      type="button"
      className="tool-badge"
      title={`${current?.hint ?? ""} Change tools in the inventory (E or Delete), or with ${toolKeys()}.`}
      onClick={blurAfter(() => engine.toggleInventory())}
    >
      <span className="tool-badge-label">Tool</span>
      {current?.label}
      {usesBrush(tool) && brush > 1 && (
        <span className="tool-badge-brush">
          {" "}
          {brush}×{brush}
        </span>
      )}
    </button>
  );
}
