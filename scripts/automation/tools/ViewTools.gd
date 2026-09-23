extends RefCounted

# Views and renders: the user's own panes (list, aim) and offscreen captures that never
# touch them. Captures go through CaptureService, which owns a private 3D view.

static func register(reg: McpRegistry) -> void:
	reg.add("view_list",
		"The user's open views: id, kind (3d / slice), title, whether it's focused and on screen, and a 3D view's camera.",
		{}, func(_a: Dictionary) -> Dictionary: return {"views": view_list()})

# The editor's view shell (MultiViewShell), or null (headless / tests).
static func shell() -> Control:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return null
	return tree.get_first_node_in_group("view_shell") as Control

static func view_list() -> Array:
	var sh := shell()
	if sh == null:
		return []
	var focused: Control = sh.call("focused_view")
	var out: Array = []
	var i := 0
	for v: Control in sh.call("all_views"):
		var d := {"id": "v%d" % i, "kind": v.call("view_kind") if v.has_method("view_kind") else "?",
			"title": str(v.name), "focused": v == focused, "shown": sh.call("is_view_shown", v)}
		if v is View3D:
			var st: Dictionary = (v as View3D).get_view_state()
			d["camera"] = {"pos": st["camera_pos"], "yaw": st["yaw"], "pitch": st["pitch"]}
		out.append(d)
		i += 1
	return out
