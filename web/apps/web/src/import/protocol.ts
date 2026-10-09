// Messages between the page and the import worker. Everything here crosses a structured
// clone: a directory handle, files, and plain data.

import type { InstancePlan } from "@voxyl/mc-import";
import type { PickedFile } from "./fs-browser.ts";

/** The folder the user picked: a handle, or the files of a `webkitdirectory` pick. */
export type FolderSource =
  | { readonly kind: "handle"; readonly handle: FileSystemDirectoryHandle }
  | { readonly kind: "files"; readonly entries: readonly PickedFile[] };

export type ToImport =
  | { type: "plan"; source: FolderSource }
  | {
      type: "run";
      source: FolderSource;
      /** The 1.7.10 client jar, when the folder has none of its own. */
      vanillaJar?: File;
      /** Prepended to each mod's namespace to make its library id. */
      prefix: string;
    };

/** What an import produced, for the dialog's final report. */
export interface ImportReport {
  readonly libraries: readonly {
    readonly id: string;
    readonly name: string;
    readonly blocks: number;
  }[];
  readonly blocks: number;
  /** Roster entries left out for lack of a confident texture match. */
  readonly dropped: number;
  /** Mods with entries left out, the biggest first. */
  readonly droppedByMod: readonly (readonly [mod: string, count: number])[];
  readonly healed: readonly string[];
  readonly warnings: number;
  readonly ms: number;
}

export type FromImport =
  | { type: "plan"; plan: InstancePlan | null }
  | { type: "progress"; phase: string; done: number; total: number }
  | { type: "done"; report: ImportReport }
  | { type: "error"; message: string };
