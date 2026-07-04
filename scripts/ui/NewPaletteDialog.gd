class_name NewPaletteDialog
extends ConfirmationDialog

# "New palette…" flow: just a required name. Pure UI: it gathers the name and emits it;
# the caller creates the palette so all workspace mutation stays in one place (mirrors
# NewBlockDialog's split between prompting and creating).

signal submitted(palette_name: String)

var _name_edit: LineEdit

func _ready() -> void:
	title = "New palette"
	ok_button_text = "Create"

	var vbox := VBoxContainer.new()
	vbox.custom_minimum_size = Vector2(320, 0)
	add_child(vbox)

	var name_row := HBoxContainer.new()
	var name_cap := Label.new()
	name_cap.text = "Name"
	name_cap.custom_minimum_size = Vector2(70, 0)
	name_row.add_child(name_cap)
	_name_edit = LineEdit.new()
	_name_edit.placeholder_text = "Palette name…"
	_name_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_name_edit.text_submitted.connect(func(_t): _on_confirmed())
	name_row.add_child(_name_edit)
	vbox.add_child(name_row)

	confirmed.connect(_on_confirmed)
	canceled.connect(queue_free)

	# So typing can start immediately once the dialog is on screen.
	about_to_popup.connect(func(): _name_edit.grab_focus())

func _on_confirmed() -> void:
	var n := _name_edit.text.strip_edges()
	if not n.is_empty():
		submitted.emit(n)
	queue_free()
