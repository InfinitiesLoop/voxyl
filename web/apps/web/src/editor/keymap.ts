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

export const DEFAULT_KEYMAP: Readonly<Record<KeyAction, KeyBinding>> = {
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

/**
 * The keys in force: the defaults, with what the user rebound on top. Handlers ask this table
 * every time (never keep its arrays), so a rebinding takes effect at once.
 */
export const KEYMAP: Record<KeyAction, KeyBinding> = { ...DEFAULT_KEYMAP };

const STORAGE_KEY = "voxyl.keymap";
/** Keys that may never be rebound: they are how the editor lets go of the pointer. */
const RESERVED: readonly string[] = ["Escape"];
const listeners = new Set<() => void>();
let version = 0;

/** Counts rebindings, so a screen showing keys knows when to draw them again. */
export const keymapVersion = (): number => version;

export function subscribeKeymap(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

function save(): void {
  const custom: Partial<Record<KeyAction, KeyBinding>> = {};
  for (const action of KEY_ACTIONS) if (isCustomized(action)) custom[action] = KEYMAP[action];
  try {
    if (Object.keys(custom).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
  } catch {
    // Storage can be blocked; the change still holds for this visit.
  }
}

/** Reads what was rebound, ignoring anything that isn't a list of key codes for a known action. */
function load(): void {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return;
    const saved = JSON.parse(text) as Record<string, { binding?: unknown; alternate?: unknown }>;
    for (const action of KEY_ACTIONS) {
      const entry = saved[action];
      if (!entry) continue;
      const codes = (list: unknown, fallback: readonly string[]) =>
        Array.isArray(list) && list.every((c) => typeof c === "string" && c !== "")
          ? (list as string[])
          : fallback;
      KEYMAP[action] = {
        binding: codes(entry.binding, DEFAULT_KEYMAP[action].binding),
        alternate: codes(entry.alternate, DEFAULT_KEYMAP[action].alternate),
      };
    }
  } catch {
    // A broken saved map is the same as none: the defaults stand.
  }
}

/** Whether an action's keys differ from the defaults. */
export function isCustomized(action: KeyAction): boolean {
  const a = KEYMAP[action];
  const d = DEFAULT_KEYMAP[action];
  return a.binding.join() !== d.binding.join() || a.alternate.join() !== d.alternate.join();
}

/** Whether any key was rebound. */
export function anyCustomized(): boolean {
  return KEY_ACTIONS.some(isCustomized);
}

/** Whether a code may be bound at all. */
export function isReserved(code: string): boolean {
  return RESERVED.includes(code);
}

/**
 * Puts one key (or none, for an alternate) on an action's binding or its alternate. A binding
 * always keeps a key. Returns the other actions that already use that key, which the screen
 * mentions: some share a key on purpose, because they apply in different places.
 */
export function setKey(
  action: KeyAction,
  slot: "binding" | "alternate",
  code: string | null,
): KeyAction[] {
  if (code !== null && isReserved(code)) return [];
  if (code === null && slot === "binding") return [];
  const current = KEYMAP[action];
  KEYMAP[action] = { ...current, [slot]: code === null ? [] : [code] };
  save();
  changed();
  return code === null ? [] : sharing(action, code);
}

/** Puts one action's keys (or all of them) back to the defaults. */
export function resetKeys(action?: KeyAction): void {
  for (const a of action ? [action] : KEY_ACTIONS) KEYMAP[a] = DEFAULT_KEYMAP[a];
  save();
  changed();
}

/** The other actions that also use a key. */
export function sharing(action: KeyAction, code: string): KeyAction[] {
  return KEY_ACTIONS.filter((other) => other !== action && isKey(other, code));
}

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

load();

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
