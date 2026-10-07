import type { Engine } from "../scene/Engine.ts";
import type { EditorTool } from "./tool.ts";
import { useStore } from "./useStore.ts";
import { blurAfter } from "./ViewBar.tsx";

export const TOOLS: readonly { id: EditorTool; label: string; hint: string }[] = [
  { id: "build", label: "Build", hint: "Left click removes, right click places." },
  {
    id: "select",
    label: "Select",
    hint: "Right-click two corners of a box; a third click clears. Backspace empties it.",
  },
  {
    id: "wand",
    label: "Wand",
    hint: "Right-click selects the connected blocks of that kind; Shift for any kind.",
  },
];

/**
 * The tools, inside the inventory beside its hotbar (as in the Godot app): choosing a tool
 * goes through the inventory, so flying never has to give up the pointer for a tool rail.
 * Paste joins them with the clipboard.
 */
export function ToolStrip({ engine }: { engine: Engine }) {
  const tool = useStore(engine.tool);
  const current = TOOLS.find((item) => item.id === tool);
  return (
    <div className="tool-strip">
      <div className="tool-strip-buttons" role="toolbar" aria-label="Tools">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tool === item.id}
            title={item.hint}
            onClick={blurAfter(() => engine.setTool(item.id))}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="tool-strip-hint">{current?.hint}</p>
    </div>
  );
}

/**
 * Which tool is in hand, beside the workspace hotbar. It only shows the tool: a click opens
 * the inventory, where the tool is chosen.
 */
export function ToolBadge({ engine }: { engine: Engine }) {
  const tool = useStore(engine.tool);
  const current = TOOLS.find((item) => item.id === tool);
  return (
    <button
      type="button"
      className="tool-badge"
      title={`${current?.hint ?? ""} Change tools in the inventory (E or Delete).`}
      onClick={blurAfter(() => engine.toggleInventory())}
    >
      <span className="tool-badge-label">Tool</span>
      {current?.label}
    </button>
  );
}
