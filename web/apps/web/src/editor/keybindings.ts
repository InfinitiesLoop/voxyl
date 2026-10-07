// Every binding the editor has, for the Keys panel. The handlers live where they act
// (FlyCamera, Engine, GridView); this list is what the user reads, kept beside them in
// spirit: change a binding there, change it here. Each action that has one names a key for
// the right hand too (the user flies with the mouse in the left hand).
//
// Later, app settings can rebind keys; this list is where that screen would start.

import type { EditorTool } from "./tool.ts";

export interface Binding {
  readonly action: string;
  /** The usual keys or buttons. */
  readonly keys: readonly string[];
  /** Keys for the right hand, when the usual ones are on the left. */
  readonly right?: readonly string[];
  readonly note?: string;
}

export interface BindingSection {
  readonly id: string;
  readonly title: string;
  /** When it applies, in a few words. */
  readonly when: string;
  /** The tool this section is about, so the panel can mark the one in hand. */
  readonly tool?: EditorTool;
  readonly bindings: readonly Binding[];
}

export const KEY_SECTIONS: readonly BindingSection[] = [
  {
    id: "move",
    title: "Moving",
    when: "In a 3D view",
    bindings: [
      { action: "Fly (take the pointer)", keys: ["Click the view"] },
      { action: "Let the pointer go", keys: ["Esc"] },
      { action: "Look around", keys: ["Mouse"], note: "while flying" },
      { action: "Turn without flying", keys: ["Drag the view"] },
      {
        action: "Orbit the selection",
        keys: ["Drag the view"],
        note: "with a selection, not flying",
      },
      { action: "Forward and back", keys: ["Wheel"], note: "not flying" },
      { action: "Move", keys: ["W", "A", "S", "D"], right: ["↑", "←", "↓", "→"] },
      { action: "Up", keys: ["Space"], right: ["Right Ctrl", "Right Alt"] },
      { action: "Down", keys: ["Left Shift"], right: ["Right Shift", "/"] },
      { action: "Sprint", keys: ["\\"], note: "tap up to 4×; resets when you stop" },
      { action: "Faster, slower", keys: ["=", "-"], right: ["Num +", "Num -"] },
    ],
  },
  {
    id: "build",
    title: "Building",
    when: "Build tool, flying",
    tool: "build",
    bindings: [
      { action: "Remove the aimed block", keys: ["Left click"] },
      { action: "Place the hotbar semantic", keys: ["Right click"] },
      { action: "Pick the aimed semantic", keys: ["Middle click"], note: "into the hotbar" },
    ],
  },
  {
    id: "select",
    title: "Selecting",
    when: "Select tool, flying",
    tool: "select",
    bindings: [
      { action: "First corner, then second", keys: ["Right click"] },
      { action: "Clear the box", keys: ["Right click"], note: "a third time" },
      { action: "Empty the selected cells", keys: ["Backspace"] },
      { action: "Remove, pick", keys: ["Left click", "Middle click"], note: "as in Build" },
    ],
  },
  {
    id: "wand",
    title: "Wand",
    when: "Wand tool, flying",
    tool: "wand",
    bindings: [
      { action: "Select connected blocks of a kind", keys: ["Right click"] },
      { action: "Select connected blocks of any kind", keys: ["Shift + Right click"] },
      { action: "Empty the selected cells", keys: ["Backspace"] },
    ],
  },
  {
    id: "hotbar",
    title: "Hotbar and inventory",
    when: "Anywhere",
    bindings: [
      { action: "Choose a slot", keys: ["1 … 9"], right: ["Num 1 … 9"] },
      { action: "Next or previous slot", keys: ["Wheel"], note: "while flying" },
      {
        action: "Inventory: tools and the hotbar",
        keys: ["E"],
        right: ["Delete"],
        note: "Esc also closes it",
      },
    ],
  },
  {
    id: "history",
    title: "History",
    when: "Anywhere",
    bindings: [
      { action: "Undo", keys: ["Ctrl + Z"], note: "either Ctrl" },
      { action: "Redo", keys: ["Ctrl + Shift + Z", "Ctrl + Y"] },
    ],
  },
  {
    id: "flat",
    title: "2D view",
    when: "Pointer over a 2D view",
    bindings: [
      { action: "Pan", keys: ["Drag"] },
      { action: "Zoom", keys: ["Wheel"] },
      { action: "Layer up", keys: ["]"], right: ["Page Up"] },
      { action: "Layer down", keys: ["["], right: ["Page Down"] },
      { action: "Four layers at a time", keys: ["Shift + those"] },
    ],
  },
];
