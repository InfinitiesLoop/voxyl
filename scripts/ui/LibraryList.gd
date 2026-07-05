class_name LibraryList
extends VBoxContainer

signal item_selected(item_name: String)
signal add_requested(item_name: String)
signal delete_requested(item_name: String)
signal rename_requested(item_name: String)

@export var list_title: String = "Items"
# When true each row gets a rename (✎) affordance; the owner handles the prompt.
@export var allow_rename: bool = false

var selected: String = ""

var _item_list: VBoxContainer
var _name_input: LineEdit

func _ready() -> void:
	custom_minimum_size.x = 180

	var title := Label.new()
	title.text = list_title
	add_child(title)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)

	_item_list = VBoxContainer.new()
	_item_list.size_flags_horizontal = SIZE_EXPAND_FILL
	scroll.add_child(_item_list)

	var add_bar := HBoxContainer.new()
	add_child(add_bar)

	_name_input = LineEdit.new()
	_name_input.size_flags_horizontal = SIZE_EXPAND_FILL
	_name_input.placeholder_text = "Name..."
	_name_input.text_submitted.connect(func(_t): _on_add())
	add_bar.add_child(_name_input)

	var add_btn := Button.new()
	add_btn.text = "+"
	add_btn.pressed.connect(_on_add)
	add_bar.add_child(add_btn)

func populate(items: Array) -> void:
	for c in _item_list.get_children():
		c.queue_free()
	for item_name in items:
		_add_row(item_name)

# Selected-row background. A flat Button only paints its "pressed" stylebox override
# while actually being pressed/hovered — not for an idle toggled-on state — so the
# highlight is drawn on a wrapping PanelContainer instead, toggled explicitly here.
static var _selected_sb: StyleBoxFlat
static func _selected_style() -> StyleBoxFlat:
	if _selected_sb == null:
		_selected_sb = StyleBoxFlat.new()
		_selected_sb.bg_color = Color(0.30, 0.55, 0.90, 0.35)
		_selected_sb.corner_radius_top_left = 4
		_selected_sb.corner_radius_top_right = 4
		_selected_sb.corner_radius_bottom_left = 4
		_selected_sb.corner_radius_bottom_right = 4
	return _selected_sb

func _add_row(item_name: String) -> void:
	var row := PanelContainer.new()
	row.set_meta("item_name", item_name)

	var hbox := HBoxContainer.new()
	row.add_child(hbox)

	var btn := Button.new()
	btn.text = item_name
	btn.flat = true
	btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
	btn.size_flags_horizontal = SIZE_EXPAND_FILL
	# Clip long names instead of letting them widen the row. The list lives in an h-scroll-
	# disabled ScrollContainer, whose minimum width is the widest row's — so without this a
	# long library name grows the whole rail, and the split divider jumps as a search filters
	# which libraries (and thus which is longest) are shown. The tooltip keeps the full name.
	btn.clip_text = true
	btn.tooltip_text = item_name
	var captured := item_name
	btn.pressed.connect(func():
		selected = captured
		_update_selection()
		item_selected.emit(captured)
	)
	hbox.add_child(btn)

	if allow_rename:
		var ren := Button.new()
		ren.text = "✎"
		ren.flat = true
		ren.tooltip_text = "Rename"
		ren.pressed.connect(func(): rename_requested.emit(captured))
		hbox.add_child(ren)

	var del := Button.new()
	del.text = "✕"
	del.flat = true
	del.pressed.connect(func(): delete_requested.emit(captured))
	hbox.add_child(del)

	_item_list.add_child(row)
	_apply_row_style(row, item_name == selected)

func _apply_row_style(row: PanelContainer, is_selected: bool) -> void:
	if is_selected:
		row.add_theme_stylebox_override("panel", _selected_style())
	else:
		row.remove_theme_stylebox_override("panel")

func _update_selection() -> void:
	for row in _item_list.get_children():
		_apply_row_style(row, row.get_meta("item_name") == selected)

func _on_add() -> void:
	var item_name := _name_input.text.strip_edges()
	if item_name.is_empty():
		return
	add_requested.emit(item_name)
	_name_input.text = ""
	_name_input.grab_focus()
