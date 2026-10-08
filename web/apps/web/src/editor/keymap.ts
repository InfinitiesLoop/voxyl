// Every keyboard binding, in one place. The handlers (FlyCamera, Engine, GridView) ask this
// table, and the Keys panel lists it, so changing a key here changes both. Each action has
// its usual binding and, where that sits on the left of the keyboard, an alternate that the
// other hand reaches (the user flies with the mouse in the left hand). Codes are
// KeyboardEvent.code values, so they follow key positions, not layouts.
//
// Every action with a key can also be done from the UI; a rebinding screen would edit this.

export const KEY_ACTIONS = [
  "forward",
  "back",
  "left",
  "right",
  "up",
  "down",
  "sprint",
  "faster",
  "slower",
  "inventory",
  "nextTool",
  "rotateBlock",
  "mirrorPaste",
  "toggleCutaway",
  "placeOpposite",
  "clearSelection",
  "layerUp",
  "layerDown",
  "sliceHere",
  "flatMirror",
] as const;

export type KeyAction = (typeof KEY_ACTIONS)[number];

export interface KeyBinding {
  readonly binding: readonly string[];
  readonly alternate: readonly string[];
}

export const KEYMAP: Readonly<Record<KeyAction, KeyBinding>> = {
  forward: { binding: ["KeyW"], alternate: ["ArrowUp"] },
  back: { binding: ["KeyS"], alternate: ["ArrowDown"] },
  left: { binding: ["KeyA"], alternate: ["ArrowLeft"] },
  right: { binding: ["KeyD"], alternate: ["ArrowRight"] },
  up: { binding: ["Space"], alternate: ["ControlRight", "AltRight"] },
  down: { binding: ["ShiftLeft"], alternate: ["ShiftRight", "Slash"] },
  /** A tap: pressed and let go with no other key between (so Ctrl+Z doesn't sprint). */
  sprint: { binding: ["ControlLeft"], alternate: ["Backslash"] },
  faster: { binding: ["Equal"], alternate: ["NumpadAdd"] },
  slower: { binding: ["Minus"], alternate: ["NumpadSubtract"] },
  inventory: { binding: ["KeyE"], alternate: ["Delete"] },
  /** Shift goes back a tool. */
  nextTool: { binding: ["KeyQ"], alternate: ["NumpadMultiply"] },
  /** Shift turns the other way. With Paste in hand it turns the clipboard instead. */
  rotateBlock: { binding: ["KeyR"], alternate: ["Numpad0"] },
  /** With Paste in hand: mirror the clipboard, east for west. */
  mirrorPaste: { binding: ["KeyM"], alternate: ["NumpadDecimal"] },
  /** Held while placing a shaped part: it goes on the far side of the cell (also the mouse thumb buttons). */
  placeOpposite: { binding: ["ControlLeft"], alternate: ["NumpadDivide", "Period"] },
  /** Switches the cutaway off and on, when there is one (End is near the arrows). */
  toggleCutaway: { binding: ["KeyH"], alternate: ["End"] },
  clearSelection: { binding: ["Backspace"], alternate: [] },
  layerUp: { binding: ["BracketRight"], alternate: ["PageUp"] },
  layerDown: { binding: ["BracketLeft"], alternate: ["PageDown"] },
  /** While flying: the 2D view slices through the aimed cell. Shift turns the slice. */
  sliceHere: { binding: ["Tab"], alternate: ["Enter", "NumpadEnter"] },
  /** Pointer over a 2D view: mirror its picture left to right. */
  flatMirror: { binding: ["KeyF"], alternate: [] },
};

/** Whether a key code is bound to an action. */
export function isKey(action: KeyAction, code: string): boolean {
  const k = KEYMAP[action];
  return k.binding.includes(code) || k.alternate.includes(code);
}

/** Every code bound to an action. */
export function codesOf(action: KeyAction): readonly string[] {
  const k = KEYMAP[action];
  return [...k.binding, ...k.alternate];
}

const NAMES: Readonly<Record<string, string>> = {
  Space: "Space",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Slash: "/",
  Backslash: "\\",
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  PageUp: "Page Up",
  PageDown: "Page Down",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadEnter: "Num Enter",
  NumpadDecimal: "Num .",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Home: "Home",
  End: "End",
};

/** What a key code is called on the keyboard: "KeyW" is W, "Numpad0" is Num 0. */
export function keyLabel(code: string): string {
  const named = NAMES[code];
  if (named) return named;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}
