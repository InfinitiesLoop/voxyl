class_name NewPaletteEntryDialog
extends ConfirmationDialog

# "New palette entry…" / "Edit palette entry…" — one dialog, two modes: a semantic name
# (required, unique on the palette) plus a searchable grid to pick the block it resolves
# to (optional when creating — leaving it unpicked keeps the entry undecided, the "build
# before you decide" path). Pure UI, mirroring NewBlockDialog: it only gathers the picks
# and emits them on confirm; the caller does the actual VoxelWorld mutation. That split is
# what makes Cancel free — nothing changes unless `created` or `edited` fires.

signal created(semantic_name: String, block_type_name: String)
signal edited(entry: PaletteEntry, semantic_name: String, block_type_name: String)

var _palette: Palette
var _editing_entry: PaletteEntry = null  # null → create mode
var _name_edit: LineEdit
var _grid: BlockGrid
var _picked_block_name: String = ""

func _ready() -> void:
	title = "New palette entry"
	ok_button_text = "Create"

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	vbox.custom_minimum_size = Vector2(520, 520)
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

	var bt_lbl := Label.new()
	bt_lbl.text = "Block type (optional — pick later if undecided)"
	bt_lbl.add_theme_font_size_override("font_size", 11)
	bt_lbl.modulate = Color(1, 1, 1, 0.6)
	vbox.add_child(bt_lbl)

	_grid = BlockGrid.new()
	_grid.show_captions = true
	_grid.cell_size = Vector2(48, 48)
	_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_grid.item_selected.connect(func(key: String):
		_picked_block_name = key
		_grid.set_selected(key))
	vbox.add_child(_grid)

	confirmed.connect(_on_confirmed)
	canceled.connect(queue_free)

	about_to_popup.connect(func(): _name_edit.grab_focus())

# Set once, right after instantiation and before popup — `palette` is used only to check
# name uniqueness on confirm; `items` is the caller-built scoped block-type list (already
# has the machinery for this in InventoryScreen, no need to duplicate it here).
func setup(palette: Palette, default_name: String, items: Array) -> void:
	_palette = palette
	_name_edit.text = default_name
	_grid.populate_items(items)

# Edit mode: prefill the current name and block, and highlight that block in the grid.
# `_picked_block_name` starts at the entry's current assignment (not empty) so confirming
# without touching the grid keeps it as-is instead of silently clearing it.
func setup_edit(palette: Palette, entry: PaletteEntry, items: Array) -> void:
	_palette = palette
	_editing_entry = entry
	title = "Edit palette entry"
	ok_button_text = "Save"
	_name_edit.text = entry.semantic_name
	_picked_block_name = entry.block_type_name
	_grid.populate_items(items)
	_grid.set_selected(entry.block_type_name)

func _on_confirmed() -> void:
	var n := _name_edit.text.strip_edges()
	if n.is_empty():
		queue_free()
		return
	var collision := _palette.get_entry(n) if _palette else null
	if collision != null and collision != _editing_entry:
		queue_free()
		return
	if _editing_entry:
		edited.emit(_editing_entry, n, _picked_block_name)
	else:
		created.emit(n, _picked_block_name)
	queue_free()
