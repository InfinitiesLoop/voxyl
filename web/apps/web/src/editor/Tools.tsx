import type { ReactNode } from "react";
import type { Engine } from "../scene/Engine.ts";
import { codesOf, KEYMAP, keyLabel } from "./keymap.ts";
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
    id: "paste",
    label: "Paste",
    hint: "Right click puts the clipboard (or a prefab) with its middle on the cell you aim at. Left click pins it there. Middle click opens its panel to turn, mirror and shift it. Esc stops. Copy a selection with Ctrl+C first, or pick a prefab.",
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
  const farSide = useStore(engine.farSide);
  const current = TOOLS.find((item) => item.id === tool);
  return (
    <div className="tool-strip">
      <div className="tool-strip-buttons" role="toolbar" aria-label="Tools">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={tool === item.id}
            title={`${item.label}. ${item.hint} (${toolKeys()} steps through the tools)`}
            onClick={blurAfter(() => engine.setTool(item.id))}
          >
            <ToolIcon id={item.id} />
            <span className="tool-strip-name">{item.label}</span>
          </button>
        ))}
      </div>
      <p className="tool-strip-hint">{current?.hint}</p>
      {/* One row tall whatever the tool, so choosing tools never moves the hotbar. */}
      <div className="tool-options-slot">
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
        {tool === "build" && (
          <label
            className="tool-options"
            title="A shaped part (a cover, strip, roof tile ...) goes on the far side of the cell it would land in. Holding the key or a mouse thumb button does the same while it is down."
          >
            <input
              type="checkbox"
              checked={farSide}
              onChange={(e) => {
                engine.setFarSide(e.target.checked);
                e.currentTarget.blur();
              }}
            />
            Far side for shaped parts ({codesOf("placeOpposite").slice(0, 1).map(keyLabel)} held)
          </label>
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
      aria-label={current?.label ?? "Tool"}
      title={`${current?.label ?? "Tool"}. ${current?.hint ?? ""} Change tools in the inventory (E or Delete), or with ${toolKeys()}.`}
      onClick={blurAfter(() => engine.toggleInventory())}
    >
      <ToolIcon id={tool} />
      {usesBrush(tool) && brush > 1 && <span className="tool-badge-brush">{brush}</span>}
    </button>
  );
}

/** A small picture for each tool, in the inventory and on the badge beside the hotbar. */
export function ToolIcon({ id }: { id: EditorTool }) {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden>
      {ICONS[id]}
    </svg>
  );
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinejoin: "round" as const,
  strokeLinecap: "round" as const,
};

const ICONS: Record<EditorTool, ReactNode> = {
  build: (
    <>
      <path {...stroke} d="M12 3.2 20.2 8 12 12.8 3.8 8Z" />
      <path {...stroke} d="M12 12.8 20.2 8v8.2L12 20.8" />
      <path {...stroke} d="M12 12.8 3.8 8v8.2L12 20.8" />
    </>
  ),
  column: (
    <>
      <path {...stroke} d="M5 19.5V9.5M5 19.5h6M5 14.5h6M5 9.5h6" />
      <path {...stroke} d="M16.5 18V6.5M16.5 6.5 14 9M16.5 6.5 19 9" />
    </>
  ),
  wand: (
    <>
      <path {...stroke} d="M4 20 13.5 10.5" />
      <path {...stroke} d="M15 4.8 16.1 7.6 19 8.7 16.1 9.8 15 12.6 13.9 9.8 11 8.7 13.9 7.6Z" />
    </>
  ),
  exchange: <path {...stroke} d="M4 8h13l-3.2-3.2M20 16H7l3.2 3.2" />,
  paste: (
    <>
      <rect {...stroke} x="5" y="5" width="14" height="16" rx="2" />
      <path {...stroke} d="M9 5V3.5h6V5M9 12h6M9 16h4" />
    </>
  ),
  select: <rect {...stroke} x="4" y="4" width="16" height="16" rx="1.5" strokeDasharray="3 2" />,
};
