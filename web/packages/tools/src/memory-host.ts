import type { Libraries } from "@voxyl/blocks";
import { type Piece, Project, type ProjectOptions } from "@voxyl/core";
import type { ClipboardPort, SharedPalettesPort, StoredSharedPalette, ToolHost } from "./tool.ts";

/**
 * A host over one in-memory project: for tests, scripts and the headless host's first cut. It
 * counts the changes it was told about, and generates ids from a counter unless told not to.
 */
export class MemoryHost implements ToolHost {
  project: Project | null;
  editorAttached = false;
  /** Every `changed` notification, in order. */
  readonly changes: { tool: string; commandIds: readonly string[] }[] = [];
  #ids = 0;

  /** The clipboard's piece. */
  clip: Piece | null = null;
  readonly clipboard: ClipboardPort = {
    get: () => this.clip,
    set: (piece) => {
      this.clip = piece;
    },
  };

  /** The shared palettes this host offers. */
  shared: StoredSharedPalette[] = [];
  readonly sharedPalettes: SharedPalettesPort = { list: () => this.shared };

  /** The block libraries this host offers; none by default. */
  blockLibraries: Libraries | null;

  constructor(
    project: Project | null = new Project(),
    options: { editor?: boolean; libraries?: Libraries } = {},
  ) {
    this.project = project;
    this.blockLibraries = options.libraries ?? null;
    this.editorAttached = options.editor ?? false;
  }

  /** A host over a fresh project. */
  static create(options: ProjectOptions & { libraries?: Libraries } = {}): MemoryHost {
    const { libraries, ...project } = options;
    return new MemoryHost(new Project(project), libraries ? { libraries } : {});
  }

  libraries(): Libraries {
    return this.blockLibraries ?? new Map();
  }

  newId(): string {
    return `mem-${++this.#ids}`;
  }

  changed(_project: Project, info: { tool: string; commandIds: readonly string[] }): void {
    this.changes.push(info);
  }
}
