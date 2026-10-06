import { clear } from "./clear.ts";
import type { CommandDef } from "./command.ts";
import { copy } from "./copy.ts";
import { fill } from "./fill.ts";
import { move } from "./move.ts";
import { paletteAdd } from "./palette-add.ts";
import { paletteSync } from "./palette-sync.ts";
import { paletteUpdate } from "./palette-update.ts";
import { paste } from "./paste.ts";
import { redo } from "./redo.ts";
import { resemantic } from "./resemantic.ts";
import { rotate } from "./rotate.ts";
import { select } from "./select.ts";
import { semanticAdd } from "./semantic-add.ts";
import { semanticUpdate } from "./semantic-update.ts";
import { set } from "./set.ts";
import { settings } from "./settings.ts";
import { transform } from "./transform.ts";
import { undo } from "./undo.ts";

/** Every command kind. To add one, write its file and add one line here. */
export const COMMANDS: readonly CommandDef[] = [
  set,
  fill,
  clear,
  resemantic,
  rotate,
  copy,
  move,
  transform,
  paste,
  select,
  undo,
  redo,
  paletteAdd,
  paletteUpdate,
  paletteSync,
  semanticAdd,
  semanticUpdate,
  settings,
];
