// Which tool the fly camera's clicks run. Build places and removes; Select marks a box;
// Wand selects connected cells. Paste arrives with the clipboard (the next editor step).

export type EditorTool = "build" | "select" | "wand";

const TOOL_KEY = "voxyl.tool";

/** The tool last used, or Build. */
export function readTool(): EditorTool {
  try {
    const saved = localStorage.getItem(TOOL_KEY);
    if (saved === "build" || saved === "select" || saved === "wand") return saved;
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
