import { clear } from "./clear.ts";
import type { CommandDef } from "./command.ts";
import { fill } from "./fill.ts";
import { paletteAdd } from "./palette-add.ts";
import { paletteSync } from "./palette-sync.ts";
import { paletteUpdate } from "./palette-update.ts";
import { resemantic } from "./resemantic.ts";
import { select } from "./select.ts";
import { semanticAdd } from "./semantic-add.ts";
import { semanticUpdate } from "./semantic-update.ts";
import { set } from "./set.ts";

/** Every command kind. To add one, write its file and add one line here. */
export const COMMANDS: readonly CommandDef[] = [
  set,
  fill,
  clear,
  resemantic,
  select,
  paletteAdd,
  paletteUpdate,
  paletteSync,
  semanticAdd,
  semanticUpdate,
];
