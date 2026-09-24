extends RefCounted

# Prefabs: named, reusable pieces of builds, global to the workspace (see Prefab). Save a
# region once, place it anywhere as often as needed — turned, mirrored, repeated — through
# the same edit path as a paste. The user's Prefabs browser shows the same set live.

const _ViewTools := preload("res://scripts/automation/tools/ViewTools.gd")

static func register(reg: McpRegistry) -> void:
	reg.add("prefab_save",
		"Save a region of the open project as a named prefab (cells keyed to the region's min corner; empty cells stay empty). palettes = its preferred stack for previews and for filling gaps when placed elsewhere (default: the project's palettes that define its semantics). exclude = semantics to leave out (whole blocks dropped, their parts removed from part cells), e.g. the floor under a pillar. trim:true shrinks the box to the cells kept (otherwise the region is the box, empty margins included — use them to keep a module on a grid). anchor = the handle cell that lands on `at` when placing and that turns pivot about: [x,y,z] relative to the saved box's min corner (after trim), \"min\" (default) or \"bottom-center\". replace:true overwrites a prefab of the same name.",
		{"properties": {
			"name": {"type": "string"},
			"region": McpArgs.s_region(),
			"palettes": {"type": "array", "items": {"type": "string"}},
			"anchor": {"description": "[x,y,z] relative to the min corner, \"min\" or \"bottom-center\""},
			"tags": {"type": "array", "items": {"type": "string"}},
			"notes": {"type": "string"},
			"replace": {"type": "boolean"},
			"exclude": {"type": "array", "items": {"type": "string"}, "description": "Semantics to leave out"},
			"trim": {"type": "boolean", "description": "Shrink the box to the kept cells"},
			"project": {"type": "string"},
		}, "required": ["name", "region"]}, _prefab_save, {"mutates": true})
	reg.add("prefab_list",
		"All prefabs: size, cell count, anchor, preferred palettes, tags. `query` filters by name / tags / notes words.",
		{"properties": {"query": {"type": "string"}}}, _prefab_list)
	reg.add("prefab_get",
		"One prefab in detail: size, anchor, semantics with counts, preferred palettes, tags, notes — and, with a project open, which of its semantics that project doesn't map and which of its palettes would.",
		{"properties": {"name": {"type": "string"}}, "required": ["name"]}, _prefab_get)
	reg.add("prefab_render",
		"An image of a prefab through its preferred palettes, no project needed: a sheet of four views (three-quarter, back, front elevation, top). Also refreshes its thumbnail in the user's browser. render = RenderSpec (mode textured|intent|clay|outline|xray|wire, lighting, background).",
		{"properties": {
			"name": {"type": "string"},
			"render": {"type": "object"},
			"format": {"type": "string", "enum": ["png", "jpeg"]},
		}, "required": ["name"]}, _ViewTools._one_at_a_time(_prefab_render))
	var place_props := McpArgs.edit_props()
	place_props.merge({
		"name": {"type": "string"},
		"at": McpArgs.s_vec3("Where the prefab's anchor cell lands"),
		"rotate": {"type": "integer", "description": "0-3 quarter turns clockwise (from above), about the anchor"},
		"mirror": {"type": "string", "enum": ["x", "z"]},
		"overwrite": {"type": "boolean", "description": "Replace occupied cells (default: keep them)"},
		"add_palettes": {"type": "boolean", "description": "Add the prefab's preferred palettes that map semantics this project lacks to the bottom of its stack (default false)"},
		"remap": {"type": "object", "description": "{prefab semantic: project semantic} renames on the way in"},
	})
	reg.add("prefab_place",
		"Place a prefab into the open project with its anchor at `at`, optionally turned / mirrored, and with symmetry / repeat like any edit tool (stamp a row of pillars in one call). One undo step. The result lists missing_semantics (used by the prefab, unknown to the project's palettes — they render undecided) and palettes_available (its preferred palettes that define them); retry with add_palettes:true to add those to the bottom of the stack, or remap them.",
		{"properties": place_props, "required": ["name", "at"]}, _prefab_place, {"mutates": true})
	reg.add("prefab_update",
		"Change a prefab's name (rename), preferred palettes, anchor, tags or notes. Its cells change by editing it (prefab_open) or saving over it (prefab_save replace:true).",
		{"properties": {
			"name": {"type": "string"},
			"rename": {"type": "string"},
			"palettes": {"type": "array", "items": {"type": "string"}},
			"anchor": {"description": "[x,y,z] relative to the min corner, \"min\" or \"bottom-center\""},
			"tags": {"type": "array", "items": {"type": "string"}},
			"notes": {"type": "string"},
		}, "required": ["name"]}, _prefab_update, {"mutates": true})
	reg.add("prefab_open",
		"Open a prefab in the user's editor as if it were a project, so every edit tool, capture and undo works on it (status shows the project as editing_prefab). Its box starts selected. Saves (project_save, or leaving the editor) write the cells and palette stack back into the prefab; building past its box grows the box.",
		{"properties": {"name": {"type": "string"}}, "required": ["name"]}, _prefab_open, {"mutates": true})
	reg.add("prefab_delete",
		"Delete a prefab (placed copies stay: they're plain cells). Requires confirm: true.",
		{"properties": {"name": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["name", "confirm"]},
		_prefab_delete, {"mutates": true})

static func _prefab(name: String) -> Variant:
	var p := VoxelWorld.workspace.get_prefab(name)
	if p == null:
		return McpRegistry.fail("not_found", "no prefab named '%s' (see prefab_list)" % name)
	return p

# An anchor spec → Vector3i relative to the min corner (size = the box it's in), or a failure.
static func _anchor(spec: Variant, size: Vector3i) -> Variant:
	if spec == null or str(spec) == "min":
		return Vector3i.ZERO
	if str(spec) == "bottom-center":
		return Vector3i(floori((size.x - 1) / 2.0), 0, floori((size.z - 1) / 2.0))
	var v: Variant = McpArgs.vec3i(spec)
	if v == null:
		return McpRegistry.fail("bad_argument", "anchor must be [x,y,z] (relative to the min corner), \"min\" or \"bottom-center\"")
	return v

static func describe(p: Prefab, full := false) -> Dictionary:
	var d := {"name": p.name, "size": p.size, "cells": p.cell_count(), "anchor": p.anchor,
		"palettes": Array(p.palette_names)}
	if not p.tags.is_empty():
		d["tags"] = Array(p.tags)
	if full:
		d["semantics"] = p.semantic_counts()
		if not p.notes.is_empty():
			d["notes"] = p.notes
		var missing_pal: Array = []
		for pn in p.palette_names:
			if VoxelWorld.workspace.get_palette(pn) == null:
				missing_pal.append(pn)
		if not missing_pal.is_empty():
			d["warnings"] = ["preferred palettes that don't exist (anymore): " + ", ".join(missing_pal)]
		if VoxelWorld.active_project != null:
			var m := VoxelWorld.prefab_missing(p, VoxelWorld.active_project)
			d["missing_semantics"] = m["missing"]
			d["palettes_available"] = m["palettes"]
	return d

static func _prefab_save(args: Dictionary) -> Variant:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var r: Variant = McpArgs.region(args.get("region"))
	if McpRegistry.is_error(r):
		return r
	# bottom-center is worked out after the exclude / trim, on the box actually saved.
	var anchor: Variant = "bottom-center"
	if str(args.get("anchor", "")) != "bottom-center":
		anchor = _anchor(args.get("anchor"), Vector3i.ONE)
		if McpRegistry.is_error(anchor):
			return anchor
	var palettes: Array = []
	for n in args.get("palettes", []):
		if VoxelWorld.workspace.get_palette(str(n)) == null:
			return McpRegistry.fail("not_found", "no palette named '%s'" % n)
		palettes.append(str(n))
	var exclude: Array = (args.get("exclude", []) as Array).map(func(x: Variant) -> String: return str(x)) \
		if args.get("exclude") is Array else []
	var res: Variant = VoxelWorld.save_prefab_from_region(str(args.get("name", "")), r["min"], r["max"], palettes,
		anchor, bool(args.get("replace", false)), exclude, bool(args.get("trim", false)))
	if res is String:
		match res:
			"name_taken": return McpRegistry.fail("name_taken", "a prefab named '%s' exists; pass replace:true to overwrite it" % args.get("name"))
			"empty_region": return McpRegistry.fail("empty_region", "no cells are left in that region" if not exclude.is_empty() else "that region has no cells")
			"empty_name": return McpRegistry.fail("bad_argument", "name is required")
		return McpRegistry.fail(str(res), "couldn't save the prefab")
	var p: Prefab = res
	if args.has("tags") or args.has("notes"):
		var ch := {}
		if args.get("tags") is Array:
			ch["tags"] = args["tags"]
		if args.has("notes"):
			ch["notes"] = str(args["notes"])
		VoxelWorld.update_prefab(p, ch)
	var out := describe(p, true)
	out["saved_from"] = {"min": r["min"], "max": r["max"]}
	out.erase("missing_semantics")
	out.erase("palettes_available")
	var cs: CaptureService = McpServer.capture_service()
	if cs.is_rendering_available():
		out["thumbnail"] = await cs.bake_prefab_thumbnail(p)
	return out

static func _prefab_list(args: Dictionary) -> Dictionary:
	var terms := str(args.get("query", "")).strip_edges().split(" ", false)
	var out: Array = []
	var list := VoxelWorld.workspace.prefabs.duplicate()
	list.sort_custom(func(a: Prefab, b: Prefab) -> bool: return a.name.naturalnocasecmp_to(b.name) < 0)
	for p: Prefab in list:
		if terms.is_empty() or p.matches(terms):
			out.append(describe(p))
	return {"prefabs": out}

static func _prefab_get(args: Dictionary) -> Dictionary:
	var pv: Variant = _prefab(str(args.get("name", "")))
	if McpRegistry.is_error(pv):
		return pv
	return describe(pv, true)

static func _prefab_render(args: Dictionary) -> Variant:
	var cs: CaptureService = McpServer.capture_service()
	if not cs.is_rendering_available():
		return McpRegistry.fail("no_renderer", "this Voxyl runs without a display, so it can't render")
	var pv: Variant = _prefab(str(args.get("name", "")))
	if McpRegistry.is_error(pv):
		return pv
	var p: Prefab = pv
	var base: Dictionary = args.get("render", {}) if args.get("render") is Dictionary else {}
	var why := ViewOptions.check(base)
	if not why.is_empty():
		return McpRegistry.fail("bad_render", why)
	var tile := Vector2i(520, 380)
	var shots := [
		{"label": "Three-quarter (SE)", "from": "se", "elevation": 30},
		{"label": "Back (NW)", "from": "nw", "elevation": 30},
		{"label": "Front (south) elevation", "from": "s", "elevation": 0, "ortho": true},
		{"label": "Top", "from": "s", "elevation": "top", "ortho": true},
	]
	var tiles: Array = []
	for s: Dictionary in shots:
		var render := CaptureService.THUMB_RENDER.duplicate()
		render.merge(base, true)
		var pose := CaptureService.prefab_pose(p, s["from"], s["elevation"], tile, bool(s.get("ortho", false)))
		var img: Image = await cs.render_prefab(p, pose, render, tile)
		if img == null:
			return McpRegistry.fail("not_drawing", "Voxyl's window isn't drawing (minimized?); ask the user to restore it, then retry")
		var t := {"image": img, "caption": "%s · %s" % [s["label"], str(render.get("mode", "textured"))],
			"gizmo": {"right": cs.camera_basis()["right"], "up": cs.camera_basis()["up"]}}
		if str(render.get("mode", "")) == "intent":
			t["legend"] = _legend(p)
		tiles.append(t)
	var s := p.size
	var sheet: Image = await cs.compose(tiles, 2, tile, "Prefab: %s — %d×%d×%d, %d cells, palettes %s" % [
		p.name, s.x, s.y, s.z, p.cell_count(), ", ".join(p.palette_names) if not p.palette_names.is_empty() else "(none)"])
	if sheet == null:
		return McpRegistry.fail("not_drawing", "Voxyl's window isn't drawing (minimized?); ask the user to restore it, then retry")
	var thumb: Image = await cs.prefab_thumbnail(p)
	if thumb != null:
		PrefabStore.save_thumbnail(p.name, thumb)
		VoxelWorld.prefabs_changed.emit()
	var path := cs.save(sheet, "prefab-%s-%d" % [p.name, Time.get_ticks_msec()])
	return {"saved": path, "prefab": describe(p),
		McpRegistry.IMAGES_KEY: [McpRegistry.image(sheet, str(args.get("format", "png")))]}

# Intent colors as the prefab's own palettes see them (the same context its view renders in).
static func _legend(p: Prefab) -> Array:
	VoxelWorld.begin_resolve_as(CaptureService.prefab_stage(p))
	var out: Array = []
	for s in p.used_semantics():
		out.append([s, View3D.intent_color(s)])
	VoxelWorld.end_resolve_as()
	return out

static func _prefab_place(args: Dictionary) -> Variant:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var project: VoxelProject = pv
	var fv: Variant = _prefab(str(args.get("name", "")))
	if McpRegistry.is_error(fv):
		return fv
	var p: Prefab = fv
	var at: Variant = McpArgs.vec3i_or_fail(args.get("at"), "at")
	if McpRegistry.is_error(at):
		return at
	var renames := {}
	if args.get("remap") is Dictionary:
		for k in args["remap"]:
			renames[str(k)] = str(args["remap"][k])
	var basis := RegionOps.turn_basis(int(args.get("rotate", 0)), str(args.get("mirror", "")))
	var placed := RegionOps.place_edits(p.data.cells, p.anchor, at, basis, renames)
	# What the project lacks, judged after the renames (a remapped semantic is the project's own).
	var check := p
	if not renames.is_empty():
		check = Prefab.new()
		check.palette_names = p.palette_names
		for rel: Vector3i in p.data.cells:
			check.data.set_cell(rel, RegionOps.remap_cell(p.data.cells[rel], renames))
	var m := VoxelWorld.prefab_missing(check, project)
	var added: Array = []
	if bool(args.get("add_palettes", false)) and not bool(args.get("dry_run", false)) and not (m["palettes"] as Array).is_empty():
		added = (m["palettes"] as Array).duplicate()
		VoxelWorld.add_prefab_palettes(project, added)
		m = VoxelWorld.prefab_missing(check, project)
	var a := args.duplicate()
	if not bool(args.get("overwrite", false)):
		a["only_air"] = true
	var out: Dictionary = McpArgs.commit("prefab_place", placed["edits"], a, placed["rejected"])
	if McpRegistry.is_error(out):
		return out
	if not added.is_empty():
		out["palettes_added"] = added
	if not (m["missing"] as Array).is_empty():
		out["missing_semantics"] = m["missing"]
		out["palettes_available"] = m["palettes"]
		out.erase("warnings")   # missing_semantics says the same thing, with the fix
	return out

static func _prefab_update(args: Dictionary) -> Dictionary:
	var pv: Variant = _prefab(str(args.get("name", "")))
	if McpRegistry.is_error(pv):
		return pv
	var p: Prefab = pv
	var ch := {}
	if args.has("rename"):
		ch["name"] = str(args["rename"])
	if args.get("palettes") is Array:
		for n in args["palettes"]:
			if VoxelWorld.workspace.get_palette(str(n)) == null:
				return McpRegistry.fail("not_found", "no palette named '%s'" % n)
		ch["palettes"] = args["palettes"]
	if args.has("anchor"):
		var a: Variant = _anchor(args["anchor"], p.size)
		if McpRegistry.is_error(a):
			return a
		ch["anchor"] = a
	if args.get("tags") is Array:
		ch["tags"] = args["tags"]
	if args.has("notes"):
		ch["notes"] = str(args["notes"])
	var err := VoxelWorld.update_prefab(p, ch)
	match err:
		"name_taken": return McpRegistry.fail("name_taken", "a prefab named '%s' already exists" % ch["name"])
		"empty_name": return McpRegistry.fail("bad_argument", "rename can't be empty")
	return describe(p, true)

static func _prefab_delete(args: Dictionary) -> Dictionary:
	var pv: Variant = _prefab(str(args.get("name", "")))
	if McpRegistry.is_error(pv):
		return pv
	if not bool(args.get("confirm", false)):
		return McpRegistry.fail("needs_confirm", "deleting a prefab needs confirm: true")
	VoxelWorld.delete_prefab(pv)
	return {"deleted": (pv as Prefab).name}

static func _prefab_open(args: Dictionary) -> Dictionary:
	var pv: Variant = _prefab(str(args.get("name", "")))
	if McpRegistry.is_error(pv):
		return pv
	var p: Prefab = pv
	if VoxelWorld.active_project != null and VoxelWorld.active_project.editing_prefab == p:
		return {"project": p.name, "editing_prefab": true, "already_open": true}
	VoxelWorld.save_active_project()
	VoxelWorld.request_open_project(VoxelWorld.open_prefab_for_editing(p))
	return {"project": p.name, "editing_prefab": true, "box": {"min": Vector3i.ZERO, "max": p.size - Vector3i.ONE},
		"anchor": p.anchor, "palettes": Array(p.palette_names)}
