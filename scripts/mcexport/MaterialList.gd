class_name MaterialList
extends RefCounted

# "What do I have to gather?" — a region's (or prefab's) contents tallied by the ACTUAL block each
# semantic currently resolves to, instead of by semantic name. The semantic tally answers "what
# did I mean here"; this one answers "what do I need in the inventory to build it in-game".
#
# They differ in count on purpose: two semantics the palette maps to the same block (Walkway
# Edge and Stair Edge are both Cubit(14)) merge into one row here, and a shaped part is its own
# item — a slab of Cubit(14) isn't a Cubit(14) block — so rows are keyed by (library, block,
# shape, glow). An undecided semantic has no block to gather yet, so it keeps a row of its own,
# flagged `undecided`, rather than being silently dropped or lumped in with others.
#
# The grouping is pure material-layer reading (Principle 1/3): nothing here is stored in the
# voxel data, it follows the palette stack live. Minecraft identity (McId) is shown when the
# block has one — never required.
#
# Resolution goes through whatever stack VoxelWorld is currently resolving against: the open
# project by default, or a prefab's own palettes inside VoxelWorld.begin_resolve_as (see
# for_prefab). Input is a RegionOps.stats-shaped dictionary ({blocks, parts}).

# One row per distinct item, busiest first:
#   {block, library, shape, glow, count, semantics {name: n}, color, undecided,
#    registry, meta, display, confirmed}
static func from_stats(stats: Dictionary) -> Array:
	var rows := {}
	var blocks: Dictionary = stats.get("blocks", {})
	for semantic: String in blocks:
		_add(rows, semantic, "", int(blocks[semantic]))
	var parts: Dictionary = stats.get("parts", {})
	for key: String in parts:
		var split := RegionOps.split_part_key(key)
		_add(rows, split[0], split[1], int(parts[key]))
	var out: Array = rows.values()
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		if a["count"] != b["count"]:
			return a["count"] > b["count"]
		return title(a) < title(b))
	return out

# A prefab's material list, resolved through its own preferred palettes.
static func for_prefab(prefab: Prefab) -> Array:
	VoxelWorld.begin_resolve_as(CaptureService.prefab_stage(prefab))
	var out := from_stats(prefab.stats())
	VoxelWorld.end_resolve_as()
	return out

static func _add(rows: Dictionary, semantic: String, shape: String, count: int) -> void:
	var block := VoxelWorld.get_block_type_for_semantic(semantic)
	var glow := not shape.is_empty() and VoxelWorld.get_shape_glow_for_semantic(semantic)
	var library := VoxelWorld.get_library_name_for_semantic(semantic)
	var key := "?%s|%s" % [semantic, shape] if block.is_empty() \
		else "%s/%s|%s|%s" % [library, block, shape, glow]
	var row: Dictionary = rows.get(key, {})
	if row.is_empty():
		var bt := VoxelWorld.get_block_type_object_for_semantic(semantic)
		row = {
			"block": block, "library": library, "shape": shape, "glow": glow,
			"count": 0, "semantics": {}, "color": VoxelWorld.get_color_for_semantic(semantic),
			"undecided": block.is_empty(),
			"registry": McId.get_registry(bt), "meta": McId.get_mc_meta(bt),
			"display": McId.get_display(bt), "confirmed": McId.is_confirmed(bt),
		}
		rows[key] = row
	row["count"] = int(row["count"]) + count
	var sems: Dictionary = row["semantics"]
	sems[semantic] = int(sems.get(semantic, 0)) + count

# "Cubit(14)", "Cubit(14) · Stairs", "Cubit(14) · Stairs (glow)"; an undecided row reads
# "Undecided (Mass)" so the gap in the palette is visible.
static func title(row: Dictionary) -> String:
	var text: String
	if row["undecided"]:
		text = "Undecided (%s)" % ", ".join((row["semantics"] as Dictionary).keys())
	else:
		text = str(row["block"])
	var shape := str(row["shape"])
	if not shape.is_empty():
		text += " · %s%s" % [ShapeCatalog.name_of(shape), " (glow)" if row["glow"] else ""]
	return text

# The block's Minecraft identity as "registry:meta" ("chisel:cubit:14"), or "" when it has none.
static func identity(row: Dictionary) -> String:
	var registry := str(row["registry"])
	if registry.is_empty():
		return ""
	return "%s:%d" % [registry, int(row["meta"])] if int(row["meta"]) > 0 else registry

# The lines a row shows under its title (each omitted when empty): where the block lives plus
# its Minecraft identity, and — when several semantics landed on the same block — which ones
# merged into the count.
static func detail_lines(row: Dictionary) -> Array[String]:
	var lines: Array[String] = []
	var where: Array[String] = []
	if not str(row["library"]).is_empty():
		where.append(str(row["library"]))
	var id := identity(row)
	if not id.is_empty():
		where.append(id)
	if not where.is_empty():
		lines.append("  ·  ".join(where))
	var sems: Dictionary = row["semantics"]
	if sems.size() > 1:
		var merged: Array[String] = []
		for s: String in sems:
			merged.append("%s ×%d" % [s, sems[s]])
		lines.append("merges " + ", ".join(merged))
	return lines

# JSON for the MCP tools: what to gather, plus which semantics each row merges.
static func to_json(rows: Array) -> Array:
	var out: Array = []
	for row: Dictionary in rows:
		var d := {"block": row["block"], "count": row["count"], "semantics": row["semantics"]}
		if row["undecided"]:
			d["undecided"] = true
		if not str(row["library"]).is_empty():
			d["library"] = row["library"]
		if not str(row["shape"]).is_empty():
			d["shape"] = row["shape"]
			d["shape_name"] = ShapeCatalog.name_of(str(row["shape"]))
			if row["glow"]:
				d["glow"] = true
		if not str(row["registry"]).is_empty():
			d["mc_registry"] = row["registry"]
			d["mc_meta"] = row["meta"]
			if not str(row["display"]).is_empty() and str(row["display"]) != str(row["block"]):
				d["mc_display"] = row["display"]
			d["mc_confirmed"] = row["confirmed"]
		out.append(d)
	return out

# Plain text for the clipboard, one item per line: "42× Cubit(14) · Stairs  [chisel:cubit:14]".
static func to_text(rows: Array) -> String:
	var lines: Array[String] = []
	for row: Dictionary in rows:
		var id := identity(row)
		lines.append("%d× %s%s" % [row["count"], title(row), "  [%s]" % id if not id.is_empty() else ""])
	return "\n".join(lines)
