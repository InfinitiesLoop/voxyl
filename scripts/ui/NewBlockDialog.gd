class_name NewBlockDialog
extends ConfirmationDialog

# "New block…" flow: a name (required) plus optional texture PNGs — an "all faces"
# texture and optional Top / Bottom overrides. Pure UI: it gathers the picks and
# emits them; HomeScreen ingests the files and builds the BlockType + BlockModel, so
# all library mutation stays in one place. Texture-less submits are first-class (the
# "build before you decide" path), so only the name is mandatory.

signal submitted(block_name: String, all_path: String, top_path: String, bottom_path: String)

var _name_edit: LineEdit
var _all_path := ""
var _top_path := ""
var _bottom_path := ""
var _all_lbl: Label
var _top_lbl: Label
var _bottom_lbl: Label

func _ready() -> void:
	title = "New block"
	ok_button_text = "Create"
	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	vbox.custom_minimum_size = Vector2(360, 0)
	add_child(vbox)

	var name_row := HBoxContainer.new()
	var name_cap := Label.new()
	name_cap.text = "Name"
	name_cap.custom_minimum_size = Vector2(70, 0)
	name_row.add_child(name_cap)
	_name_edit = LineEdit.new()
	_name_edit.placeholder_text = "Block name…"
	_name_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_row.add_child(_name_edit)
	vbox.add_child(name_row)

	vbox.add_child(HSeparator.new())

	var hint := Label.new()
	hint.text = "Textures are optional — leave them blank to decide later."
	hint.add_theme_font_size_override("font_size", 11)
	hint.modulate = Color(1, 1, 1, 0.6)
	vbox.add_child(hint)

	_all_lbl = _add_texture_row(vbox, "All faces", func(p): _all_path = p)
	_top_lbl = _add_texture_row(vbox, "Top", func(p): _top_path = p)
	_bottom_lbl = _add_texture_row(vbox, "Bottom", func(p): _bottom_path = p)

	confirmed.connect(_on_confirmed)
	canceled.connect(queue_free)

func _on_confirmed() -> void:
	var n := _name_edit.text.strip_edges()
	if not n.is_empty():
		submitted.emit(n, _all_path, _top_path, _bottom_path)
	queue_free()

# A "<caption>: <chosen file>  [Choose…]" row. `on_pick` stores the path; the
# returned label is updated here so the caller only supplies the setter.
func _add_texture_row(parent: VBoxContainer, caption: String, on_pick: Callable) -> Label:
	var row := HBoxContainer.new()
	var cap := Label.new()
	cap.text = caption
	cap.custom_minimum_size = Vector2(70, 0)
	row.add_child(cap)
	var chosen := Label.new()
	chosen.text = "none"
	chosen.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	chosen.modulate = Color(1, 1, 1, 0.6)
	row.add_child(chosen)
	var btn := Button.new()
	btn.text = "Choose…"
	btn.pressed.connect(func(): _pick_png(func(p: String):
		on_pick.call(p)
		chosen.text = p.get_file()
		chosen.modulate = Color(1, 1, 1, 0.9)))
	row.add_child(btn)
	parent.add_child(row)
	return chosen

func _pick_png(on_pick: Callable) -> void:
	var fd := FileDialog.new()
	fd.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	fd.access = FileDialog.ACCESS_FILESYSTEM
	fd.filters = PackedStringArray(["*.png ; PNG Images"])
	fd.use_native_dialog = true
	fd.file_selected.connect(func(p: String):
		on_pick.call(p)
		fd.queue_free())
	fd.canceled.connect(fd.queue_free)
	add_child(fd)
	fd.popup_centered(Vector2i(720, 500))
