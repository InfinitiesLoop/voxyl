extends RefCounted

# Libraries and blocks: the material layer, read-only. Finding the right block is the
# point; swatches (images) live with the other renders in ViewTools.

static func register(reg: McpRegistry) -> void:
	reg.add("library_list",
		"Block libraries (imported material sets): name, block count, and the source namespaces inside.",
		{}, _library_list)
	reg.add("block_search",
		"Find blocks across libraries by text, library, family (name prefix, e.g. \"sets/korp/\" for every variant of a set) or color. Returns names to use in palette entries, with their average color.",
		{"properties": {
			"query": {"type": "string", "description": "Space-separated terms, all must match name/library/namespace/tags"},
			"library": {"type": "string", "description": "Only this library"},
			"family": {"type": "string", "description": "Block name prefix, e.g. \"sets/korp/\""},
			"color_near": {"type": "string", "description": "Hex color like \"#20c0e0\"; results sorted by closeness"},
			"tolerance": {"type": "number", "description": "Max RGB distance for color_near (0..1.7, default 0.2)"},
			"limit": {"type": "integer", "description": "Default 40, max 200"},
			"offset": {"type": "integer"},
		}}, _block_search)
	reg.add("block_get",
		"One block's details: library, color, model, textures, tags, and which palette entries use it.",
		{"properties": {
			"name": {"type": "string"},
			"library": {"type": "string", "description": "Disambiguate when several libraries have the name"},
		}, "required": ["name"]}, _block_get)

static func _library_list(_args: Dictionary) -> Dictionary:
	var out: Array = []
	for lib in VoxelWorld.workspace.libraries:
		var ns := {}
		for bt in lib.block_types:
			if not bt.source_namespace.is_empty():
				ns[bt.source_namespace] = true
		out.append({"name": lib.name, "blocks": lib.block_types.size(), "builtin": lib.builtin,
			"namespaces": ns.keys().slice(0, 8)})
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return str(a["name"]) < str(b["name"]))
	return {"libraries": out}

static func _block_search(args: Dictionary) -> Dictionary:
	var terms := str(args.get("query", "")).to_lower().split(" ", false)
	var only_lib := str(args.get("library", ""))
	var family := str(args.get("family", ""))
	var limit := clampi(int(args.get("limit", 40)), 1, 200)
	var offset := maxi(0, int(args.get("offset", 0)))
	var want_color: Variant = null
	if args.has("color_near"):
		var hex := str(args["color_near"])
		if not Color.html_is_valid(hex):
			return McpRegistry.fail("bad_argument", "color_near must be a hex color like #20c0e0")
		want_color = Color.html(hex)
	var tol := float(args.get("tolerance", 0.2))
	if terms.is_empty() and only_lib.is_empty() and family.is_empty() and want_color == null:
		return McpRegistry.fail("bad_argument", "give at least one of query, library, family, color_near")
	var hits: Array = []
	for lib in VoxelWorld.workspace.libraries:
		if not only_lib.is_empty() and lib.name != only_lib:
			continue
		for bt in lib.block_types:
			if not family.is_empty() and not bt.name.begins_with(family):
				continue
			if not terms.is_empty():
				var hay := bt.search_haystack(lib.name).to_lower()
				var ok := true
				for t in terms:
					if not hay.contains(t):
						ok = false
						break
				if not ok:
					continue
			var dist := 0.0
			if want_color != null:
				var c: Color = want_color
				dist = Vector3(bt.color.r - c.r, bt.color.g - c.g, bt.color.b - c.b).length()
				if dist > tol:
					continue
			hits.append([dist, lib.name, bt])
	if want_color != null:
		hits.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0])
	else:
		hits.sort_custom(func(a: Array, b: Array) -> bool:
			if a[1] != b[1]:
				return str(a[1]) < str(b[1])
			var ba: BlockType = a[2]
			var bb: BlockType = b[2]
			return ba.order < bb.order if ba.order != bb.order else ba.name.naturalnocasecmp_to(bb.name) < 0)
	var results: Array = []
	for h in hits.slice(offset, offset + limit):
		var bt: BlockType = h[2]
		var r := {"name": bt.name, "library": h[1], "color": bt.color}
		if bt.shape != BlockType.Shape.FULL:
			r["shape"] = ["full", "slab", "stairs"][bt.shape]
		if not bt.tags.is_empty():
			r["tags"] = Array(bt.tags).slice(0, 6)
		results.append(r)
	return {"total": hits.size(), "offset": offset, "results": results}

static func _block_get(args: Dictionary) -> Dictionary:
	var name := str(args.get("name", ""))
	var lib_name := str(args.get("library", ""))
	var bt: BlockType = null
	var owner := ""
	for lib in VoxelWorld.workspace.libraries:
		if not lib_name.is_empty() and lib.name != lib_name:
			continue
		var b := lib.get_block_type(name)
		if b != null:
			bt = b
			owner = lib.name
			break
	if bt == null:
		return McpRegistry.fail("not_found", "no block named '%s'%s; try block_search" % [name, (" in " + lib_name) if not lib_name.is_empty() else ""])
	var out := {"name": bt.name, "library": owner, "color": bt.color, "namespace": bt.source_namespace,
		"shape": ["full", "slab", "stairs"][bt.shape], "model": bt.model_id, "tags": Array(bt.tags)}
	if McId.has_registry(bt):
		out["mc_registry"] = McId.get_registry(bt)
		out["mc_meta"] = McId.get_mc_meta(bt)
		out["mc_confirmed"] = McId.is_confirmed(bt)
		if not McId.get_orient(bt).is_empty():
			out["mc_orient"] = McId.get_orient(bt)
	if McId.has_unlocalized(bt):
		out["mc_unlocalized"] = McId.get_unlocalized(bt)
	if not McId.get_mod(bt).is_empty():
		out["mc_mod"] = McId.get_mod(bt)
	if not McId.get_display(bt).is_empty():
		out["mc_display"] = McId.get_display(bt)
	var model := VoxelWorld.workspace.resolve_block_model(bt.model_id, [owner]) if not bt.model_id.is_empty() else null
	if model != null:
		out["textures"] = model.textures.duplicate()
	var used: Array = []
	for p in VoxelWorld.workspace.palettes:
		for e in p.entries:
			if e.block_type_name == bt.name:
				used.append({"palette": p.name, "semantic": e.semantic_name})
	out["used_by"] = used
	return out
