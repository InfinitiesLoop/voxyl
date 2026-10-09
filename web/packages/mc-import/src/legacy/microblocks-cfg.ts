// Parses ForgeMultipart's own microblocks.cfg: the flat whitelist that decides which blocks its
// saw can cut into microblocks (real source: GTNewHorizons/ForgeMultipart's ConfigContent.scala,
// which iterates the block registry and only registers a block whose registry name matches a
// line here). One line per block:
//   "registry:name"              every meta is sawable
//   "registry:name":N            only meta N
//   "registry:name":N-M          metas N..M inclusive
//   "registry:name":N,M,K-L      a comma list, entries may be single metas or ranges
// "#" starts a comment (line or trailing); blank lines are skipped. Confirmed against a real GTNH
// install's config/microblocks.cfg.
//
// The file's own header says an omitted meta "defaults to 0", but the Godot importer (and the
// real game, per its source) treats a bare name as every meta, so this does too.

/** Registry name -> true (every meta is sawable) or the sawable metas. */
export type MicroblockWhitelist = ReadonlyMap<string, true | readonly number[]>;

/** Godot's String.is_valid_int: an optional sign, then digits. */
const isInt = (s: string) => /^[+-]?\d+$/.test(s);

export function parseMicroblocksCfg(text: string): MicroblockWhitelist {
  const out = new Map<string, true | readonly number[]>();
  for (const raw of text.split("\n")) {
    // The first "#" ends the line, quotes or not, as the Godot parser does.
    const hash = raw.indexOf("#");
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line.startsWith('"')) continue;
    const endQuote = line.indexOf('"', 1);
    if (endQuote < 0) continue;
    const registry = line.slice(1, endQuote);
    let rest = line.slice(endQuote + 1).trim();
    if (rest.startsWith(":")) rest = rest.slice(1).trim();
    if (rest === "") {
      out.set(registry, true);
      continue;
    }
    const metas: number[] = [];
    for (const piece of rest.split(",")) {
      const tok = piece.trim();
      if (tok === "") continue;
      const dash = tok.indexOf("-");
      if (dash > 0 && isInt(tok.slice(0, dash)) && isInt(tok.slice(dash + 1))) {
        const to = Number(tok.slice(dash + 1));
        for (let m = Number(tok.slice(0, dash)); m <= to; m++) metas.push(m);
      } else if (isInt(tok)) {
        metas.push(Number(tok));
      }
    }
    // A line whose metas are all unreadable counts as "every meta", like a bare name, rather
    // than silently whitelisting nothing (the Godot parser does the same).
    out.set(registry, metas.length === 0 ? true : metas);
  }
  return out;
}

/** Whether the saw can cut this registry block at this meta. */
export function isSawable(whitelist: MicroblockWhitelist, registry: string, meta: number): boolean {
  const entry = whitelist.get(registry);
  if (entry === undefined) return false;
  return entry === true || entry.includes(meta);
}
