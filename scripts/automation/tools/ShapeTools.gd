extends RefCounted

# Shapes: what sub-block parts exist and how their slots / orientations are named.

static func register(reg: McpRegistry) -> void:
	reg.add("shape_list",
		"Every shape a palette entry can cut its block into, by picker page: microblocks (covers, panels, slabs, strips, posts, corners — several per cell) and architecture shapes (roofs, slopes, stairs, rounded, classical, arches, railings — one per cell).",
		{}, _shape_list)
	reg.add("shape_describe",
		"One shape: family, size, and its slots by name. Microblock slots come with their box (cell-local 0..1); architecture slots with up/facing words and what facing means for this shape.",
		{"properties": {
			"shape": {"type": "string", "description": "Shape id, e.g. \"edge1\", \"roof_tile\""},
			"slots": {"type": "boolean", "description": "List every slot (default true)"},
		}, "required": ["shape"]}, _shape_describe)
	reg.add("shape_orient",
		"Which slot(s) of an architecture shape match orientation words: up, facing (a single word also matches diagonals containing it), turn, shift, or required face normals.",
		{"properties": {
			"shape": {"type": "string"},
			"up": {"type": "string"},
			"facing": {"type": "string"},
			"turn": {"type": "integer"},
			"shift": {"type": "string"},
			"normals": {"type": "array", "items": {"type": "array"}, "description": "Face normals the placed shape must have, e.g. [[0,1,-1]]"},
		}, "required": ["shape"]}, _shape_orient)

const _FAMILY_WORDS := ["face", "hollow", "edge", "corner", "architecture"]

static func _shape_list(_args: Dictionary) -> Dictionary:
	var pages: Array = []
	for page in ShapeCatalog.pages():
		var shapes: Array = []
		for id in page[1]:
			shapes.append({"id": id, "name": ShapeCatalog.name_of(id), "slots": ShapeCatalog.slot_count(id)})
		pages.append({"page": page[0], "shapes": shapes})
	return {"pages": pages,
		"note": "Microblock sizes are in eighths: 1 = 1/8 thick, 2 = 1/4, 4 = 1/2. Slot names: see shape_describe or the conventions."}

static func _shape_describe(args: Dictionary) -> Dictionary:
	var id := str(args.get("shape", ""))
	if not ShapeCatalog.has(id):
		return McpRegistry.fail("not_found", "no shape '%s' (see shape_list)" % id)
	var fam := ShapeCatalog.family_of(id)
	var out := {"id": id, "name": ShapeCatalog.name_of(id), "family": _FAMILY_WORDS[fam],
		"slot_count": ShapeCatalog.slot_count(id)}
	if fam == ShapeCatalog.Family.ARCH:
		out.merge(ArchShapes.describe(id))
	else:
		out["size_eighths"] = ShapeCatalog.size_of(id)
		out["exclusive"] = false
	if bool(args.get("slots", true)):
		var slots: Array = []
		for s in ShapeCatalog.slot_count(id):
			var d := {"slot": s, "name": ShapeCatalog.slot_name(id, s)}
			if fam != ShapeCatalog.Family.ARCH:
				var b := ShapeCatalog.bounds(id, s)
				d["box"] = [b.position, b.end]
			slots.append(d)
		out["slots"] = slots
	return out

static func _shape_orient(args: Dictionary) -> Dictionary:
	var id := str(args.get("shape", ""))
	if ShapeCatalog.family_of(id) != ShapeCatalog.Family.ARCH:
		return McpRegistry.fail("bad_argument", "shape_orient is for architecture shapes; microblocks use slot names (shape_describe)")
	var r := ArchShapes.orient(id, args)
	var slots: Array = []
	for s in r["slots"]:
		slots.append({"slot": s, "name": ShapeCatalog.slot_name(id, s)})
	return {"shape": id, "exact": r["exact"], "matches": slots, "meaning": ArchShapes.describe(id)["text"]}
