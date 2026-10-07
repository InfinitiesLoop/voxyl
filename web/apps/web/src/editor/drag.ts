import type { SemanticInfo } from "../world/editing.ts";

/** The drag type a semantic row sets and a hotbar slot reads. */
export const SEMANTIC_DRAG = "application/voxyl-semantic";

export function writeSemanticDrag(data: DataTransfer, info: SemanticInfo): void {
  data.setData(SEMANTIC_DRAG, JSON.stringify(info));
  data.setData("text/plain", info.name);
  data.effectAllowed = "copy";
}

/** The semantic a drop is carrying, or null if the drag came from somewhere else. */
export function readSemanticDrag(data: DataTransfer): SemanticInfo | null {
  const raw = data.getData(SEMANTIC_DRAG);
  if (!raw) return null;
  try {
    const info = JSON.parse(raw) as SemanticInfo;
    const refOk =
      typeof info.ref === "number" ||
      (typeof info.ref === "object" &&
        info.ref !== null &&
        typeof info.ref.palette === "number" &&
        typeof info.ref.base === "number");
    if (!refOk || typeof info.name !== "string" || typeof info.palette !== "number") return null;
    return info;
  } catch {
    return null;
  }
}
