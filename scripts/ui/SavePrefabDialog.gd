class_name SavePrefabDialog
extends ConfirmationDialog

# "Save selection as prefab…" (Ctrl+P, or the Select tool's overlay): name the selected
# region, pick its handle, tag it. The prefab's preferred palettes default to this project's
# palettes that define what it uses, so it previews exactly as it looks here. Saving over an
# existing name asks first (the button turns into Replace).

var _name_edit: LineEdit
var _anchor_pick: OptionButton
var _tags_edit: LineEdit
var _warn: Label
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
	box.custom_minimum_size = Vector2(380, 0)
	add_child(box)

	var dims := _mx - _mn + Vector3i.ONE
	var cells := RegionOps.cells_in(VoxelWorld.active_project.data, _mn, _mx).size()
	var info := Label.new()
	info.text = "%d × %d × %d  ·  %d cells" % [dims.x, dims.y, dims.z, cells]
	info.modulate = Color(1, 1, 1, 0.7)
	box.add_child(info)

	box.add_child(_caption("Name"))
	_name_edit = LineEdit.new()
	_name_edit.text = _unique_name("Prefab")
	_name_edit.select_all_on_focus = true
	_name_edit.text_changed.connect(func(_t: String): _check_name())
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

	_warn = Label.new()
	_warn.add_theme_color_override("font_color", Color(1.0, 0.75, 0.35))
	_warn.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_warn)

	if cells == 0:
		_warn.text = "The selection is empty — there's nothing to save."
		get_ok_button().disabled = true
	else:
		_check_name()
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

func _check_name() -> void:
	var n := _name_edit.text.strip_edges()
	var taken := VoxelWorld.workspace.get_prefab(n) != null
	get_ok_button().disabled = n.is_empty()
	get_ok_button().text = "Replace" if taken else "Save"
	_warn.text = "A prefab named \"%s\" exists — saving replaces it." % n if taken else ""

func _save() -> void:
	var n := _name_edit.text.strip_edges()
	if n.is_empty():
		return
	var anchor: Variant = null
	if _anchor_pick.get_selected_id() == 1:
		var dims := _mx - _mn + Vector3i.ONE
		anchor = Vector3i(floori((dims.x - 1) / 2.0), 0, floori((dims.z - 1) / 2.0))
	var res: Variant = VoxelWorld.save_prefab_from_region(n, _mn, _mx, [], anchor, true)
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
