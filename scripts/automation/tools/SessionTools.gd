extends RefCounted

# Session: what's open and what happened.

const ViewTools := preload("res://scripts/automation/tools/ViewTools.gd")

static func register(reg: McpRegistry) -> void:
	reg.add("status",
		"What Voxyl is showing right now: the open project (name, scratch?, size, palette stack), the user's views, the region selection, the hotbar, undo/redo depth and whether the user paused agent edits. Call this first.",
		{}, _status)
	reg.add("logs",
		"Recent Voxyl log lines (errors and warnings by default), plus this server's recent tool calls. Use when something looks wrong.",
		{"properties": {
			"level": {"type": "string", "enum": ["error", "warning", "all"], "description": "Default: warning (errors + warnings)"},
			"lines": {"type": "integer", "description": "How many lines (default 40)"},
		}}, _logs)
	reg.add("history",
		"The open project's undo history (the user's steps and yours, side by side), or undo/redo steps. Undo/redo act exactly like Ctrl+Z / Ctrl+Y.",
		{"properties": {
			"action": {"type": "string", "enum": ["list", "undo", "redo"], "description": "Default: list"},
			"count": {"type": "integer", "description": "Steps to undo/redo (default 1)"},
			"project": {"type": "string"},
		}}, _history, {"mutates": true})
	reg.add("hotbar_set",
		"Put semantics on the user's hotbar (the 12 slots at the bottom of the editor) so they can build with them straight away.",
		{"properties": {
			"slots": {"description": "Array of semantic names for slots 0.. (null/\"\" leaves a slot as is), or an object {\"0\": \"Mass\", ...}"},
			"active": {"type": "integer", "description": "Slot to select"},
		}, "required": ["slots"]}, _hotbar_set, {"mutates": true})

static func _status(_args: Dictionary) -> Dictionary:
	var p := VoxelWorld.active_project
	var out := {
		"app": "voxyl",
		"screen": _screen(),
		"paused": McpServer.paused,
	}
	if p == null:
		out["project"] = null
	else:
		var aabb := p.data.get_used_aabb()
		out["project"] = {
			"name": p.name,
			"scratch": p.scratch,
			"palettes": Array(p.palette_names),
			"cells": p.data.cells.size(),
			"bounds": _bounds(aabb),
		}
		out["hotbar"] = {"slots": Array(VoxelWorld.hotbar), "active": VoxelWorld.active_slot}
		out["selection"] = null
		if VoxelWorld.has_selection:
			out["selection"] = {"min": VoxelWorld.selection_min, "max": VoxelWorld.selection_max}
		var h := VoxelWorld.history_entries()
		out["history"] = {"steps": (h["entries"] as Array).size(), "current": h["current"],
			"can_undo": VoxelWorld.can_undo(), "can_redo": VoxelWorld.can_redo()}
	out["views"] = ViewTools.view_list()
	return out

static func _screen() -> String:
	var shell := ViewTools.shell()
	if shell == null:
		return "headless"
	return "editor" if shell.is_visible_in_tree() else "home"

static func _logs(args: Dictionary) -> Dictionary:
	var level := str(args.get("level", "warning"))
	var n := clampi(int(args.get("lines", 40)), 1, 500)
	var path := str(ProjectSettings.get_setting("debug/file_logging/log_path", "user://logs/godot.log"))
	var lines: Array = []
	var f := FileAccess.open(path, FileAccess.READ)
	if f != null:
		var all := f.get_as_text().split("\n")
		for i in range(all.size() - 1, -1, -1):
			var line := all[i]
			if line.strip_edges().is_empty():
				continue
			var keep := level == "all"
			if level == "warning":
				keep = line.contains("ERROR") or line.contains("WARNING") or line.begins_with("   at:")
			elif level == "error":
				keep = line.contains("ERROR") or line.contains("SCRIPT ERROR")
			if keep:
				lines.push_front(line)
				if lines.size() >= n:
					break
	return {"log_file": ProjectSettings.globalize_path(path), "lines": lines, "recent_calls": McpServer.recent_calls()}

static func _history(args: Dictionary) -> Dictionary:
	var p: Variant = McpArgs.project(args)
	if McpRegistry.is_error(p):
		return p
	var action := str(args.get("action", "list"))
	var count := maxi(1, int(args.get("count", 1)))
	var done := 0
	if action == "undo":
		for i in count:
			if VoxelWorld.undo():
				done += 1
	elif action == "redo":
		for i in count:
			if VoxelWorld.redo():
				done += 1
	var h := VoxelWorld.history_entries()
	var entries: Array = h["entries"]
	var out := {"current": h["current"], "count": entries.size(),
		"recent": entries.slice(maxi(0, entries.size() - 20)),
		"can_undo": VoxelWorld.can_undo(), "can_redo": VoxelWorld.can_redo()}
	if action != "list":
		out[action + "_done"] = done
	return out

static func _hotbar_set(args: Dictionary) -> Dictionary:
	if VoxelWorld.active_project == null:
		return McpRegistry.fail("no_project", "no project is open")
	var slots: Variant = args.get("slots")
	var pairs := {}
	if slots is Array:
		for i in (slots as Array).size():
			if slots[i] != null and not str(slots[i]).is_empty():
				pairs[i] = str(slots[i])
	elif slots is Dictionary:
		for k in slots:
			pairs[int(k)] = str(slots[k])
	for i: int in pairs:
		VoxelWorld.set_hotbar_slot(i, pairs[i])
	if args.has("active"):
		VoxelWorld.select_slot(int(args["active"]))
	return {"slots": Array(VoxelWorld.hotbar), "active": VoxelWorld.active_slot,
		"warnings": McpArgs.unknown_semantics(pairs.values().map(func(s: String) -> Dictionary: return {"op": "block", "semantic": s}))}

static func _bounds(aabb: Array) -> Variant:
	if aabb.is_empty():
		return null
	return {"min": aabb[0], "max": aabb[1]}
