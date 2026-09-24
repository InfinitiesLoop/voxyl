class_name SavePrefabDialog
extends ConfirmationDialog

# "Save selection as prefab…" (Ctrl+P, or the Select tool's overlay): name the selected
# region, pick its handle, tag it, and untick any semantics to leave out (the floor under a
# pillar, say). The prefab's preferred palettes default to this project's palettes that
# define what it keeps, so it previews exactly as it looks here. Saving over an existing
# name asks first (the button turns into Replace).

var _name_edit: LineEdit
var _anchor_pick: OptionButton
var _tags_edit: LineEdit
var _trim_check: CheckBox
var _info: Label
var _warn: Label
var _checks := {}          # semantic -> CheckBox
var _trim_touched := false # the user set trim themselves: stop auto-setting it
var _mn: Vector3i
var _mx: Vector3i

# Open for the current selection. Without a project or a selection it says what's needed.
static func open(host: Node) -> void:
	if VoxelWorld.active_project == null or not VoxelWorld.has_selection:
		var info := AcceptDialog.new()
		info.title = "Save as prefab"
		info.dialog_text = "Select a region first: the Select tool, then right-click two corners."
		info.confirmed.connect(info.queue_free)
		info.canceled.connect(info.queue_free)
		host.get_tree().root.add_child(info)
		info.popup_centered()
		return
	var d := SavePrefabDialog.new()
	host.get_tree().root.add_child(d)
	d._start()

func _start() -> void:
	_mn = VoxelWorld.selection_min
	_mx = VoxelWorld.selection_max
	title = "Save selection as prefab"
	ok_button_text = "Save"
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	box.custom_minimum_size = Vector2(400, 0)
	add_child(box)

	_info = Label.new()
	_info.modulate = Color(1, 1, 1, 0.7)
	box.add_child(_info)

	box.add_child(_caption("Name"))
	_name_edit = LineEdit.new()
	_name_edit.text = _unique_name("Prefab")
	_name_edit.select_all_on_focus = true
	_name_edit.text_changed.connect(func(_t: String): _check())
	_name_edit.text_submitted.connect(func(_t: String):
		if not get_ok_button().disabled:
			_save())
	box.add_child(_name_edit)

	box.add_child(_caption("Handle (the cell that lands on your aim when placing, and turns pivot about)"))
	_anchor_pick = OptionButton.new()
	_anchor_pick.add_item("Bottom corner (min x, y, z)", 0)
	_anchor_pick.add_item("Bottom center", 1)
	box.add_child(_anchor_pick)

	box.add_child(_caption("Tags (comma separated, for search)"))
	_tags_edit = LineEdit.new()
	_tags_edit.placeholder_text = "pillar, factory"
	box.add_child(_tags_edit)

	# What goes in: every semantic in the box with its count; untick to leave it out.
	var head := HBoxContainer.new()
	var inc := _caption("Include (untick to leave out)")
	inc.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(inc)
	for pair in [["All", true], ["None", false]]:
		var b := Button.new()
		b.text = pair[0]
		b.flat = true
		b.focus_mode = Control.FOCUS_NONE
		b.pressed.connect(func():
			for c: CheckBox in _checks.values():
				c.set_pressed_no_signal(pair[1])
			_on_include_changed())
		head.add_child(b)
	box.add_child(head)
	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	var list := VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(list)
	box.add_child(scroll)
	var counts := RegionOps.semantic_counts(VoxelWorld.active_project.data, _mn, _mx)
	var names := counts.keys()
	names.sort_custom(func(a, b): return counts[a] > counts[b] if counts[a] != counts[b] else str(a) < str(b))
	for sem in names:
		var row := HBoxContainer.new()
		var swatch := ColorRect.new()
		swatch.color = VoxelWorld.get_color_for_semantic(str(sem))
		swatch.custom_minimum_size = Vector2(14, 14)
		swatch.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(swatch)
		var cb := CheckBox.new()
		cb.text = str(sem)
		cb.button_pressed = true
		cb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		cb.toggled.connect(func(_on: bool): _on_include_changed())
		row.add_child(cb)
		var n := Label.new()
		n.text = "×%d" % counts[sem]
		n.modulate = Color(1, 1, 1, 0.7)
		row.add_child(n)
		list.add_child(row)
		_checks[str(sem)] = cb
	scroll.custom_minimum_size = Vector2(0, mini(names.size(), 8) * 30 + 4)

	_trim_check = CheckBox.new()
	_trim_check.text = "Shrink the box to what's kept"
	_trim_check.tooltip_text = "Drop empty rows left around the kept cells (turned on when you leave something out, so a pillar without its floor doesn't float a block up)"
	_trim_check.toggled.connect(func(_on: bool):
		_trim_touched = true
		_check())
	box.add_child(_trim_check)

	_warn = Label.new()
	_warn.add_theme_color_override("font_color", Color(1.0, 0.75, 0.35))
	_warn.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_warn)

	_check()
	confirmed.connect(_save)
	canceled.connect(_close)
	_set_views_suspended(true)
	popup_centered()
	_name_edit.grab_focus()

func _caption(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 12)
	l.modulate = Color(1, 1, 1, 0.65)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return l

func _unique_name(base: String) -> String:
	var n := 1
	while VoxelWorld.workspace.get_prefab("%s %d" % [base, n]) != null:
		n += 1
	return "%s %d" % [base, n]

func _excluded() -> Array:
	var out: Array = []
	for sem in _checks:
		if not (_checks[sem] as CheckBox).button_pressed:
			out.append(sem)
	return out

# Leaving something out turns trimming on (until the user sets it themselves).
func _on_include_changed() -> void:
	if not _trim_touched:
		_trim_check.set_pressed_no_signal(not _excluded().is_empty())
	_check()

# Refresh the size / count read-out and the Save button for the current choices.
func _check() -> void:
	var cells := RegionOps.cells_without(VoxelWorld.active_project.data, _mn, _mx, _excluded())
	var lo := _mn
	var hi := _mx
	if _trim_check.button_pressed and not cells.is_empty():
		lo = Vector3i(1 << 30, 1 << 30, 1 << 30)
		hi = -lo
		for p: Vector3i in cells:
			lo = Vector3i(mini(lo.x, p.x), mini(lo.y, p.y), mini(lo.z, p.z))
			hi = Vector3i(maxi(hi.x, p.x), maxi(hi.y, p.y), maxi(hi.z, p.z))
	var dims := hi - lo + Vector3i.ONE
	_info.text = "%d × %d × %d  ·  %d cells" % [dims.x, dims.y, dims.z, cells.size()]
	var n := _name_edit.text.strip_edges()
	var taken := VoxelWorld.workspace.get_prefab(n) != null
	get_ok_button().disabled = n.is_empty() or cells.is_empty()
	get_ok_button().text = "Replace" if taken else "Save"
	if cells.is_empty():
		_warn.text = "Nothing is left to save."
	elif taken:
		_warn.text = "A prefab named \"%s\" exists — saving replaces it." % n
	else:
		_warn.text = ""

func _save() -> void:
	var n := _name_edit.text.strip_edges()
	if n.is_empty():
		return
	var anchor: Variant = null
	if _anchor_pick.get_selected_id() == 1:
		anchor = "bottom-center"
	var res: Variant = VoxelWorld.save_prefab_from_region(n, _mn, _mx, [], anchor, true,
		_excluded(), _trim_check.button_pressed)
	if res is Prefab:
		var tags := _tags_edit.text.split(",", false)
		if not tags.is_empty():
			VoxelWorld.update_prefab(res, {"tags": Array(tags)})
		PrefabThumbs.request_bake(res)
	_close()

func _close() -> void:
	_set_views_suspended(false)
	queue_free()

# Typing a name must not drive the 3D view (H toggles the cutaway, B the sky, …).
func _set_views_suspended(on: bool) -> void:
	var shell := get_tree().get_first_node_in_group("view_shell") if is_inside_tree() else null
	if shell != null and shell.has_method("set_views_suspended"):
		shell.call("set_views_suspended", on)
