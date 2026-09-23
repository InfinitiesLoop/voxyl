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
			"facing": {"type": "string", "description": "Default facing for oriented blocks (north/east/south/west/up/down)"},
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
		"Swap one semantic for another inside a region (whole blocks keep their facing; parts keep their shape and slot).",
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
		"Paste the clipboard with its min corner at `at`, optionally rotated (quarter turns clockwise seen from above) and/or mirrored. Keeps occupied cells unless overwrite:true.",
		_props({
			"at": McpArgs.s_vec3(),
			"rotate": {"type": "integer", "description": "0-3 quarter turns clockwise (from above)"},
			"mirror": {"type": "string", "enum": ["x", "z"]},
			"overwrite": {"type": "boolean"},
		}, ["at"]), _clipboard_paste, {"mutates": true})
	reg.add("selection_set",
		"Set the region selection every view shows (the Select tool's box).",
		{"properties": {"region": McpArgs.s_region()}, "required": ["region"]}, _selection_set, {"mutates": true})
	reg.add("selection_clear", "Clear the region selection.", {}, _selection_clear, {"mutates": true})

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
		var o: Variant = McpArgs.orientation(spec)
		if McpRegistry.is_error(o):
			return o
		edits.append({"pos": pos, "op": "block", "semantic": str(it.get("semantic", default_sem)), "orientation": o})
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
		edits.append_array(RegionOps.clear_edits(data, r["min"], r["max"], sem, parts_only))
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
			resolved[key] = {"op": "block", "semantic": v, "orientation": 0}
		elif v is Dictionary:
			var o: Variant = McpArgs.orientation(v)
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
		var o: Variant = McpArgs.orientation(args)
		if McpRegistry.is_error(o):
			return o
		template = {"op": "block", "semantic": sem, "orientation": o}
	return McpArgs.commit("region_fill", RegionOps.fill_edits(r["min"], r["max"], style, template), args)

static func _region_replace(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var r: Variant = McpArgs.region(args.get("region"), true)
	if McpRegistry.is_error(r):
		return r
	var edits := RegionOps.replace_edits((pv as VoxelProject).data, r["min"], r["max"], str(args["from"]), str(args["to"]))
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
	return McpArgs.commit("region_move", RegionOps.move_edits((pv as VoxelProject).data, r["min"], r["max"], by), args)

static func _region_copy(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var r: Variant = McpArgs.region(args.get("region"))
	if McpRegistry.is_error(r):
		return r
	var n := VoxelWorld.copy_region(r["min"], r["max"])
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
	var b := Basis(Vector3.UP, deg_to_rad(-90.0 * (int(args.get("rotate", 0)) % 4)))
	match str(args.get("mirror", "")):
		"x": b = Basis(Vector3(-1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, 1)) * b
		"z": b = Basis(Vector3(1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, -1)) * b
	var r := RegionOps.paste_edits(VoxelWorld.clipboard_cells(), VoxelWorld.clipboard_size(), at, b)
	var a := args.duplicate()
	if not bool(args.get("overwrite", false)):
		a["only_air"] = true
	return McpArgs.commit("clipboard_paste", r["edits"], a, r["rejected"])

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
