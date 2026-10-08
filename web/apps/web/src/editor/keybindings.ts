// The Keys panel's list: every binding by what it is for. Keyboard rows name an action in
// keymap.ts, so the panel shows exactly what the handlers use; mouse and combination rows
// are written out. Each row's `ui` says where the same thing is in the interface (every
// action with a key can be done without it).

import { KEYMAP, type KeyAction, keyLabel } from "./keymap.ts";
import type { EditorTool } from "./tool.ts";

export interface Binding {
  readonly action: string;
  /** The usual key or button. */
  readonly binding: readonly string[];
  /** Another key for the same thing, usually for the other hand. */
  readonly alternate: readonly string[];
  readonly note?: string;
}

export interface BindingSection {
  readonly id: string;
  readonly title: string;
  /** When it applies, in a few words. */
  readonly when: string;
  /** The tools this section is about, so the panel can mark the one in hand. */
  readonly tools?: readonly EditorTool[];
  readonly bindings: readonly Binding[];
}

/** A keyboard row from the keymap. */
function key(action: string, id: KeyAction, note?: string): Binding {
  const k = KEYMAP[id];
  return {
    action,
    binding: k.binding.map(keyLabel),
    alternate: k.alternate.map(keyLabel),
    ...(note && { note }),
  };
}

/** A mouse or combination row. */
function other(action: string, binding: readonly string[], note?: string): Binding {
  return { action, binding, alternate: [], ...(note && { note }) };
}

export const KEY_SECTIONS: readonly BindingSection[] = [
  {
    id: "move",
    title: "Moving",
    when: "In a 3D view",
    bindings: [
      other("Fly (take the pointer)", ["Click the view"]),
      other("Let the pointer go", ["Esc"]),
      other("Look around", ["Mouse"], "while flying"),
      other("Turn without flying", ["Drag the view"]),
      other("Orbit the selection", ["Drag the view"], "with a selection, not flying"),
      other("Forward and back", ["Wheel"], "not flying"),
      key("Forward", "forward"),
      key("Back", "back"),
      key("Left", "left"),
      key("Right", "right"),
      key("Up", "up"),
      key("Down", "down"),
      key("Sprint", "sprint", "tap, up to 4×; resets when you stop"),
      key("Faster", "faster", "also the Camera menu"),
      key("Slower", "slower", "also the Camera menu"),
    ],
  },
  {
    id: "build",
    title: "Building",
    when: "Flying",
    tools: ["build", "column", "wand", "exchange"],
    bindings: [
      other("Build with the tool in hand", ["Right click"]),
      other("Remove the aimed block", ["Left click"]),
      other("Pick the aimed semantic", ["Middle click"], "into the hotbar"),
      key("Turn the aimed block", "rotateBlock", "Shift turns it the other way"),
      key("Slice the 2D view here", "sliceHere", "Shift turns the slice; also 3D aim in a 2D bar"),
    ],
  },
  {
    id: "select",
    title: "Selecting",
    when: "Select tool, flying",
    tools: ["select"],
    bindings: [
      other("First corner, then second", ["Right click"]),
      other("Clear the box", ["Right click"], "a third time"),
      other("Select the blocks touching it", ["Shift + Right click"], "of its kind, or any"),
      key("Empty the selected cells", "clearSelection", "also Actions → Clear"),
    ],
  },
  {
    id: "tools",
    title: "Tools, hotbar and inventory",
    when: "Anywhere",
    bindings: [
      key("Next tool", "nextTool", "Shift goes back; also the inventory"),
      { action: "Choose a slot", binding: ["1 … 9"], alternate: ["Num 1 … 9"] },
      other("Next or previous slot", ["Wheel"], "while flying"),
      key("Inventory: tools and the hotbar", "inventory", "Esc also closes it"),
    ],
  },
  {
    id: "history",
    title: "History",
    when: "Anywhere",
    bindings: [
      other("Undo", ["Ctrl + Z"], "either Ctrl; also the top bar"),
      { action: "Redo", binding: ["Ctrl + Shift + Z"], alternate: ["Ctrl + Y"] },
    ],
  },
  {
    id: "flat",
    title: "2D view",
    when: "Pointer over a 2D view",
    bindings: [
      other(
        "Draw with the hotbar semantic",
        ["Left drag"],
        "Pencil, Line, Rectangle or Fill: the Draw menu",
      ),
      other("Erase", ["Right drag"]),
      other("Pick the semantic in a cell", ["Middle click"]),
      other("Pan", ["Middle drag"], "or Space + drag; left drag with Select"),
      other("Zoom", ["Wheel"]),
      key("Layer up", "layerUp", "also + in the bar"),
      key("Layer down", "layerDown", "also − in the bar"),
      other("Four layers at a time", ["Shift + those"]),
      key("Turn the block under the pointer", "rotateBlock", "Shift turns it the other way"),
      key("Mirror the picture", "flatMirror", "also the View menu"),
    ],
  },
];
