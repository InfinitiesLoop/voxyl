// Which tool the fly camera's right click runs. Build places one block; Build to me lays a
// column toward you; the Wand grows a surface by a layer; Exchange swaps blocks in place;
// Paste puts the clipboard (or a prefab) where you aim; Select marks a box (Shift: the
// connected blocks).
// Left click removes and middle click picks, whatever the tool.

export const EDITOR_TOOLS = ["build", "column", "wand", "exchange", "paste", "select"] as const;
export type EditorTool = (typeof EDITOR_TOOLS)[number];

/** The tools that build many blocks a click (world/tools.ts) and use the brush. */
export function isBuildTool(tool: EditorTool): tool is "column" | "wand" | "exchange" {
  return tool === "column" || tool === "wand" || tool === "exchange";
}

/** The tools whose brush size matters. */
export function usesBrush(tool: EditorTool): boolean {
  return tool === "column" || tool === "exchange";
}

/** The next tool along (or back, with `step` -1), wrapping round. */
export function cycleTool(tool: EditorTool, step: 1 | -1): EditorTool {
  const i = EDITOR_TOOLS.indexOf(tool);
  const n = EDITOR_TOOLS.length;
  return EDITOR_TOOLS[(i + step + n) % n] ?? "build";
}

const TOOL_KEY = "voxyl.tool";
const BRUSH_KEY = "voxyl.brush";

/** The tool last used, or Build. */
export function readTool(): EditorTool {
  try {
    const saved = localStorage.getItem(TOOL_KEY);
    if ((EDITOR_TOOLS as readonly string[]).includes(saved ?? "")) return saved as EditorTool;
  } catch {
    // Storage can be blocked; Build is the ordinary way to work.
  }
  return "build";
}

export function rememberTool(tool: EditorTool): void {
  try {
    localStorage.setItem(TOOL_KEY, tool);
  } catch {
    // The choice still holds for this visit.
  }
}

/** The brush size last used (1, 3, 5 ...), or 1. */
export function readBrush(): number {
  try {
    const n = Number(localStorage.getItem(BRUSH_KEY));
    if (Number.isInteger(n) && n >= 1 && n <= 9) return n;
  } catch {
    // A single block is the safe default.
  }
  return 1;
}

export function rememberBrush(brush: number): void {
  try {
    localStorage.setItem(BRUSH_KEY, String(brush));
  } catch {
    // The choice still holds for this visit.
  }
}
