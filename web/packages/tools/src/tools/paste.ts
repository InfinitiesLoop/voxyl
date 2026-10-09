import { z } from "zod";
import { PlaceFields, placePiece, placeResult } from "../pieces.ts";
import { MutatingFields } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

export const paste = defineTool({
  name: "paste",
  title: "Paste the clipboard",
  description:
    "Paste the clipboard (see copy) with its anchor at `at`, optionally turned (`turn` quarter " +
    "turns clockwise from above) and mirrored (east/west). A piece cut from a project with a " +
    "different north is turned to this project's north first. Its semantics map by palette and " +
    "name; missing ones are created with their looks (listed in `created`). `air` lets the " +
    "piece's empty cells clear what they land on. symmetry and repeat copy the paste. One undo " +
    "step.",
  input: z.strictObject({ ...PlaceFields, ...MutatingFields }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async handler(host, args, call) {
    if (!host.clipboard) throw new ToolError("unavailable", "This host has no clipboard.");
    const piece = await host.clipboard.get();
    if (!piece) {
      throw new ToolError("clipboard_empty", "The clipboard is empty. Use copy first.");
    }
    const placed = await placePiece(call, piece, args);
    return placeResult(placed.summary, placed);
  },
});
