import { Project, type ProjectOptions } from "@voxyl/core";
import type { ToolHost } from "./tool.ts";

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

  constructor(project: Project | null = new Project(), options: { editor?: boolean } = {}) {
    this.project = project;
    this.editorAttached = options.editor ?? false;
  }

  /** A host over a fresh project. */
  static create(options: ProjectOptions = {}): MemoryHost {
    return new MemoryHost(new Project(options));
  }

  newId(): string {
    return `mem-${++this.#ids}`;
  }

  changed(_project: Project, info: { tool: string; commandIds: readonly string[] }): void {
    this.changes.push(info);
  }
}
