class_name LibraryList
extends VBoxContainer

signal item_selected(item_name: String)
signal add_requested(item_name: String)
signal delete_requested(item_name: String)

@export var list_title: String = "Items"

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
	_name_input.return_pressed.connect(_on_add)
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

func _add_row(item_name: String) -> void:
	var row := HBoxContainer.new()

	var btn := Button.new()
	btn.text = item_name
	btn.flat = true
	btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
	btn.size_flags_horizontal = SIZE_EXPAND_FILL
	btn.toggle_mode = true
	btn.button_pressed = item_name == selected
	var captured := item_name
	btn.pressed.connect(func():
		selected = captured
		_update_selection()
		item_selected.emit(captured)
	)
	row.add_child(btn)

	var del := Button.new()
	del.text = "✕"
	del.flat = true
	del.pressed.connect(func(): delete_requested.emit(captured))
	row.add_child(del)

	_item_list.add_child(row)

func _update_selection() -> void:
	for row in _item_list.get_children():
		var btn := row.get_child(0) as Button
		if btn:
			btn.button_pressed = btn.text == selected

func _on_add() -> void:
	var item_name := _name_input.text.strip_edges()
	if item_name.is_empty():
		return
	add_requested.emit(item_name)
	_name_input.text = ""
	_name_input.grab_focus()
