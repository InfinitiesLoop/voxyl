extends RefCounted

# Editing: every tool builds an edit list and commits it through McpArgs.commit →
# VoxelWorld.apply_edits — one undo step per call, rules-checked, with a reason for every
# rejected placement. All accept project / symmetry / repeat / dry_run / only_air / animate.

static func register(reg: McpRegistry) -> void:
	reg.add("cells_set",
		"Place whole blocks. cells: [{pos:[x,y,z], semantic?, facing?, top?}] (semantic defaults to the top-level one), or semantic + positions:[[x,y,z],...]. Overwrites what's there (use only_air to keep it). Shaped semantics need parts_add.",
		_props({
			"semantic": {"type": "string"},
			"cells": {"type": "array", "items": {"type": "object"}},
			"positions": {"type": "array", "items": {"type": "array"}},
			"facing": {"type": "string", "description": "Default facing for oriented blocks (north/east/south/west/up/down). For a torch-like block: the way it points, up = standing on the block below, north = leaning out of the wall on its south side"},
			"attached_to": {"type": "string", "description": "For a torch-like block: which side the block holding it is on (down = standing on the floor, north = on the north wall). Torches can't attach to up (they don't hang from the block above)"},
		}), _cells_set, {"mutates": true})
	reg.add("parts_add",
		"Add shaped parts. items: [{pos, semantic?, slot? | orient?}] — slot by name (\"north\", \"south-east\", \"down-north-west\", \"center-y\") for microblocks, orient {up, facing} for architecture shapes. The shape comes from the semantic's palette entry. Each rejected part comes back with a reason.",
		_props({
			"semantic": {"type": "string"},
			"items": {"type": "array", "items": {"type": "object"}},
			"slot": {"description": "Default slot for items without one"},
			"orient": {"type": "object", "description": "Default orient for items without a slot"},
		}, ["items"]), _parts_add, {"mutates": true})
	reg.add("cells_clear",
		"Clear cells: positions, or a region (optionally only cells/parts of one semantic, or only part cells).",
		_props({
			"positions": {"type": "array", "items": {"type": "array"}},
			"region": McpArgs.s_region(),
			"semantic": {"type": "string", "description": "Only clear this semantic (removes just its parts from part cells)"},
			"parts_only": {"type": "boolean"},
		}), _cells_clear, {"mutates": true})
	reg.add("cells_place_layers",
		"Author structure as text (see conventions): origin [x,y,z], axis (y = plan layers going up; z / x = elevations), legend {char: \"Semantic\" | {semantic, facing, top} | [{semantic, slot|orient}, ...]}, layers [[row, ...], ...]. \".\"/space = untouched, \"_\" = clear. A parts character makes the cell exactly those parts. Combine with symmetry to draw one quarter.",
		_props({
			"origin": McpArgs.s_vec3(),
			"axis": {"type": "string", "enum": ["y", "z", "x"]},
			"legend": {"type": "object"},
			"layers": {"type": "array", "description": "Array of layers; each layer an array of row strings (a single string is one row)"},
		}, ["origin", "legend", "layers"]), _place_layers, {"mutates": true})
	reg.add("region_fill",
		"Fill a region with a semantic in a style: solid, hollow (shell), walls (4 sides), frame (12 edges), floor (bottom layer). For a shaped semantic give slot/orient: every cell gets that part.",
		_props({
			"region": McpArgs.s_region(),
			"semantic": {"type": "string"},
			"style": {"type": "string", "enum": RegionOps.FILL_STYLES},
			"facing": {"type": "string"},
			"top": {"type": "boolean"},
			"slot": {"description": "For a shaped semantic"},
			"orient": {"type": "object", "description": "For a shaped architecture semantic"},
		}, ["region", "semantic"]), _region_fill, {"mutates": true})
	reg.add("region_replace",
		"Swap one semantic for another inside a region (whole blocks keep their facing; parts keep their shape and slot; swapping an ordinary block for a torch-like one stands the torch up).",
		_props({
			"region": McpArgs.s_region(),
			"from": {"type": "string"},
			"to": {"type": "string"},
		}, ["from", "to"]), _region_replace, {"mutates": true})
	reg.add("region_move",
		"Move everything in a region by an offset (cut + paste as one step).",
		_props({
			"region": McpArgs.s_region(),
			"by": McpArgs.s_vec3("[dx, dy, dz]"),
		}, ["region", "by"]), _region_move, {"mutates": true})
	reg.add("region_copy",
		"Copy a region to the clipboard (the same clipboard the user's Ctrl+C / Ctrl+V use).",
		{"properties": {"region": McpArgs.s_region(), "project": {"type": "string"}}, "required": ["region"]},
		_region_copy)
	reg.add("clipboard_paste",
		"Paste the clipboard with its min corner at `at`, optionally rotated (quarter turns clockwise seen from above) and/or mirrored. North is north: a copy taken in a project with a different `north` (see project_settings) is first turned to this project's, then `rotate` / `mirror` apply. Keeps occupied cells unless overwrite:true.",
		_props({
			"at": McpArgs.s_vec3(),
			"rotate": {"type": "integer", "description": "0-3 quarter turns clockwise (from above)"},
			"mirror": {"type": "string", "enum": ["x", "z"]},
			"overwrite": {"type": "boolean"},
		}, ["at"]), _clipboard_paste, {"mutates": true})
	reg.add("region_transform",
		"Rotate (90° steps, clockwise from above) and/or mirror (x/z) a region in place about a pivot — the paste-rotation math applied without a copy/paste round trip. Default pivot is the region's own center; pivot:[x,z] uses the same cell-coordinate convention as symmetry centers (.5 = on a cell boundary). Parts without a mirror image come back rejected with a reason, same as clipboard_paste.",
		_props({
			"region": McpArgs.s_region(),
			"rotate": {"type": "integer", "description": "0-3 quarter turns clockwise (from above)"},
			"mirror": {"type": "string", "enum": ["x", "z"]},
			"pivot": {"type": "array", "items": {"type": "number"}, "description": "[x, z]; default the region's own center"},
		}, ["region"]), _region_transform, {"mutates": true})
	reg.add("selection_set",
		"Set the region selection every view shows (the Select tool's box). Drops any filter or grow/shrink mask from before — always starts a fresh box.",
		{"properties": {"region": McpArgs.s_region()}, "required": ["region"]}, _selection_set, {"mutates": true})
	reg.add("selection_clear", "Clear the region selection.", {}, _selection_clear, {"mutates": true})
	reg.add("selection_isolate",
		"Show only the selection in the user's 3D views — every cell outside it is hidden (and clicks pass through), the same switch as \"Show only the selection\" on the selection panel. Use it to let the user check exactly which cells are selected, especially a sparse selection. Needs a selection; clearing the selection switches it off. No arguments reads the state.",
		{"properties": {"enabled": {"type": "boolean", "description": "true to show only the selection, false to show everything again"}}},
		_selection_isolate, {"mutates": true})
	reg.add("selection_resize",
		"Resize the selection box by moving its faces — what the +/- buttons on the selection panel do, but by any amount and several faces at once. `by` moves all six faces outward by that many cells, negative = inward: by:2 grows the box 2 cells on every side, by:-1 shrinks it 1 cell on every side. x / y / z do the same for just that axis's two faces (by:2, y:0 grows it horizontally only). up / down / north / south / east / west move a single face, positive = outward, negative = inward (up:-2 lowers the top by 2). A face word beats its axis, which beats `by`. The filter is kept. Refused, leaving the selection as it was: a shrink that would push a face past its opposite (a face may meet it, leaving a 1-cell-thick box) or a box over 4,000,000 cells. Moves the box itself, so it can take in air and cells of any semantic — unlike selection_grow/selection_shrink, which work on built cells. Only for a box: a sparse selection (from structure_find, selection_grow/shrink or selection_combine) is a set of cells, not a box — resize those with selection_grow/selection_shrink, or flatten one to its bounding box first with selection_set {region:{selection:true}}.",
		{"properties": {
			"by": {"type": "integer", "description": "Cells to move every face outward (negative = inward)"},
			"x": {"type": "integer", "description": "Cells to move both x faces (west and east) outward"},
			"y": {"type": "integer", "description": "Cells to move both y faces (down and up) outward"},
			"z": {"type": "integer", "description": "Cells to move both z faces (north and south) outward"},
			"up": {"type": "integer", "description": "Cells to move the +y face outward"},
			"down": {"type": "integer", "description": "Cells to move the -y face outward"},
			"north": {"type": "integer", "description": "Cells to move the -z face outward"},
			"south": {"type": "integer", "description": "Cells to move the +z face outward"},
			"east": {"type": "integer", "description": "Cells to move the +x face outward"},
			"west": {"type": "integer", "description": "Cells to move the -x face outward"},
			"project": {"type": "string"},
		}}, _selection_resize, {"mutates": true})
	reg.add("selection_filter",
		"Narrow the region selection to matching semantics without changing its box — a whitelist and/or blacklist of semantic names (e.g. select a box spanning two pillars and a connecting wall, then whitelist just the pillar's semantic so copy/cut/delete/etc. only ever touch the pillars). clear:true removes the filter. Requires an active selection.",
		{"properties": {
			"whitelist": {"type": "array", "items": {"type": "string"}},
			"blacklist": {"type": "array", "items": {"type": "string"}},
			"clear": {"type": "boolean"},
		}}, _selection_filter, {"mutates": true})
	reg.add("selection_grow",
		"Grow the selection by flood-filling same-semantic neighbors out from its current cells (built cells only — it never takes in air and doesn't move a box's faces: for that use selection_resize), `range` steps of face-adjacency (6-connectivity; diagonal:true adds the 12 edge/8 corner neighbors too) — never crosses a gap of non-matching cells, so it can end up disjoint. Each cell's own semantic is the growth target unless `semantic` overrides it for every seed. Replaces the selection with the exact grown cell set and folds whatever it grew into into the selection's filter, so a grow followed by copy/cut/delete/etc. only touches that material even where the grown area overlaps mixed cells.",
		{"properties": {
			"range": {"type": "integer", "description": "Steps to grow, default 1"},
			"semantic": {"type": "string", "description": "Grow into this semantic instead of each seed's own"},
			"diagonal": {"type": "boolean"},
		}}, _selection_grow, {"mutates": true})
	reg.add("structure_find",
		"Find the connected structure a cell belongs to and (by default) select exactly its cells: a sparse selection, so blocks that aren't part of it stay unselected even inside its bounding box, and copy/cut/delete/replace/transform with {selection:true} touch only the structure. What belongs to it: cells holding one of `semantics` and/or any semantic a `palette` defines, minus `exclude`; with none of those given, just the seed cell's own semantic(s). Cells connect when adjacent, diagonals included (diagonal:false = faces only); `gap` N also lets it jump up to N empty or excluded cells, so a structure with a missing block or a window still reads as one. `from` is a cell [x,y,z] (snaps to the nearest matching cell within reach), a list of cells, or a region whose matching cells all seed the search; `within` bounds the search. Returns the cell count, bounds, whether the box holds more than the structure (`sparse`), per-semantic counts and `materials`. select:false only reports and leaves the user's selection alone.",
		{"properties": {
			"from": {"description": "Seed: a cell [x,y,z], a list of cells, or a region ({min,max} | {selection:true} | ...) whose cells of the allowed semantics all seed the search"},
			"semantics": {"type": "array", "items": {"type": "string"}, "description": "Semantics the structure may expand into"},
			"palette": {"type": "string", "description": "A palette name: every semantic it defines may be expanded into (added to `semantics`)"},
			"palettes": {"type": "array", "items": {"type": "string"}, "description": "Several palette names"},
			"exclude": {"type": "array", "items": {"type": "string"}, "description": "Semantics to leave out of the above (e.g. a palette's ground)"},
			"gap": {"type": "integer", "description": "Empty or excluded cells it may jump, default 0 (must be adjacent); max %d" % MAX_STRUCTURE_GAP},
			"diagonal": {"type": "boolean", "description": "Whether diagonal neighbors connect, default true"},
			"within": McpArgs.s_region("Only search inside this region"),
			"select": {"type": "boolean", "description": "Select the result in the user's views, default true"},
			"max_cells": {"type": "integer", "description": "Stop after this many cells (default 400000); `truncated` says it did (it also stops after ~15 s)"},
			"project": {"type": "string"},
		}, "required": ["from"]}, _structure_find, {"mutates": true})
	reg.add("selection_shrink",
		"Erode the selection by `range` steps: repeatedly drops cells with a face-neighbor outside the current set. A plain box is first turned into an exact cell set of its built cells (capped at 4,000,000 cells, same as any region), so a hollow room's box erodes away entirely; to pull a box's faces in instead use selection_resize with a negative `by`.",
		{"properties": {"range": {"type": "integer", "description": "Steps to shrink, default 1"}}}, _selection_shrink, {"mutates": true})
	reg.add("selection_combine",
		"Combine two sets of cells with a set operation and make the result the selection — to select exactly what you mean, e.g. a room's walls (base: the room's box, operation: except, with: its inner box) or everything but the ground. operation: union (cells in either), except (in the base but not in `with`), intersect (in both), xor (in exactly one). `base` is the first set and defaults to the current selection; `with` is the second set, or a list of them folded in order (except [door, window] removes both). A set is any Region — a box, {selection:true}, {all:true}, ... with an optional filter — and only built cells count, so a box around a room's interior holds what's in it, not the air. {semantic:\"X\"} is the box where X is used, not just X's cells: for the cells holding X use {all:true, filter:{whitelist:[\"X\"]}}. The result is an exact (sparse) cell set that replaces the selection, so copy/cut/delete/replace/transform with {selection:true} touch only it. except/intersect keep the base's filter; union/xor widen it to cover both sides. Fails with empty_region, leaving the selection alone, if nothing is left. select:false only reports the result (counts, bounds, materials) and leaves the user's selection alone.",
		{"properties": {
			"operation": {"type": "string", "enum": RegionOps.SET_OPS},
			"base": McpArgs.s_region("The first set: a region. Omit to use the current selection (its cells, filter and grow/shrink mask)"),
			"with": {"description": "The second set: a region, or a list of regions folded into the base in order with the same operation"},
			"select": {"type": "boolean", "description": "Make the result the selection in the user's views, default true"},
			"project": {"type": "string"},
		}, "required": ["operation", "with"]}, _selection_combine, {"mutates": true})

static func _props(extra: Dictionary, required: Array = []) -> Dictionary:
	var p := McpArgs.edit_props()
	p.merge(extra)
	var s := {"properties": p}
	if not required.is_empty():
		s["required"] = required
	return s

static func _cells_set(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var default_sem := str(args.get("semantic", ""))
	var edits: Array = []
	var items: Array = args.get("cells", [])
	for p in args.get("positions", []):
		items.append({"pos": p})
	if items.is_empty():
		return McpRegistry.fail("bad_argument", "give cells:[{pos, semantic}] or semantic + positions")
	for it in items:
		if not (it is Dictionary):
			return McpRegistry.fail("bad_argument", "cells must be objects {pos, semantic?}")
		var pos: Variant = McpArgs.vec3i_or_fail(it.get("pos"), "pos")
		if McpRegistry.is_error(pos):
			return pos
		var spec: Dictionary = it.duplicate()
		if not spec.has("facing") and args.has("facing"):
			spec["facing"] = args["facing"]
		if not spec.has("facing") and not spec.has("attached_to") and args.has("attached_to"):
			spec["attached_to"] = args["attached_to"]
		var sem := str(it.get("semantic", default_sem))
		var o: Variant = McpArgs.orientation_for(sem, spec)
		if McpRegistry.is_error(o):
			return o
		edits.append({"pos": pos, "op": "block", "semantic": sem, "orientation": o})
	return McpArgs.commit("cells_set", edits, args)

static func _parts_add(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var edits: Array = []
	var rejected: Array = []
	for it in args.get("items", []):
		if not (it is Dictionary):
			return McpRegistry.fail("bad_argument", "items must be objects {pos, semantic?, slot?|orient?}")
		var pos: Variant = McpArgs.vec3i_or_fail(it.get("pos"), "pos")
		if McpRegistry.is_error(pos):
			return pos
		var spec: Dictionary = it.duplicate()
		if not spec.has("slot") and not spec.has("orient"):
			if args.has("slot"):
				spec["slot"] = args["slot"]
			elif args.has("orient"):
				spec["orient"] = args["orient"]
		var part: Variant = McpArgs.part_for(str(it.get("semantic", args.get("semantic", ""))), spec)
		if McpRegistry.is_error(part):
			var e: Dictionary = part[McpRegistry.ERROR_KEY]
			rejected.append({"pos": pos, "reason": e["code"], "detail": e["message"]})
			continue
		edits.append({"pos": pos, "op": "part", "part": part})
	return McpArgs.commit("parts_add", edits, args, rejected)

static func _cells_clear(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var data := (pv as VoxelProject).data
	var edits: Array = []
	var sem := str(args.get("semantic", ""))
	var parts_only := bool(args.get("parts_only", false))
	for p in args.get("positions", []):
		var pos: Variant = McpArgs.vec3i_or_fail(p, "positions[]")
		if McpRegistry.is_error(pos):
			return pos
		edits.append_array(RegionOps.clear_edits(data, pos, pos, sem, parts_only))
	if args.has("region"):
		var r: Variant = McpArgs.region(args["region"])
		if McpRegistry.is_error(r):
			return r
		edits.append_array(RegionOps.clear_edits(data, r["min"], r["max"], sem, parts_only, r["filter"], r.get("positions")))
	if edits.is_empty() and not args.has("region") and not args.has("positions"):
		return McpRegistry.fail("bad_argument", "give positions or region")
	return McpArgs.commit("cells_clear", edits, args)

static func _place_layers(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var origin: Variant = McpArgs.vec3i_or_fail(args.get("origin"), "origin")
	if McpRegistry.is_error(origin):
		return origin
	var axis := str(args.get("axis", "y"))
	if not axis in ["x", "y", "z"]:
		return McpRegistry.fail("bad_argument", "axis must be y, z or x")
	if not (args.get("legend") is Dictionary):
		return McpRegistry.fail("bad_argument", "legend must be an object {char: value}")
	var resolved := {}
	var problems: Array = []
	for ch in args["legend"]:
		var key := str(ch)
		if key.length() != 1 or key in [".", "_", " "]:
			problems.append("legend key '%s' must be one character other than . _ and space" % key)
			continue
		var v: Variant = args["legend"][ch]
		if v is String:
			if VoxelWorld.is_shaped_semantic(v):
				problems.append("'%s' → '%s' is a shaped entry; write it as [{semantic, slot}]" % [key, v])
				continue
			resolved[key] = {"op": "block", "semantic": v, "orientation": VoxelWorld.default_orientation_for_semantic(v)}
		elif v is Dictionary:
			var o: Variant = McpArgs.orientation_for(str(v.get("semantic", "")), v)
			if McpRegistry.is_error(o):
				problems.append("'%s': %s" % [key, o[McpRegistry.ERROR_KEY]["message"]])
				continue
			resolved[key] = {"op": "block", "semantic": str(v.get("semantic", "")), "orientation": o}
		elif v is Array:
			var parts: Array = []
			for spec in v:
				var part: Variant = McpArgs.part_for(str(spec.get("semantic", "")) if spec is Dictionary else "", spec if spec is Dictionary else {})
				if McpRegistry.is_error(part):
					problems.append("'%s': %s" % [key, part[McpRegistry.ERROR_KEY]["message"]])
					continue
				parts.append(part)
			if not parts.is_empty():
				resolved[key] = {"op": "parts", "parts": parts}
		else:
			problems.append("legend '%s' must be a semantic, {semantic, facing}, or a list of parts" % key)
	if not problems.is_empty():
		return McpRegistry.fail("bad_legend", "; ".join(problems))
	var r := RegionCodec.edits_from_layers(axis, origin, args.get("layers", []), resolved)
	if not (r["errors"] as Array).is_empty():
		return McpRegistry.fail("bad_layers", "; ".join((r["errors"] as Array).slice(0, 10)))
	return McpArgs.commit("cells_place_layers", r["edits"], args)

static func _region_fill(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var r: Variant = McpArgs.region(args.get("region"))
	if McpRegistry.is_error(r):
		return r
	var style := str(args.get("style", "solid"))
	if not style in RegionOps.FILL_STYLES:
		return McpRegistry.fail("bad_argument", "style must be one of %s" % str(RegionOps.FILL_STYLES))
	var sem := str(args.get("semantic", ""))
	var template: Dictionary
	if VoxelWorld.is_shaped_semantic(sem):
		var part: Variant = McpArgs.part_for(sem, args)
		if McpRegistry.is_error(part):
			return part
		template = {"op": "part", "part": part}
	else:
		var o: Variant = McpArgs.orientation_for(sem, args)
		if McpRegistry.is_error(o):
			return o
		template = {"op": "block", "semantic": sem, "orientation": o}
	var edits := RegionOps.fill_edits(r["min"], r["max"], style, template, r["filter"], r.get("positions"), (pv as VoxelProject).data)
	return McpArgs.commit("region_fill", edits, args)

static func _region_replace(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var r: Variant = McpArgs.region(args.get("region"), true)
	if McpRegistry.is_error(r):
		return r
	# Swapping an ordinary block for an attachable one (Stone -> Torch): the old facing means
	# nothing to it, so it stands in its default pose rather than inheriting "north".
	var reorient := -1
	if not VoxelWorld.attachment_for_semantic(str(args["to"])).is_empty() \
			and VoxelWorld.attachment_for_semantic(str(args["from"])).is_empty():
		reorient = VoxelWorld.default_orientation_for_semantic(str(args["to"]))
	var edits := RegionOps.replace_edits((pv as VoxelProject).data, r["min"], r["max"], str(args["from"]), str(args["to"]), r["filter"], r.get("positions"), reorient)
	return McpArgs.commit("region_replace", edits, args)

static func _region_move(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var r: Variant = McpArgs.region(args.get("region"))
	if McpRegistry.is_error(r):
		return r
	var by: Variant = McpArgs.vec3i_or_fail(args.get("by"), "by")
	if McpRegistry.is_error(by):
		return by
	var edits := RegionOps.move_edits((pv as VoxelProject).data, r["min"], r["max"], by, r["filter"], r.get("positions"))
	return McpArgs.commit("region_move", edits, args)

static func _region_copy(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var r: Variant = McpArgs.region(args.get("region"))
	if McpRegistry.is_error(r):
		return r
	var n := VoxelWorld.copy_region(r["min"], r["max"], r["filter"], r.get("positions"))
	return {"copied_cells": n, "size": VoxelWorld.clipboard_size()}

static func _clipboard_paste(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	if not VoxelWorld.has_clipboard():
		return McpRegistry.fail("empty_clipboard", "the clipboard is empty; region_copy first")
	var at: Variant = McpArgs.vec3i_or_fail(args.get("at"), "at")
	if McpRegistry.is_error(at):
		return at
	# The copy's own north is brought to this project's first, so it keeps its bearing across
	# projects with different norths (VoxelProject.turns_between); `rotate` acts from there.
	var b := RegionOps.turn_basis(int(args.get("rotate", 0)) + VoxelWorld.turns_into_project(VoxelWorld.clipboard_north()),
		str(args.get("mirror", "")))
	var r := RegionOps.paste_edits(VoxelWorld.clipboard_cells(), VoxelWorld.clipboard_size(), at, b)
	var a := args.duplicate()
	if not bool(args.get("overwrite", false)):
		a["only_air"] = true
	return McpArgs.commit("clipboard_paste", r["edits"], a, r["rejected"])

static func _region_transform(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var data := (pv as VoxelProject).data
	var r: Variant = McpArgs.region(args.get("region"))
	if McpRegistry.is_error(r):
		return r
	var mn: Vector3i = r["min"]
	var mx: Vector3i = r["max"]
	var rotate := int(args.get("rotate", 0)) % 4
	var mirror := str(args.get("mirror", ""))
	if rotate == 0 and mirror.is_empty():
		return McpRegistry.fail("bad_argument", "give rotate (1-3) and/or mirror (x/z)")
	var pivot: Vector3
	var explicit_pivot := args.has("pivot")
	if explicit_pivot:
		var p: Variant = args["pivot"]
		if not (p is Array) or (p as Array).size() < 2:
			return McpRegistry.fail("bad_argument", "pivot must be [x, z]")
		pivot = Vector3(float(p[0]), 0.0, float(p[1]))
	else:
		pivot = Vector3((mn.x + mx.x) / 2.0, 0.0, (mn.z + mx.z) / 2.0)
	var b := Basis(Vector3.UP, deg_to_rad(-90.0 * rotate))
	match mirror:
		"x": b = Basis(Vector3(-1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, 1)) * b
		"z": b = Basis(Vector3(1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, -1)) * b
	var t := SpatialXform.about(b, pivot)
	# A quarter turn only maps cells onto cells when the pivot's x and z are both whole or
	# both on a boundary (.5). A region with one even and one odd side has a mixed center:
	# nudge that default pivot half a cell (the turned region lands half a cell off-center,
	# which can't be avoided); an explicit mixed pivot is refused rather than rounded into
	# a gapped, stretched result.
	if not t.is_grid_aligned(mn):
		if explicit_pivot:
			return McpRegistry.fail("bad_argument",
				"pivot %s puts cells between cells for this turn; use a pivot whose x and z are both whole or both .5" % str([pivot.x, pivot.z]))
		pivot.z = floorf(pivot.z) if not is_equal_approx(pivot.z, roundf(pivot.z)) else pivot.z - 0.5
		t = SpatialXform.about(b, pivot)
	var result := RegionOps.transform_edits(data, mn, mx, t, r["filter"], r.get("positions"))
	return McpArgs.commit("region_transform", result["edits"], args, result["rejected"])

static func _selection_set(args: Dictionary) -> Dictionary:
	if VoxelWorld.active_project == null:
		return McpRegistry.fail("no_project", "no project is open")
	var r: Variant = McpArgs.region(args.get("region"))
	if McpRegistry.is_error(r):
		return r
	VoxelWorld.set_selection_box(r["min"], r["max"])
	return {"selection": {"min": VoxelWorld.selection_min, "max": VoxelWorld.selection_max}}

static func _selection_clear(_args: Dictionary) -> Dictionary:
	VoxelWorld.clear_selection()
	return {"selection": null}

const _RESIZE_KEYS := ["by", "x", "y", "z", "up", "down", "north", "south", "east", "west"]
const _RESIZE_AXES := ["x", "y", "z"]
# Face word → [axis, is the max side] (north = -Z, east = +X, up = +Y: see McpConventions).
const _RESIZE_FACES := {"west": [0, false], "east": [0, true], "down": [1, false], "up": [1, true],
	"north": [2, false], "south": [2, true]}
const _MAX_RESIZE := 100000

static func _selection_resize(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var amounts := {}
	for key: String in _RESIZE_KEYS:
		var v: Variant = _resize_amount(args, key)
		if McpRegistry.is_error(v):
			return v
		if v != null:
			amounts[key] = v
	if amounts.is_empty():
		return McpRegistry.fail("bad_argument", "give `by`, an axis (x, y, z) or a face (up, down, north, south, east, west)")
	if not VoxelWorld.has_selection:
		return McpRegistry.fail("no_selection", "there's no region selection")

	# How far each face moves outward: a face word beats its axis, which beats `by`.
	var grow_min := Vector3i.ZERO
	var grow_max := Vector3i.ZERO
	for axis in 3:
		var both: int = amounts.get(_RESIZE_AXES[axis], amounts.get("by", 0))
		grow_min[axis] = both
		grow_max[axis] = both
	for face: String in _RESIZE_FACES:
		if amounts.has(face):
			var spec: Array = _RESIZE_FACES[face]
			if spec[1]:
				grow_max[spec[0]] = amounts[face]
			else:
				grow_min[spec[0]] = amounts[face]

	var size := VoxelWorld.selection_max - VoxelWorld.selection_min + Vector3i.ONE
	var result := VoxelWorld.resize_selection(grow_min, grow_max)
	if result.has("error"):
		match str(result["error"]):
			"masked": return McpRegistry.fail("masked_selection", "the selection is a sparse set of cells, not a box, so it has no faces to move: resize it with selection_grow / selection_shrink, or flatten it to its bounding box first with selection_set {region:{selection:true}}")
			"too_small": return McpRegistry.fail("too_small", "that would push a face past its opposite: the selection is only %d x %d x %d cells (x, y, z), so it can shrink by at most half of that on each axis, rounded down" % [size.x, size.y, size.z])
			"too_large": return McpRegistry.fail("too_large", "the resized box would hold over 4,000,000 cells; use a smaller change")
			_: return McpRegistry.fail("no_selection", "there's no region selection")
	size = VoxelWorld.selection_max - VoxelWorld.selection_min + Vector3i.ONE
	return {"min": VoxelWorld.selection_min, "max": VoxelWorld.selection_max, "size": size,
		"cells": VoxelWorld.selection_positions().size(), "filter": VoxelWorld.selection_filter}

# `key`'s value as a whole number of cells: null if it wasn't given, the int if it's fine, else
# a bad_argument failure (a string, a fraction, or an absurd distance that could overflow).
static func _resize_amount(args: Dictionary, key: String) -> Variant:
	if not args.has(key) or args[key] == null:
		return null
	var v: Variant = args[key]
	var numeric: bool = typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT
	if not numeric or not is_equal_approx(float(v), roundf(float(v))) or absf(float(v)) > _MAX_RESIZE:
		return McpRegistry.fail("bad_argument", "%s must be a whole number of cells, at most %d either way" % [key, _MAX_RESIZE])
	return int(v)

static func _selection_filter(args: Dictionary) -> Dictionary:
	if not VoxelWorld.has_selection:
		return McpRegistry.fail("no_selection", "there's no region selection")
	VoxelWorld.set_selection_filter(args.get("whitelist", []), args.get("blacklist", []), bool(args.get("clear", false)))
	return {"filter": VoxelWorld.selection_filter}

static func _selection_grow(args: Dictionary) -> Dictionary:
	if not VoxelWorld.has_selection:
		return McpRegistry.fail("no_selection", "there's no region selection")
	var result := VoxelWorld.grow_selection(int(args.get("range", 1)), str(args.get("semantic", "")), bool(args.get("diagonal", false)))
	if result.has("error"):
		match str(result["error"]):
			"empty_selection": return McpRegistry.fail("empty_region", "the selection has no cells to grow from")
			_: return McpRegistry.fail("no_selection", "there's no region selection")
	return {"cells": result["cells"], "filter": VoxelWorld.selection_filter, "bounds": [VoxelWorld.selection_min, VoxelWorld.selection_max]}

const MAX_STRUCTURE_GAP := 6
const _DEFAULT_STRUCTURE_CELLS := 400000
const _STRUCTURE_BUDGET_MS := 15000

static func _string_list(v: Variant) -> Variant:
	if v == null:
		return []
	if not (v is Array):
		return null
	var out: Array[String] = []
	for x in v:
		out.append(str(x))
	return out

static func _structure_find(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var data := VoxelWorld.active_project.data
	if not args.has("from"):
		return McpRegistry.fail("bad_argument", "from is required: a cell [x,y,z], a list of cells, or a region")
	var gap := int(args.get("gap", 0))
	if gap < 0 or gap > MAX_STRUCTURE_GAP:
		return McpRegistry.fail("bad_argument", "gap must be 0..%d" % MAX_STRUCTURE_GAP)
	var diagonal := bool(args.get("diagonal", true))
	var reach := gap + 1

	var within: Variant = null
	if args.get("within") != null:
		var w: Variant = McpArgs.region(args["within"])
		if McpRegistry.is_error(w):
			return w
		within = [w["min"], w["max"]]

	# What may belong to the structure.
	var named: Variant = _string_list(args.get("semantics"))
	var dropped: Variant = _string_list(args.get("exclude"))
	var palette_names: Variant = _string_list(args.get("palettes"))
	if named == null or dropped == null or palette_names == null:
		return McpRegistry.fail("bad_argument", "semantics, exclude and palettes must be arrays of names")
	if args.has("palette"):
		palette_names.append(str(args["palette"]))
	var allowed := {}
	var explicit: bool = not (named as Array).is_empty() or not (palette_names as Array).is_empty()
	for s in named:
		allowed[s] = true
	for pn in palette_names:
		var pal := VoxelWorld.workspace.get_palette(pn)
		if pal == null:
			return McpRegistry.fail("not_found", "no palette named '%s' (see palette_list)" % pn)
		for s in pal.semantic_names():
			allowed[s] = true
	for s in dropped:
		allowed.erase(s)
	if explicit and allowed.is_empty():
		return McpRegistry.fail("bad_argument", "nothing is left to expand into once `exclude` is applied")

	# Where it starts.
	var from: Variant = args["from"]
	var points: Array[Vector3i] = []
	var seeds: Array[Vector3i] = []
	if from is Dictionary:
		var r: Variant = McpArgs.region(from)
		if McpRegistry.is_error(r):
			return r
		var in_region := RegionOps.cells_in(data, r["min"], r["max"], r["filter"], r.get("positions"))
		if in_region.is_empty():
			return McpRegistry.fail("empty_region", "there are no cells in the `from` region")
		if not explicit:
			for p in in_region:
				for s in RegionOps.semantics_of(data.cells[p]):
					allowed[s] = true
		for p in in_region:
			seeds.append(p)
	elif from is Array:
		var list: Array = from
		if list.size() >= 3 and not (list[0] is Array or list[0] is Dictionary):
			list = [from]
		for item in list:
			var p: Variant = McpArgs.vec3i_or_fail(item, "from")
			if McpRegistry.is_error(p):
				return p
			points.append(p)
		if points.is_empty():
			return McpRegistry.fail("bad_argument", "from is empty")
		if not explicit:
			# No allow-list: the structure is made of whatever the seed cell is made of.
			for p in points:
				var near: Variant = RegionOps.nearest_occupied(data, p, reach)
				if near == null:
					return McpRegistry.fail("no_seed", "nothing is within %d cell(s) of %s to start from" % [reach, [p.x, p.y, p.z]])
				for s in RegionOps.semantics_of(data.cells[near]):
					allowed[s] = true
		for p in points:
			var start: Variant = RegionOps.nearest_in_search(data, p, allowed, reach, within)
			if start == null:
				var held: Variant = data.cells.get(p)
				var what := " (empty)" if held == null else " (it holds '%s')" % ", ".join(RegionOps.semantics_of(held))
				return McpRegistry.fail("no_seed", "no cell holding one of the allowed semantics is within %d cell(s) of %s%s; add its semantic to `semantics` or pick another cell" % [
					reach, [p.x, p.y, p.z], what])
			seeds.append(start)
	else:
		return McpRegistry.fail("bad_argument", "from must be a cell [x,y,z], a list of cells, or a region")

	var cap := int(args.get("max_cells", _DEFAULT_STRUCTURE_CELLS))
	var res := RegionOps.connected_cells(data, seeds, allowed, gap, diagonal, within, maxi(cap, 0), _STRUCTURE_BUDGET_MS)
	var found: Dictionary = res["cells"]
	if found.is_empty():
		return McpRegistry.fail("no_seed", "none of the seed cells holds an allowed semantic")

	var lo := Vector3i(1 << 30, 1 << 30, 1 << 30)
	var hi := Vector3i(-(1 << 30), -(1 << 30), -(1 << 30))
	for p: Vector3i in found:
		lo = Vector3i(mini(lo.x, p.x), mini(lo.y, p.y), mini(lo.z, p.z))
		hi = Vector3i(maxi(hi.x, p.x), maxi(hi.y, p.y), maxi(hi.z, p.z))
	var allowed_list: Array = allowed.keys()
	allowed_list.sort()
	var stats := RegionOps.stats(data, lo, hi, {"whitelist": allowed_list}, found.keys())
	var select := bool(args.get("select", true))
	if select:
		VoxelWorld.set_selection_cells(found, allowed_list)
	var size := hi - lo + Vector3i.ONE
	var out := {
		"cells": found.size(), "bounds": [lo, hi], "size": size,
		"sparse": found.size() < size.x * size.y * size.z,
		"selected": select, "truncated": res["truncated"],
		"seeds": seeds.slice(0, 10),
		"semantics": RegionOps.stats_semantic_counts(stats),
		"blocks": stats["blocks"], "parts": stats["parts"],
		"materials": MaterialList.to_json(MaterialList.from_stats(stats)),
	}
	if not explicit:
		out["expanded_into"] = allowed_list
	return out

static func _selection_shrink(args: Dictionary) -> Dictionary:
	if not VoxelWorld.has_selection:
		return McpRegistry.fail("no_selection", "there's no region selection")
	var result := VoxelWorld.shrink_selection(int(args.get("range", 1)))
	if result.has("error"):
		match str(result["error"]):
			"too_large": return McpRegistry.fail("too_large", "the selection box has too many cells to shrink (max 4,000,000); narrow it first")
			_: return McpRegistry.fail("no_selection", "there's no region selection")
	return {"cells": result["cells"], "bounds": [VoxelWorld.selection_min, VoxelWorld.selection_max]}

static func _selection_combine(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var data := (pv as VoxelProject).data
	var operation := str(args.get("operation", ""))
	if not RegionOps.SET_OPS.has(operation):
		return McpRegistry.fail("bad_argument", "operation must be one of: %s" % ", ".join(RegionOps.SET_OPS))

	var base_spec: Variant = args.get("base")
	if base_spec == null:
		if not VoxelWorld.has_selection:
			return McpRegistry.fail("no_selection", "there's no `base` to start from: pass one, or make a selection first")
		base_spec = {"selection": true}
	var operands: Variant = args.get("with")
	if operands is Dictionary:
		operands = [operands]
	if not (operands is Array) or (operands as Array).is_empty():
		return McpRegistry.fail("bad_argument", "with is required: a region, or a list of regions to fold into the base")

	var current := _region_cell_set(data, base_spec, "base")
	if McpRegistry.is_error(current):
		return current
	var inputs: Array = [(current["cells"] as Dictionary).size()]
	for i in (operands as Array).size():
		var next := _region_cell_set(data, operands[i], "with[%d]" % i)
		if McpRegistry.is_error(next):
			return next
		inputs.append((next["cells"] as Dictionary).size())
		current = {
			"cells": RegionOps.combine_cells(current["cells"], next["cells"], operation),
			"filter": RegionOps.combine_filters(current["filter"], next["filter"], operation),
		}

	var cells: Dictionary = current["cells"]
	if cells.is_empty():
		return McpRegistry.fail("empty_region", "the result has no cells (the sets held %s), so the selection is unchanged" % [inputs])
	var filter: Dictionary = current["filter"]
	var bounds := RegionOps.cell_bounds(cells)
	var select := bool(args.get("select", true))
	if select:
		VoxelWorld.set_selection_cells(cells, filter.get("whitelist", []), filter.get("blacklist", []))
	var stats := RegionOps.stats(data, bounds[0], bounds[1], filter, cells.keys())
	var size: Vector3i = bounds[1] - bounds[0] + Vector3i.ONE
	return {
		"operation": operation, "inputs": inputs, "cells": cells.size(), "bounds": bounds, "size": size,
		"sparse": cells.size() < size.x * size.y * size.z, "selected": select, "filter": filter,
		"semantics": RegionOps.stats_semantic_counts(stats),
		"materials": MaterialList.to_json(MaterialList.from_stats(stats)),
	}

# A region as the cell set it holds: { cells: Dictionary (Vector3i → true), filter }. Only
# built cells count, narrowed by the region's own filter (a selection's mask included).
# A bad region fails naming which argument it was.
static func _region_cell_set(data: VoxelData, spec: Variant, label: String) -> Dictionary:
	var r: Variant = McpArgs.region(spec)
	if McpRegistry.is_error(r):
		var e: Dictionary = r[McpRegistry.ERROR_KEY]
		return McpRegistry.fail(str(e["code"]), "%s: %s" % [label, e["message"]])
	var cells := {}
	for p in RegionOps.cells_in(data, r["min"], r["max"], r["filter"], r.get("positions")):
		cells[p] = true
	return {"cells": cells, "filter": r["filter"]}

static func _selection_isolate(args: Dictionary) -> Dictionary:
	if args.has("enabled"):
		var on := bool(args["enabled"])
		if on and not VoxelWorld.has_selection:
			return McpRegistry.fail("no_selection", "there's no selection to isolate; make one first")
		VoxelWorld.set_isolate_selection(on)
	return {"isolated": VoxelWorld.isolate_selection}
