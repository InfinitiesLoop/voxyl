extends RefCounted

# Projects: list, create (optionally scratch — in memory only), open in the user's editor,
# inspect, save.

static func register(reg: McpRegistry) -> void:
	reg.add("project_list",
		"All projects: name, palette stack, size, last edit, whether it's open or scratch (unsaved).",
		{}, _project_list)
	reg.add("project_create",
		"Create a project. scratch:true keeps it in memory only (never written) until project_save {as}; use that for experiments. Opens it in the user's editor unless open:false.",
		{"properties": {
			"name": {"type": "string"},
			"palettes": {"type": "array", "items": {"type": "string"}, "description": "Palette stack, bottom to top (default [\"Default\"])"},
			"scratch": {"type": "boolean"},
			"open": {"type": "boolean", "description": "Open it in the editor (default true)"},
		}, "required": ["name"]}, _project_create, {"mutates": true})
	reg.add("project_open",
		"Open a project in the user's editor (they see it switch).",
		{"properties": {"name": {"type": "string"}}, "required": ["name"]}, _project_open, {"mutates": true})
	reg.add("project_info",
		"A project's bounds, counts by semantic, palette stack, semantics used but not in any of its palettes, and history depth. Defaults to the open project.",
		{"properties": {"name": {"type": "string"}}}, _project_info)
	reg.add("project_save",
		"Save the open project now, or save it under a new name with `as` (this is how a scratch project becomes a real one).",
		{"properties": {
			"as": {"type": "string"},
			"project": {"type": "string"},
		}}, _project_save, {"mutates": true})
	reg.add("project_delete",
		"Delete a project (not the one that's open). Requires confirm: true.",
		{"properties": {"name": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["name", "confirm"]},
		_project_delete, {"mutates": true})

static func _project_list(_args: Dictionary) -> Dictionary:
	var out: Array = []
	for p in VoxelWorld.workspace.projects:
		var aabb := p.data.get_used_aabb()
		var d := {"name": p.name, "palettes": Array(p.palette_names), "cells": p.data.cells.size(),
			"modified": Time.get_datetime_string_from_unix_time(p.modified_at) if p.modified_at > 0 else "",
			"open": p == VoxelWorld.active_project}
		if p.scratch:
			d["scratch"] = true
		if not aabb.is_empty():
			d["size"] = aabb[1] - aabb[0] + Vector3i.ONE
		out.append(d)
	return {"projects": out}

static func _project_create(args: Dictionary) -> Dictionary:
	var name := str(args.get("name", "")).strip_edges()
	if name.is_empty():
		return McpRegistry.fail("bad_argument", "name is required")
	if VoxelWorld.workspace.get_project(name) != null:
		return McpRegistry.fail("name_taken", "a project named '%s' already exists" % name)
	var palettes: Array = []
	for n in args.get("palettes", []):
		if VoxelWorld.workspace.get_palette(str(n)) == null:
			return McpRegistry.fail("not_found", "no palette named '%s'" % n)
		palettes.append(str(n))
	var p := VoxelWorld.create_project(name, palettes, bool(args.get("scratch", false)))
	if bool(args.get("open", true)):
		VoxelWorld.request_open_project(p)
	return {"name": p.name, "scratch": p.scratch, "palettes": Array(p.palette_names),
		"open": VoxelWorld.active_project == p}

static func _project_open(args: Dictionary) -> Dictionary:
	var p := VoxelWorld.workspace.get_project(str(args.get("name", "")))
	if p == null:
		return McpRegistry.fail("not_found", "no project named '%s'" % args.get("name", ""))
	if VoxelWorld.active_project != null and VoxelWorld.active_project != p:
		VoxelWorld.save_active_project()
	VoxelWorld.request_open_project(p)
	return _info(p)

static func _project_info(args: Dictionary) -> Dictionary:
	var p := VoxelWorld.active_project
	if args.has("name"):
		p = VoxelWorld.workspace.get_project(str(args["name"]))
	if p == null:
		return McpRegistry.fail("not_found", "no such project (and none is open)")
	return _info(p)

static func _info(p: VoxelProject) -> Dictionary:
	var aabb := p.data.get_used_aabb()
	var defined := {}
	for pn in p.palette_names:
		var pal := VoxelWorld.workspace.get_palette(pn)
		if pal != null:
			for s in pal.semantic_names():
				defined[s] = true
	var counts := p.semantic_counts()
	var missing: Array = []
	for s in counts:
		if not defined.has(s):
			missing.append(s)
	return {"name": p.name, "scratch": p.scratch, "open": p == VoxelWorld.active_project,
		"palettes": Array(p.palette_names), "cells": p.data.cells.size(),
		"bounds": _bounds(aabb),
		"counts": counts, "undefined_semantics": missing,
		"history_steps": (p.history.entries()["entries"] as Array).size() if p.history else 0}

static func _project_save(args: Dictionary) -> Dictionary:
	var pv: Variant = McpArgs.project(args)
	if McpRegistry.is_error(pv):
		return pv
	var p: VoxelProject = pv
	var err := VoxelWorld.save_project_as(p, str(args.get("as", "")))
	if not err.is_empty():
		return McpRegistry.fail(err, "couldn't save '%s' as '%s'" % [p.name, args.get("as", "")])
	return {"saved": p.name, "scratch": p.scratch}

static func _project_delete(args: Dictionary) -> Dictionary:
	var name := str(args.get("name", ""))
	var p := VoxelWorld.workspace.get_project(name)
	if p == null:
		return McpRegistry.fail("not_found", "no project named '%s'" % name)
	if not bool(args.get("confirm", false)):
		return McpRegistry.fail("needs_confirm", "deleting a project needs confirm: true")
	if p == VoxelWorld.active_project:
		return McpRegistry.fail("is_open", "'%s' is open in the editor; open another project first" % name)
	VoxelWorld.delete_project(p)
	return {"deleted": name}

static func _bounds(aabb: Array) -> Variant:
	if aabb.is_empty():
		return null
	return {"min": aabb[0], "max": aabb[1]}
