import { clear } from "./clear.ts";
import type { CommandDef } from "./command.ts";
import { fill } from "./fill.ts";
import { set } from "./set.ts";

/** Every command kind. To add one, write its file and add one line here. */
export const COMMANDS: readonly CommandDef[] = [set, fill, clear];
