class_name NewPaletteEntryDialog
extends ConfirmationDialog

# "New palette entry…" / "Edit palette entry…" — one dialog, two modes: a semantic name
# (required, unique on the palette) plus a BlockChooser (the shared "mini multi-library view")
# to pick the block it resolves to. The block is optional when creating — leaving it unpicked
# keeps the entry undecided, the "build before you decide" path. Pure UI: it only gathers the
# picks and emits them on confirm; the caller does the actual VoxelWorld mutation. That split
# is what makes Cancel free — nothing changes unless `created` or `edited` fires.

signal created(semantic_name: String, block_type_name: String)
signal edited(entry: PaletteEntry, semantic_name: String, block_type_name: String)

var _palette: Palette
var _editing_entry: PaletteEntry = null  # null → create mode
var _name_edit: LineEdit
var _chooser: BlockChooser

func _ready() -> void:
	title = "New palette entry"
	ok_button_text = "Create"

	# Draggable by its title bar (default), and resizable — the user can grow it to browse
	# more blocks at once. min_size keeps it usable; the content floor (vbox min) is kept
	# well below that so dragging the corner smaller actually works.
	unresizable = false
	min_size = Vector2i(760, 520)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	# A modest content floor; the caller's popup_centered sets the (larger) initial size and
	# the user can resize from there.
	vbox.custom_minimum_size = Vector2(700, 460)
	add_child(vbox)

	var name_row := HBoxContainer.new()
	var name_cap := Label.new()
	name_cap.text = "Name"
	name_cap.custom_minimum_size = Vector2(70, 0)
	name_row.add_child(name_cap)
	_name_edit = LineEdit.new()
	_name_edit.placeholder_text = "Semantic name…"
	_name_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_row.add_child(_name_edit)
	vbox.add_child(name_row)

	vbox.add_child(HSeparator.new())

	_chooser = BlockChooser.new()
	_chooser.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_chooser.size_flags_vertical = Control.SIZE_EXPAND_FILL
	vbox.add_child(_chooser)

	confirmed.connect(_on_confirmed)
	canceled.connect(queue_free)

	# Deferred: AcceptDialog grabs focus onto its own default button as part of showing
	# itself, which runs after about_to_popup — a same-frame grab_focus() here would just
	# get overridden. Deferring runs after that, so our field wins.
	about_to_popup.connect(func(): _apply_focus.call_deferred())

# Create mode. Set once, right after instantiation *and after the dialog is in the tree* (so
# the chooser's _ready has run) — `palette` checks name uniqueness on confirm and scopes the
# chooser's block list. Opens undecided (no block picked yet).
func setup(palette: Palette, default_name: String) -> void:
	_palette = palette
	_name_edit.text = default_name
	_chooser.configure(palette, "")

# Edit mode: prefill the current name, and open the chooser on the entry's current block so
# confirming without touching the grid keeps it as-is.
func setup_edit(palette: Palette, entry: PaletteEntry) -> void:
	_palette = palette
	_editing_entry = entry
	title = "Edit palette entry"
	ok_button_text = "Save"
	_name_edit.text = entry.semantic_name
	_chooser.configure(palette, entry.block_type_name)

# Create: the name is the thing you must supply, so focus it (default name pre-filled). Edit:
# the name's already set and you're only changing the block, so focus search to type-to-find.
func _apply_focus() -> void:
	if _editing_entry:
		_chooser.focus_search()
	else:
		_name_edit.grab_focus()
		_name_edit.select_all()

func _on_confirmed() -> void:
	var n := _name_edit.text.strip_edges()
	if n.is_empty():
		queue_free()
		return
	var collision := _palette.get_entry(n) if _palette else null
	if collision != null and collision != _editing_entry:
		queue_free()
		return
	var block := _chooser.get_selected()
	if _editing_entry:
		edited.emit(_editing_entry, n, block)
	else:
		created.emit(n, block)
	queue_free()
