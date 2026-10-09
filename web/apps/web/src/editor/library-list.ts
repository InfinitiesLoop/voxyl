// The block library list beside the chooser: what it shows, in what order, and what a click
// selects. The selection is view state (which libraries the block search draws from); it never
// reaches the voxel data, which stores only the block each look names.

export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
}

/** Alphabetical by name, ignoring case, with the id breaking ties so the order is stable. */
export function sortLibraries<T extends LibraryEntry>(libraries: readonly T[]): T[] {
  return [...libraries].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) ||
      a.id.localeCompare(b.id),
  );
}

/** The libraries whose name holds every word of the query (case-insensitive). */
export function filterLibraries<T extends LibraryEntry>(
  libraries: readonly T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...libraries];
  return libraries.filter((l) => {
    const name = l.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

/** `selected` with `id` flipped. */
export function toggleLibrary(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** A plain click chooses just this library; clicking the only one chosen lets it go. */
export function chooseOnly(selected: ReadonlySet<string>, id: string): Set<string> {
  return selected.size === 1 && selected.has(id) ? new Set() : new Set([id]);
}

/** What is selected that still exists. An empty result means "every library". */
export function liveSelection(
  selected: ReadonlySet<string>,
  libraries: readonly LibraryEntry[],
): Set<string> {
  const known = new Set(libraries.map((l) => l.id));
  return new Set([...selected].filter((id) => known.has(id)));
}
