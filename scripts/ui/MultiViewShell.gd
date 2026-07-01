class_name MultiViewShell
extends Control

# Tiling shell that replaces the editor's single TabContainer. The document area
# is a tree of nested SplitContainers whose leaves are ViewPanes (tab-groups of
# views). Exactly one pane is focused; only the focused pane's current view is
# "active" and receives global input. View instances are reparented — never
# recreated — across any re-layout, so their state survives.

const View3DScene := preload("res://scenes/views/View3D.tscn")
const Slice2DScene := preload("res://scenes/views/View2DGrid.tscn")

enum Preset { SINGLE, COLUMNS, ROWS, GRID }

var focused_pane: ViewPane = null

var _focus_overlay: Control
var _last_overlay_rect := Rect2()
var _drop_layer: PaneDropLayer
var _last_guide: Dictionary = {}
var _last_active_id := 0
# Set during apply_layout: the pane flagged as focused in the saved descriptor, so the
# rebuild can restore focus to it once the whole tree is built.
var _focus_from_layout: ViewPane = null

func _ready() -> void:
	_focus_overlay = Control.new()
	_focus_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_focus_overlay.draw.connect(_draw_focus_overlay)

	_drop_layer = PaneDropLayer.new()
	_drop_layer.shell = self
	_drop_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_drop_layer.visible = false

	var pane := _make_pane()
	add_child(pane)
	add_child(_focus_overlay)  # border highlight (always passthrough)
	add_child(_drop_layer)     # topmost; only a drop target during a drag
	_drop_layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_normalize_children()

	var view := _make_3d_view()
	_attach_view(pane, view)
	_set_focus(pane)

	VoxelWorld.slice_view_requested.connect(_on_slice_requested)
	# Restore this project's saved layout when it opens; write the live layout back into
	# the project just before it's persisted. The shell owns the live view instances but
	# not their persisted form — the project is the canonical home for that (Principle 2).
	VoxelWorld.project_opened.connect(_on_project_opened)
	VoxelWorld.about_to_save.connect(_on_about_to_save)
	set_process(true)

	apply_preset(Preset.SINGLE)

# ---------------------------------------------------------------------------
# Project layout persistence
# ---------------------------------------------------------------------------

func _on_project_opened(project: VoxelProject) -> void:
	# Restore the saved arrangement, or fall back to a single pane for a project that
	# has never had a layout saved (a fresh build, or one made before layouts persisted).
	if not apply_layout(project.layout):
		apply_preset(Preset.SINGLE)

func _on_about_to_save(project: VoxelProject) -> void:
	project.layout = serialize_layout()

# Structure/tab/offset/camera changed → the project's saved layout is stale. Cheap
# debounce restart; VoxelWorld ignores it when no project is active (e.g. the initial
# GRID built in _ready before anything is open).
func _mark_layout_dirty() -> void:
	VoxelWorld.mark_dirty()

func _notification(what: int) -> void:
	# Fast cleanup on drag end. NOTIFICATION_DRAG_BEGIN is NOT used here because
	# it only fires on the drag source, not on unrelated controls — so arming is
	# done via gui_is_dragging() in _process instead.
	if what == NOTIFICATION_DRAG_END:
		_drop_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_drop_layer.visible = false
		_drop_layer.hover_rect = Rect2()
		_drop_layer.queue_redraw()

# ---------------------------------------------------------------------------
# Focus highlight (a border tracking the focused pane, drawn over everything)
# ---------------------------------------------------------------------------

func _process(_delta: float) -> void:
	if is_instance_valid(focused_pane) and focused_pane.is_inside_tree():
		var r := Rect2(focused_pane.global_position, focused_pane.size)
		_focus_overlay.visible = true
		if r != _last_overlay_rect:
			_last_overlay_rect = r
			_focus_overlay.global_position = r.position
			_focus_overlay.size = r.size
			_focus_overlay.queue_redraw()
	elif _focus_overlay.visible:
		_focus_overlay.visible = false

	# Arm the drop layer while any drag is active. MOUSE_FILTER_PASS lets it
	# participate in drop detection without blocking the TabBar below it — if
	# _can_drop_data returns false the event propagates to native handlers.
	if is_inside_tree():
		var dragging := get_viewport().gui_is_dragging()
		if dragging != _drop_layer.visible:
			_drop_layer.visible = dragging
			_drop_layer.mouse_filter = Control.MOUSE_FILTER_PASS if dragging else Control.MOUSE_FILTER_IGNORE
			if not dragging:
				_drop_layer.hover_rect = Rect2()
				_drop_layer.queue_redraw()

	if _drop_layer.visible:
		var p := _pane_at(get_global_mouse_position())
		var hr := Rect2()
		if p:
			hr = Rect2(p.global_position - _drop_layer.global_position, p.size)
		if hr != _drop_layer.hover_rect:
			_drop_layer.hover_rect = hr
			_drop_layer.queue_redraw()

	_broadcast_guide_if_changed()

func _draw_focus_overlay() -> void:
	_focus_overlay.draw_rect(Rect2(Vector2.ONE, _focus_overlay.size - Vector2(2, 2)),
		Color(0.3, 0.72, 1.0, 0.9), false, 2.0)

# ---------------------------------------------------------------------------
# Public commands (driven from the EditorBar, acting on the focused pane)
# ---------------------------------------------------------------------------

func split_focused(vertical: bool) -> void:
	if is_instance_valid(focused_pane):
		_split(focused_pane, vertical)

func close_focused_pane() -> void:
	if not is_instance_valid(focused_pane) or _all_panes().size() <= 1:
		return
	var pane := focused_pane
	for c in pane.get_children():
		pane.remove_child(c)
		c.queue_free()
	collapse_if_empty(pane)  # explicit so an already-empty pane collapses too
	_mark_layout_dirty()

func add_3d_view_to_focused() -> void:
	var pane := _first_empty_pane()
	if not pane:
		pane = focused_pane if is_instance_valid(focused_pane) else _first_pane()
	if pane:
		_attach_view(pane, _make_3d_view())
		_set_focus(pane)
		_mark_layout_dirty()

# Gate every view's input while a modal overlay (the inventory screen) is up.
# Driven by Main when the inventory opens/closes; the active 3D view remembers and
# restores its fly state so editing resumes seamlessly.
func set_views_suspended(suspended: bool) -> void:
	for v in _all_views():
		if v.has_method("set_input_suspended"):
			v.set_input_suspended(suspended)

func apply_preset(preset: Preset) -> void:
	var views := _all_views()
	for v in views:
		v.get_parent().remove_child(v)
	for c in get_children():
		if c != _focus_overlay and c != _drop_layer:
			remove_child(c)
			c.queue_free()
	var panes := _build_preset(preset)
	_normalize_children()
	for i in views.size():
		_attach_view(panes[i % panes.size()], views[i], false)
	for p in panes:
		if p.get_tab_count() > 0:
			p.current_tab = 0
	_set_focus(panes[0])
	_mark_layout_dirty()

# ---------------------------------------------------------------------------
# Layout (de)serialization — a plain-data descriptor of the split tree + panes +
# each view's persisted state. Consumed by _on_project_opened / _on_about_to_save so
# a project reopens with the exact arrangement (and framing) it was saved with.
# ---------------------------------------------------------------------------

# Snapshot the whole document area as a nested Dictionary/Array descriptor.
func serialize_layout() -> Dictionary:
	var root := _structural_root()
	if root == null:
		return {}
	return {"tree": _serialize_node(root)}

func _serialize_node(node: Control) -> Dictionary:
	if node is SplitContainer:
		var children: Array = []
		for c in node.get_children():
			if c is ViewPane or c is SplitContainer:
				children.append(_serialize_node(c))
		return {
			"type": "split",
			"vertical": node is VSplitContainer,
			"offset": (node as SplitContainer).split_offset,
			"children": children,
		}
	var pane := node as ViewPane
	var views: Array = []
	for i in pane.get_tab_count():
		views.append(_serialize_view(pane.get_tab_control(i)))
	return {
		"type": "pane",
		"current": pane.current_tab,
		"focused": pane == focused_pane,
		"views": views,
	}

# A view descriptor: its kind plus whatever state the view chooses to persist
# (camera/pan/zoom/slice), merged flat so apply_view_state can read it straight back.
func _serialize_view(view: Node) -> Dictionary:
	var desc := {"kind": view.view_kind() if view.has_method("view_kind") else "3d"}
	if view.has_method("get_view_state"):
		desc.merge(view.get_view_state())
	return desc

# Rebuild the document area from a descriptor. Returns false (and changes nothing) for
# an empty/absent descriptor so the caller can apply a default preset instead.
func apply_layout(layout: Dictionary) -> bool:
	var tree: Variant = layout.get("tree", null)
	if not (tree is Dictionary) or (tree as Dictionary).is_empty():
		return false
	_clear_structure()
	_focus_from_layout = null
	var root := _build_node(tree)
	add_child(root)
	_normalize_children()
	_set_focus(_focus_from_layout if is_instance_valid(_focus_from_layout) else _first_pane())
	return true

# Tear down the current split tree + all views (mirrors the top of apply_preset).
func _clear_structure() -> void:
	for v in _all_views():
		v.get_parent().remove_child(v)
		v.queue_free()
	for c in get_children():
		if c != _focus_overlay and c != _drop_layer:
			remove_child(c)
			c.queue_free()

# Recursively build a split or a pane (with its views) from a descriptor. Views are
# attached and their state applied here; the pane need not be in the shell tree yet
# (2D grids self-center from _user_pan on their first draw once shown).
func _build_node(desc: Dictionary) -> Control:
	if desc.get("type", "") == "split":
		var sc: SplitContainer
		if bool(desc.get("vertical", false)):
			sc = _v()
		else:
			sc = _h()
		for child in desc.get("children", []):
			if child is Dictionary:
				sc.add_child(_build_node(child))
		if desc.has("offset"):
			sc.split_offset = int(desc["offset"])
		return sc
	var pane := _make_pane()
	for vd in desc.get("views", []):
		if not (vd is Dictionary):
			continue
		var view := _make_view_from_desc(vd)
		_attach_view(pane, view, false)
		if view.has_method("apply_view_state"):
			view.apply_view_state(vd)
	if pane.get_tab_count() > 0:
		pane.current_tab = clampi(int(desc.get("current", 0)), 0, pane.get_tab_count() - 1)
	if bool(desc.get("focused", false)):
		_focus_from_layout = pane
	return pane

func _make_view_from_desc(desc: Dictionary) -> Control:
	if desc.get("kind", "3d") == "slice":
		return _make_slice_view(int(desc.get("axis", 1)), desc.get("center", Vector3i.ZERO))
	return _make_3d_view()

# The single structural child of the shell (the split-tree root or lone pane), i.e.
# everything that isn't the focus overlay or the drop layer.
func _structural_root() -> Control:
	for c in get_children():
		if c != _focus_overlay and c != _drop_layer:
			return c as Control
	return null

# ---------------------------------------------------------------------------
# Structural operations
# ---------------------------------------------------------------------------

func _split(pane: ViewPane, vertical: bool) -> void:
	var sc: SplitContainer
	if vertical:
		sc = _v()
	else:
		sc = _h()
	var new_pane := _make_pane()
	_replace_node(pane, sc)
	sc.add_child(pane)
	sc.add_child(new_pane)
	_normalize_children()
	_set_focus(new_pane)
	_mark_layout_dirty()

func collapse_if_empty(pane: ViewPane) -> void:
	call_deferred("_do_collapse", pane)

func _do_collapse(pane: ViewPane) -> void:
	if not is_instance_valid(pane) or pane.get_tab_count() > 0:
		return
	var parent := pane.get_parent()
	if not (parent is SplitContainer):
		return  # the root pane is allowed to stay empty — never zero panes
	var sibling: Control = null
	for c in parent.get_children():
		if c != pane:
			sibling = c
			break
	if sibling == null:
		return
	parent.remove_child(sibling)
	_replace_node(parent, sibling)  # sibling takes the split's place
	parent.queue_free()             # frees the split and the empty pane
	_normalize_children()
	if not is_instance_valid(focused_pane):
		_set_focus(_first_pane())
	_mark_layout_dirty()

# Swap `old` for `new` in old's parent, preserving the child slot.
func _replace_node(old: Control, new: Control) -> void:
	var parent := old.get_parent()
	var idx := old.get_index()
	parent.remove_child(old)
	parent.add_child(new)
	parent.move_child(new, idx)

func _build_preset(preset: Preset) -> Array:
	match preset:
		Preset.COLUMNS:
			var sc := _h(); var a := _make_pane(); var b := _make_pane()
			sc.add_child(a); sc.add_child(b); add_child(sc)
			return [a, b]
		Preset.ROWS:
			var sc := _v(); var a := _make_pane(); var b := _make_pane()
			sc.add_child(a); sc.add_child(b); add_child(sc)
			return [a, b]
		Preset.GRID:
			var outer := _v(); var top := _h(); var bot := _h()
			var a := _make_pane(); var b := _make_pane()
			var c := _make_pane(); var d := _make_pane()
			top.add_child(a); top.add_child(b)
			bot.add_child(c); bot.add_child(d)
			outer.add_child(top); outer.add_child(bot); add_child(outer)
			return [a, b, c, d]
		_:
			var p := _make_pane()
			add_child(p)
			return [p]

# Keep the structural root at child 0 and the overlay last; fit the root to us.
func _normalize_children() -> void:
	if is_instance_valid(_focus_overlay) and _focus_overlay.get_parent() == self:
		move_child(_focus_overlay, get_child_count() - 1)
	if is_instance_valid(_drop_layer) and _drop_layer.get_parent() == self:
		move_child(_drop_layer, get_child_count() - 1)
	for c in get_children():
		if c != _focus_overlay and c != _drop_layer:
			(c as Control).set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
			break

# ---------------------------------------------------------------------------
# Panes & views
# ---------------------------------------------------------------------------

func _make_pane() -> ViewPane:
	var p := ViewPane.new()
	p.pane_focus_requested.connect(_set_focus)
	p.pane_emptied.connect(collapse_if_empty)
	p.tab_changed.connect(_on_pane_tab_changed.bind(p))
	return p

func _on_pane_tab_changed(_tab: int, pane: ViewPane) -> void:
	if pane == focused_pane:
		_update_active_views()
	_mark_layout_dirty()

func _make_3d_view() -> Control:
	var v := View3DScene.instantiate()
	v.set_meta("tab_title", "3D")
	_connect_view(v)
	return v

func _make_slice_view(axis: int, center: Vector3i) -> Control:
	var v := Slice2DScene.instantiate()
	v.set_meta("tab_title", _slice_title(axis, center))
	_connect_view(v)
	return v

func _connect_view(v: Control) -> void:
	if v.has_signal("focus_requested"):
		v.focus_requested.connect(_on_view_focus_requested.bind(v))

func _on_view_focus_requested(view: Control) -> void:
	var pane := view.get_parent()
	if pane is ViewPane:
		_set_focus(pane)

func _attach_view(pane: ViewPane, view: Control, make_current: bool = true) -> void:
	view.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	view.size_flags_vertical = Control.SIZE_EXPAND_FILL
	pane.add_child(view)
	var idx := view.get_index()
	if view.has_meta("tab_title"):
		pane.set_tab_title(idx, view.get_meta("tab_title"))
	if make_current:
		pane.current_tab = idx

func _on_slice_requested(axis: int, center: Vector3i, flipped: bool = false) -> void:
	var pane := _first_empty_pane()
	if not pane:
		pane = focused_pane if is_instance_valid(focused_pane) else _first_pane()
	if not pane:
		return
	var view := _make_slice_view(axis, center)
	_attach_view(pane, view)
	view.configure(axis, center, flipped)  # now in-tree, so the 2D view centers itself
	_set_focus(pane)
	_mark_layout_dirty()

func _slice_title(axis: int, c: Vector3i) -> String:
	var label: String = (["X", "Y", "Z"] as Array)[axis]
	var hv: Vector2i
	match axis:
		0: hv = Vector2i(c.z, c.y)
		2: hv = Vector2i(c.x, c.y)
		_: hv = Vector2i(c.x, c.z)
	return "%s=%d (%d,%d)" % [label, c[axis], hv.x, hv.y]

# ---------------------------------------------------------------------------
# Focus & active state
# ---------------------------------------------------------------------------

func _set_focus(pane: ViewPane) -> void:
	if not is_instance_valid(pane):
		return
	focused_pane = pane
	_update_active_views()

# Only the focused pane's currently-visible view is active (receives global
# input). Everything else is inactive even while visible in another pane.
func _update_active_views() -> void:
	var active_view: Node = null
	if is_instance_valid(focused_pane):
		active_view = focused_pane.get_current_tab_control()
	for v in _all_views():
		if v.has_method("set_active"):
			v.set_active(v == active_view)

# The focused 2D view broadcasts its slice; every other view renders it as a
# guide (3D as a plane, other 2D as an intersection line). Polled so scrubbing
# the active slice updates the others live. Lives in the shell (UI chrome) —
# never on the data layer. Tracks the active view's identity too, so swapping
# focus between two same-valued slices still re-broadcasts.
func _broadcast_guide_if_changed() -> void:
	var active_view: Node = null
	if is_instance_valid(focused_pane):
		active_view = focused_pane.get_current_tab_control()
	var active_id := active_view.get_instance_id() if active_view else 0
	var guide: Dictionary = {}
	if active_view and active_view.has_method("get_guide_descriptor"):
		guide = active_view.get_guide_descriptor()
	if guide == _last_guide and active_id == _last_active_id:
		return
	_last_guide = guide
	_last_active_id = active_id
	for v in _all_views():
		if v.has_method("set_guide"):
			v.set_guide({} if v == active_view else guide)

# ---------------------------------------------------------------------------
# Tab drag-and-drop (a tab dropped anywhere on a pane joins that pane)
# ---------------------------------------------------------------------------

func is_tab_drag(data: Variant) -> bool:
	if not (data is Dictionary):
		return false
	var t: String = data.get("type", "")
	return t == "tab" or t == "tab_element" or t == "tabc_element"

func drop_tab(data: Variant, global_pos: Vector2) -> void:
	var pane := _pane_at(global_pos)
	if not pane:
		return
	var view := _view_from_drag(data)
	if not view or view.get_parent() == pane:
		return
	view.get_parent().remove_child(view)
	_attach_view(pane, view)
	_set_focus(pane)
	_mark_layout_dirty()

func _view_from_drag(data: Variant) -> Control:
	var path: NodePath = data.get("from_path", NodePath())
	var from_node := get_node_or_null(path)
	if from_node == null:
		return null
	# from_path may point to the TabBar (parent is ViewPane) or the ViewPane itself.
	var src: ViewPane
	if from_node is ViewPane:
		src = from_node as ViewPane
	elif from_node.get_parent() is ViewPane:
		src = from_node.get_parent() as ViewPane
	else:
		return null
	# Godot 4.6 uses "tab_index"; older API used "tab_element"/"tabc_element".
	var idx: int = data.get("tab_index", data.get("tab_element", data.get("tabc_element", -1)))
	if idx < 0 or idx >= src.get_tab_count():
		return null
	return src.get_tab_control(idx)

func _pane_at(global_pos: Vector2) -> ViewPane:
	for p in _all_panes():
		if p.is_inside_tree() and Rect2(p.global_position, p.size).has_point(global_pos):
			return p
	return null

# ---------------------------------------------------------------------------
# Tree traversal helpers
# ---------------------------------------------------------------------------

func _all_panes(node: Node = self) -> Array:
	var result: Array = []
	for c in node.get_children():
		if c is ViewPane:
			result.append(c)
		elif c is SplitContainer:
			result.append_array(_all_panes(c))
	return result

func _all_views() -> Array:
	var views: Array = []
	for p in _all_panes():
		for c in p.get_children():
			views.append(c)
	return views

func _first_pane() -> ViewPane:
	var panes := _all_panes()
	return panes[0] if not panes.is_empty() else null

func _first_empty_pane() -> ViewPane:
	for p in _all_panes():
		if p.get_tab_count() == 0:
			return p
	return null

func _h() -> HSplitContainer:
	var s := HSplitContainer.new()
	s.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	s.size_flags_vertical = Control.SIZE_EXPAND_FILL
	s.dragged.connect(func(_offset): _mark_layout_dirty())
	return s

func _v() -> VSplitContainer:
	var s := VSplitContainer.new()
	s.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	s.size_flags_vertical = Control.SIZE_EXPAND_FILL
	s.dragged.connect(func(_offset): _mark_layout_dirty())
	return s
