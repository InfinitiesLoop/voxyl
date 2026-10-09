// A mod-specific post-import healer, and how one is picked for a namespace. All the mod
// knowledge lives in an extension; the generic importers stay mod-agnostic (CLAUDE.md
// principle 4). A pack (all of GTNH) is one extension that declares the namespaces it handles.

import type { HealContext } from "./heal.ts";

export interface Extension {
  /** Whether this extension handles a namespace (as the roster spells it: "ProjRed|Illumination"). */
  handles(ns: string): boolean;
  /** Reshapes the just-imported namespace in place. */
  heal(ctx: HealContext): Promise<void>;
}

/** The first of `extensions` that handles `ns`, or undefined (the plain import then stands). */
export function extensionFor(extensions: readonly Extension[], ns: string): Extension | undefined {
  return extensions.find((e) => e.handles(ns));
}
