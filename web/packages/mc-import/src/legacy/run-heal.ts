// Runs the healers over the drafts a roster import filled: for each namespace, the extension
// that handles it (if any) gets a `HealContext` over that namespace's draft and its source.
// Healed blocks are keyed by registry and meta, so running this again updates them in place.

import type { AssetSource } from "../sources/index.ts";
import type { NamespaceResolver } from "./attach.ts";
import type { LibraryDraft } from "./draft.ts";
import { type Extension, extensionFor } from "./extension.ts";
import { HealContext } from "./heal.ts";
import type { TextureIngest } from "./texture.ts";

export interface HealRunOptions {
  readonly extensions: readonly Extension[];
  /** The drafts the roster import filled, by the namespace the roster spells. */
  readonly drafts: ReadonlyMap<string, LibraryDraft>;
  /** Finds the source behind a namespace (the one the roster import returned). */
  readonly resolver: NamespaceResolver;
  readonly ingest: TextureIngest;
  readonly legacyIdFor?: (registry: string) => number;
  readonly siblingText?: (name: string) => Promise<string>;
  readonly onProgress?: (done: number, total: number, ns: string) => void;
  readonly signal?: { readonly aborted: boolean };
}

export interface HealRunResult {
  /** Namespaces an extension ran for. */
  readonly healed: string[];
  readonly warnings: string[];
}

export async function runHealers(opts: HealRunOptions): Promise<HealRunResult> {
  const healed: string[] = [];
  const work = [...opts.drafts].filter(([ns]) => extensionFor(opts.extensions, ns));
  let done = 0;
  for (const [ns, draft] of work) {
    if (opts.signal?.aborted) break;
    const extension = extensionFor(opts.extensions, ns);
    const resolved = opts.resolver.resolve(ns);
    // A namespace whose mod isn't installed has nothing to heal from; leave its roster blocks.
    const source: AssetSource | undefined = resolved?.source;
    opts.onProgress?.(done++, work.length, ns);
    if (!extension || !source) continue;
    await extension.heal(
      new HealContext({
        draft,
        source,
        ns,
        ingest: opts.ingest,
        ...(opts.legacyIdFor && { legacyIdFor: opts.legacyIdFor }),
        ...(opts.siblingText && { siblingText: opts.siblingText }),
      }),
    );
    healed.push(ns);
  }
  opts.onProgress?.(work.length, work.length, "");
  return { healed, warnings: opts.ingest.warnings };
}
