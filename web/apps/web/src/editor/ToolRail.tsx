import type { MouseEvent } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { EditorTool } from "./tool.ts";

const TOOLS: readonly { id: EditorTool; label: string; title: string }[] = [
  { id: "build", label: "Build", title: "Left click removes, right click places" },
  { id: "select", label: "Select", title: "Right-click two corners of a box" },
  { id: "wand", label: "Wand", title: "Right-click selects the connected blocks" },
];

/**
 * The tools, down the left edge. Paste joins them when the clipboard does.
 */
export function ToolRail({ engine, tool }: { engine: Engine; tool: EditorTool }) {
  const click = (next: EditorTool) => (event: MouseEvent<HTMLButtonElement>) => {
    engine.setTool(next);
    event.currentTarget.blur();
  };
  return (
    <div className="tool-rail" role="toolbar" aria-label="Tools">
      {TOOLS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={tool === item.id ? "active" : undefined}
          aria-pressed={tool === item.id}
          title={item.title}
          onClick={click(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
