extends RefCounted

# Palettes: the semantic → material (+ shape) maps. The only place materials change.
# Every edit goes through VoxelWorld's palette mutators, batched into one save + refresh,
# so the user's inventory and palette editor update live.

static func register(reg: McpRegistry) -> void:
	reg.add("palette_list",
		"All palettes: entry count, library stack, and which projects use each.",
		{}, _palette_list)
	reg.add("palette_get",
		"A palette's entries (semantic → block, shape) and its library stack. `resolved` is false when the block isn't found in the palette's libraries (it renders undecided).",
		{"properties": {"name": {"type": "string"}}, "required": ["name"]}, _palette_get)
	reg.add("palette_create",
		"Create a palette with its libraries and entries in one call (or copy one with `from`). The user sees it appear in their inventory and palette editor.",
		{"properties": {
			"name": {"type": "string"},
			"libraries": {"type": "array", "items": {"type": "string"}, "description": "Library stack to draw blocks from, first match wins (the basic library is always the last fallback)"},
			"entries": {"type": "array", "items": {"type": "object"}, "description": "[{semantic, block?, shape?}] — block \"\"/null = undecided; shape = a shape id from shape_list (makes it place parts)"},
			"from": {"type": "string", "description": "Copy this palette's libraries and entries first"},
		}, "required": ["name"]}, _palette_create, {"mutates": true})
	reg.add("palette_update",
		"Edit a palette: add / set / remove / rename entries, replace its library stack, or rename it. `set` changes an existing entry's block and/or shape (block null = undecided); changing a block re-skins every placed use, changing a shape only affects new placements.",
		{"properties": {
			"name": {"type": "string"},
			"add": {"type": "array", "items": {"type": "object"}, "description": "[{semantic, block?, shape?}]"},
			"set": {"type": "array", "items": {"type": "object"}, "description": "[{semantic, block?, shape?}] — only given keys change"},
			"remove": {"type": "array", "items": {"type": "string"}},
			"rename": {"type": "object", "description": "{old semantic: new semantic}"},
			"libraries": {"type": "array", "items": {"type": "string"}},
			"rename_palette": {"type": "string"},
		}, "required": ["name"]}, _palette_update, {"mutates": true})
	reg.add("palette_delete",
		"Delete a palette (not the built-in Default). Requires confirm: true.",
		{"properties": {"name": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["name", "confirm"]},
		_palette_delete, {"mutates": true})
	reg.add("project_palettes_set",
		"Set the open project's palette stack, bottom to top (the last palette that maps a semantic wins). Empty hotbar slots fill from the new semantics.",
		{"properties": {
			"palettes": {"type": "array", "items": {"type": "string"}},
			"project": {"type": "string"},
		}, "required": ["palettes"]}, _project_palettes_set, {"mutates": true})

static func _palette(name: String) -> Variant:
	var p := VoxelWorld.workspace.get_palette(name)
	if p == null:
		return McpRegistry.fail("not_found", "no palette named '%s'" % name)
	return p

static func _palette_list(_args: Dictionary) -> Dictionary:
	var out: Array = []
	for p in VoxelWorld.workspace.palettes:
		var users: Array = []
		for proj in VoxelWorld.workspace.projects:
			if proj.palette_names.has(p.name):
				users.append(proj.name)
		out.append({"name": p.name, "entries": p.entries.size(), "libraries": Array(p.library_names),
			"builtin": p.builtin, "projects": users})
	return {"palettes": out}

static func _palette_get(args: Dictionary) -> Dictionary:
	var p: Variant = _palette(str(args.get("name", "")))
	if McpRegistry.is_error(p):
		return p
	return describe(p)

static func describe(p: Palette) -> Dictionary:
	var entries: Array = []
	for e in p.entries:
		var d := {"semantic": e.semantic_name, "block": e.block_type_name}
		if not e.block_type_name.is_empty():
			var bt := VoxelWorld.workspace.resolve_block_type(e.block_type_name, p.library_names)
			d["resolved"] = bt != null
			if bt != null:
				d["color"] = bt.color
		if e.is_shaped():
			d["shape"] = e.shape_id
			d["shape_name"] = ShapeCatalog.name_of(e.shape_id)
		entries.append(d)
	return {"name": p.name, "libraries": Array(p.library_names), "builtin": p.builtin, "entries": entries}

# Check one entry spec; returns "" or a problem. Warnings (unresolved blocks) go in `warnings`.
static func _check_entry(p: Palette, spec: Dictionary, warnings: Array) -> String:
	var sem := str(spec.get("semantic", "")).strip_edges()
	if sem.is_empty():
		return "an entry needs a semantic"
	var shape := str(spec.get("shape", "")) if spec.get("shape") != null else ""
	if not shape.is_empty() and not ShapeCatalog.has(shape):
		return "'%s': unknown shape '%s' (see shape_list)" % [sem, shape]
	var block := str(spec.get("block", "")) if spec.get("block") != null else ""
	if not block.is_empty() and VoxelWorld.workspace.resolve_block_type(block, p.library_names) == null:
		warnings.append("'%s': block '%s' isn't in the palette's libraries %s — it renders undecided" % [sem, block, str(Array(p.library_names))])
	return ""

static func _palette_create(args: Dictionary) -> Dictionary:
	var name := str(args.get("name", "")).strip_edges()
	if name.is_empty():
		return McpRegistry.fail("bad_argument", "name is required")
	if VoxelWorld.workspace.get_palette(name) != null:
		return McpRegistry.fail("name_taken", "a palette named '%s' already exists; use palette_update" % name)
	var warnings: Array = []
	VoxelWorld.begin_palette_batch()
	var p: Palette
	if args.has("from"):
		var src: Variant = _palette(str(args["from"]))
		if McpRegistry.is_error(src):
			VoxelWorld.end_palette_batch()
			return src
		p = VoxelWorld.duplicate_palette(src, name)
	else:
		p = VoxelWorld.add_palette(name)
	if args.get("libraries") is Array:
		for lib in args["libraries"]:
			if VoxelWorld.workspace.get_library(str(lib)) == null:
				warnings.append("no library named '%s'" % lib)
		VoxelWorld.set_palette_libraries(p, (args["libraries"] as Array).map(func(x: Variant) -> String: return str(x)))
	var problems := _apply_entries(p, args.get("entries", []), true, warnings)
	VoxelWorld.end_palette_batch()
	var out := describe(p)
	if not problems.is_empty():
		out["problems"] = problems
	if not warnings.is_empty():
		out["warnings"] = warnings
	return out

# Add (add_new) or set entries from specs. Returns problems (entries skipped).
static func _apply_entries(p: Palette, specs: Variant, add_new: bool, warnings: Array) -> Array:
	var problems: Array = []
	if not (specs is Array):
		return problems
	for spec in specs:
		if not (spec is Dictionary):
			problems.append("entries must be objects {semantic, block?, shape?}")
			continue
		var why := _check_entry(p, spec, warnings)
		if not why.is_empty():
			problems.append(why)
			continue
		var sem := str(spec["semantic"]).strip_edges()
		var e := p.get_entry(sem)
		if e == null:
			if not add_new:
				problems.append("'%s' isn't in palette '%s' (use add)" % [sem, p.name])
				continue
			e = VoxelWorld.add_palette_entry(p, sem)
		elif add_new and not spec.has("block") and not spec.has("shape"):
			continue
		var block := e.block_type_name
		var shape := e.shape_id
		if spec.has("block"):
			block = str(spec["block"]) if spec["block"] != null else ""
		if spec.has("shape"):
			shape = str(spec["shape"]) if spec["shape"] != null else ""
		VoxelWorld.set_palette_entry_picks(p, e, block, shape)
	return problems

static func _palette_update(args: Dictionary) -> Dictionary:
	var pv: Variant = _palette(str(args.get("name", "")))
	if McpRegistry.is_error(pv):
		return pv
	var p: Palette = pv
	if p.builtin:
		return McpRegistry.fail("read_only", "'%s' is built in; palette_create {from:\"%s\"} makes an editable copy" % [p.name, p.name])
	var warnings: Array = []
	var problems: Array = []
	VoxelWorld.begin_palette_batch()
	if args.get("libraries") is Array:
		VoxelWorld.set_palette_libraries(p, (args["libraries"] as Array).map(func(x: Variant) -> String: return str(x)))
	if args.get("remove") is Array:
		for sem in args["remove"]:
			var e := p.get_entry(str(sem))
			if e == null:
				problems.append("no entry '%s' to remove" % sem)
			else:
				VoxelWorld.remove_palette_entry(p, e)
	if args.get("rename") is Dictionary:
		for old in args["rename"]:
			var e := p.get_entry(str(old))
			if e == null or not VoxelWorld.rename_palette_entry(p, e, str(args["rename"][old])):
				problems.append("couldn't rename '%s' (missing, or the new name is taken)" % old)
	problems.append_array(_apply_entries(p, args.get("add", []), true, warnings))
	problems.append_array(_apply_entries(p, args.get("set", []), false, warnings))
	if args.has("rename_palette") and not VoxelWorld.rename_palette(p, str(args["rename_palette"])):
		problems.append("couldn't rename the palette to '%s' (empty or taken)" % args["rename_palette"])
	VoxelWorld.end_palette_batch()
	var out := describe(p)
	if not problems.is_empty():
		out["problems"] = problems
	if not warnings.is_empty():
		out["warnings"] = warnings
	return out

static func _palette_delete(args: Dictionary) -> Dictionary:
	var pv: Variant = _palette(str(args.get("name", "")))
	if McpRegistry.is_error(pv):
		return pv
	if not bool(args.get("confirm", false)):
		return McpRegistry.fail("needs_confirm", "deleting a palette needs confirm: true")
	var p: Palette = pv
	if p.builtin:
		return McpRegistry.fail("read_only", "the built-in palette can't be deleted")
	VoxelWorld.remove_palette(p)
	return {"deleted": p.name}

static func _project_palettes_set(args: Dictionary) -> Dictionary:
	var proj: Variant = McpArgs.project(args)
	if McpRegistry.is_error(proj):
		return proj
	var names: Array = []
	for n in args.get("palettes", []):
		if VoxelWorld.workspace.get_palette(str(n)) == null:
			return McpRegistry.fail("not_found", "no palette named '%s'" % n)
		names.append(str(n))
	VoxelWorld.set_palette_stack(proj, names)
	return {"project": (proj as VoxelProject).name, "palettes": names, "semantics": Array(VoxelWorld.merged_semantic_names())}
