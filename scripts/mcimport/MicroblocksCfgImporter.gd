class_name MicroblocksCfgImporter
extends RefCounted

# Parses ForgeMultipart's own microblocks.cfg — the flat whitelist that decides which blocks
# its saw can cut into microblocks (real source: GTNewHorizons/ForgeMultipart's
# ConfigContent.scala, which iterates the block registry and only registers a block whose
# registry name matches a line here). One line per block:
#   "registry:name"              — every meta is sawable
#   "registry:name":N            — only meta N
#   "registry:name":N-M          — metas N..M inclusive
#   "registry:name":N,M,K-L      — a comma list, entries may be single metas or ranges
# "#" starts a comment (line or trailing); blank lines are skipped. Confirmed against a real
# GTNH install's config/microblocks.cfg.

# registry name -> true (every meta) | Array[int] (the sawable metas).
static func parse(path: String) -> Dictionary:
	var out := {}
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return out
	while not f.eof_reached():
		var line := f.get_line()
		var hash_at := line.find("#")
		if hash_at >= 0:
			line = line.substr(0, hash_at)
		line = line.strip_edges()
		if not line.begins_with("\""):
			continue
		var end_quote := line.find("\"", 1)
		if end_quote < 0:
			continue
		var registry := line.substr(1, end_quote - 1)
		var rest := line.substr(end_quote + 1).strip_edges()
		if rest.begins_with(":"):
			rest = rest.substr(1).strip_edges()
		if rest.is_empty():
			out[registry] = true
			continue
		var metas: Array = []
		for tok in rest.split(",", false):
			tok = tok.strip_edges()
			var dash := tok.find("-")
			if dash > 0 and tok.substr(0, dash).is_valid_int() and tok.substr(dash + 1).is_valid_int():
				for m in range(int(tok.substr(0, dash)), int(tok.substr(dash + 1)) + 1):
					metas.append(m)
			elif tok.is_valid_int():
				metas.append(int(tok))
		if metas.is_empty():
			out[registry] = true
		else:
			out[registry] = metas
	return out

static func is_sawable(whitelist: Dictionary, registry: String, meta: int) -> bool:
	if not whitelist.has(registry):
		return false
	var v: Variant = whitelist[registry]
	if v is bool:
		return v
	return (v as Array).has(meta)
