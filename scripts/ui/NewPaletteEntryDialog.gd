class_name NewPaletteEntryDialog
extends ConfirmationDialog

# "New palette entry…" / "Edit palette entry…" — one dialog, two modes (create / edit) and
# two kinds of entry:
#   Block — a semantic name + a BlockChooser (the shared "mini multi-library view") to pick
#           the block it resolves to. The block is optional — leaving it unpicked keeps the
#           entry undecided, the "build before you decide" path.
#   Shape — a semantic name + a shape (ShapeCatalog) + the block entry it's cut from (its
#           base). The base is optional too (undecided). A shaped entry never picks a block
#           type itself; its look always flows from its base (.plans/shaped-parts.md).
# Pure UI: it only gathers the picks and emits them on confirm; the caller does the actual
# VoxelWorld mutation. That split is what makes Cancel free — nothing changes unless one of
# the signals fires.

signal created(semantic_name: String, block_type_name: String)
signal edited(entry: PaletteEntry, semantic_name: String, block_type_name: String)
signal created_shaped(semantic_name: String, shape_id: String, base_name: String)
signal edited_shaped(entry: PaletteEntry, semantic_name: String, shape_id: String, base_name: String)

enum Kind { BLOCK, SHAPE }

var _palette: Palette
var _editing_entry: PaletteEntry = null  # null → create mode
var _kind := Kind.BLOCK
var _name_edit: LineEdit
var _chooser: BlockChooser
var _block_btn: Button
var _shape_btn: Button
var _shape_page: Control
var _shape_buttons := {}         # shape id -> Button
var _glyphs: Array[ShapeGlyph] = []
var _base_list: ItemList
var _base_names: Array[String] = []   # parallel to _base_list rows; "" = pick later
var _shape_id := ""
var _base_name := ""
# Create mode: the name follows the picks ("Trim Strip") until the user types their own.
var _name_auto := false
var _setting_name := false

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
	_name_edit.text_changed.connect(func(_t: String):
		if not _setting_name:
			_name_auto = false)
	name_row.add_child(_name_edit)
	vbox.add_child(name_row)

	# Block / Shape toggle.
	var kind_row := HBoxContainer.new()
	var kind_cap := Label.new()
	kind_cap.text = "Kind"
	kind_cap.custom_minimum_size = Vector2(70, 0)
	kind_row.add_child(kind_cap)
	var group := ButtonGroup.new()
	_block_btn = _kind_button("Block", group, Kind.BLOCK)
	_shape_btn = _kind_button("Shape", group, Kind.SHAPE)
	kind_row.add_child(_block_btn)
	kind_row.add_child(_shape_btn)
	var kind_hint := Label.new()
	kind_hint.text = "  A shape is cut from another entry's material."
	kind_hint.modulate = Color(1, 1, 1, 0.55)
	kind_row.add_child(kind_hint)
	vbox.add_child(kind_row)

	vbox.add_child(HSeparator.new())

	_chooser = BlockChooser.new()
	_chooser.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_chooser.size_flags_vertical = Control.SIZE_EXPAND_FILL
	vbox.add_child(_chooser)

	_shape_page = _build_shape_page()
	vbox.add_child(_shape_page)

	confirmed.connect(_on_confirmed)
	canceled.connect(queue_free)

	# Deferred: AcceptDialog grabs focus onto its own default button as part of showing
	# itself, which runs after about_to_popup — a same-frame grab_focus() here would just
	# get overridden. Deferring runs after that, so our field wins.
	about_to_popup.connect(func(): _apply_focus.call_deferred())
	_set_kind(Kind.BLOCK)

func _kind_button(text: String, group: ButtonGroup, kind: Kind) -> Button:
	var b := Button.new()
	b.text = text
	b.toggle_mode = true
	b.button_group = group
	b.custom_minimum_size = Vector2(80, 0)
	b.pressed.connect(func(): _set_kind(kind))
	return b

# The shape page: the catalog as glyph buttons (one row per family) on the left, and the
# palette's block entries to cut from on the right.
func _build_shape_page() -> Control:
	var page := HBoxContainer.new()
	page.size_flags_vertical = Control.SIZE_EXPAND_FILL
	page.add_theme_constant_override("separation", 16)

	var left := VBoxContainer.new()
	left.add_theme_constant_override("separation", 6)
	page.add_child(left)
	var shape_cap := Label.new()
	shape_cap.text = "Shape"
	left.add_child(shape_cap)
	var group := ButtonGroup.new()
	var current_family := -1
	var row: HBoxContainer = null
	for id in ShapeCatalog.ORDER:
		var fam := ShapeCatalog.family_of(id)
		if fam != current_family:
			current_family = fam
			var fam_label := Label.new()
			fam_label.text = ShapeCatalog.FAMILY_NAMES[fam]
			fam_label.add_theme_font_size_override("font_size", 11)
			fam_label.modulate = Color(1, 1, 1, 0.55)
			left.add_child(fam_label)
			row = HBoxContainer.new()
			row.add_theme_constant_override("separation", 6)
			left.add_child(row)
		row.add_child(_shape_button(id, group))

	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.add_theme_constant_override("separation", 6)
	page.add_child(right)
	var base_cap := Label.new()
	base_cap.text = "Cut from (base entry)"
	right.add_child(base_cap)
	_base_list = ItemList.new()
	_base_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_base_list.item_selected.connect(func(i: int):
		_base_name = _base_names[i] if i >= 0 and i < _base_names.size() else ""
		_on_shape_picks_changed())
	right.add_child(_base_list)
	var hint := Label.new()
	hint.text = "The shape takes its look from the base entry — change the base's block\nlater and every placed piece re-skins. Changing the shape only affects\npieces placed afterwards."
	hint.add_theme_font_size_override("font_size", 11)
	hint.modulate = Color(1, 1, 1, 0.55)
	right.add_child(hint)
	return page

func _shape_button(id: String, group: ButtonGroup) -> Button:
	var b := Button.new()
	b.toggle_mode = true
	b.button_group = group
	b.custom_minimum_size = Vector2(92, 78)
	b.tooltip_text = ShapeCatalog.name_of(id)
	var box := VBoxContainer.new()
	box.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	box.alignment = BoxContainer.ALIGNMENT_CENTER
	var glyph := ShapeGlyph.new()
	glyph.shape_id = id
	glyph.custom_minimum_size = Vector2(46, 46)
	glyph.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	box.add_child(glyph)
	_glyphs.append(glyph)
	var label := Label.new()
	label.text = ShapeCatalog.name_of(id)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 11)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	box.add_child(label)
	b.add_child(box)
	b.pressed.connect(func():
		_shape_id = id
		_on_shape_picks_changed())
	_shape_buttons[id] = b
	return b

func _set_kind(kind: Kind) -> void:
	_kind = kind
	_block_btn.set_pressed_no_signal(kind == Kind.BLOCK)
	_shape_btn.set_pressed_no_signal(kind == Kind.SHAPE)
	_chooser.visible = kind == Kind.BLOCK
	_shape_page.visible = kind == Kind.SHAPE
	_update_ok()
	if kind == Kind.SHAPE:
		_on_shape_picks_changed()

# Create mode. Set once, right after instantiation *and after the dialog is in the tree* (so
# the chooser's _ready has run) — `palette` checks name uniqueness on confirm and scopes the
# chooser's block list and the base-entry list. Opens undecided (no block picked yet).
# `shape_base` pre-opens the Shape kind cutting from that entry ("New shape from this").
func setup(palette: Palette, default_name: String, shape_base := "") -> void:
	_palette = palette
	_set_name(default_name)
	_name_auto = true
	_chooser.configure(palette, "")
	_base_name = shape_base
	_fill_base_list(null)
	if not shape_base.is_empty():
		_set_kind(Kind.SHAPE)

# Edit mode: prefill the current name and picks, so confirming without touching anything
# keeps the entry as-is.
func setup_edit(palette: Palette, entry: PaletteEntry) -> void:
	_palette = palette
	_editing_entry = entry
	title = "Edit palette entry"
	ok_button_text = "Save"
	_set_name(entry.semantic_name)
	_name_auto = false
	_chooser.configure(palette, entry.block_type_name)
	_shape_id = entry.shape_id
	_base_name = entry.base_name
	if _shape_buttons.has(_shape_id):
		(_shape_buttons[_shape_id] as Button).set_pressed_no_signal(true)
	_fill_base_list(entry)
	_set_kind(Kind.SHAPE if entry.is_shaped() else Kind.BLOCK)

# The palette's block entries (the only valid bases), plus "pick later". An entry can't be
# cut from itself.
func _fill_base_list(exclude: PaletteEntry) -> void:
	_base_list.clear()
	_base_names.clear()
	_base_list.add_item("(pick later — undecided)")
	_base_names.append("")
	var select := 0
	if _palette:
		for e in _palette.entries:
			if e.is_shaped() or e == exclude:
				continue
			var label := e.semantic_name
			if not e.block_type_name.is_empty():
				label += "   —   " + e.block_type_name
			_base_list.add_item(label)
			_base_names.append(e.semantic_name)
			if e.semantic_name == _base_name:
				select = _base_names.size() - 1
	_base_list.select(select)
	_base_name = _base_names[select]

func _on_shape_picks_changed() -> void:
	# Glyphs take the picked base's planning color, so the picker previews the material.
	var col := Color(0.62, 0.62, 0.66)
	var be := _palette.get_entry(_base_name) if _palette and not _base_name.is_empty() else null
	if be != null:
		var bt := VoxelWorld.workspace.resolve_block_type(be.block_type_name, _palette.library_names)
		if bt:
			col = bt.color
	for g in _glyphs:
		g.color = col
	if _name_auto and not _shape_id.is_empty():
		var n := ShapeCatalog.name_of(_shape_id)
		if not _base_name.is_empty():
			n = "%s %s" % [_base_name, n]
		_set_name(_unique_name(n))
	_update_ok()

func _set_name(n: String) -> void:
	_setting_name = true
	_name_edit.text = n
	_setting_name = false

func _unique_name(base: String) -> String:
	if _palette == null:
		return base
	var candidate := base
	var i := 2
	var existing := _palette.get_entry(candidate)
	while existing != null and existing != _editing_entry:
		candidate = "%s %d" % [base, i]
		i += 1
		existing = _palette.get_entry(candidate)
	return candidate

func _update_ok() -> void:
	var ok := get_ok_button()
	if ok:
		ok.disabled = _kind == Kind.SHAPE and _shape_id.is_empty()

# Create: the name is the thing you must supply, so focus it (default name pre-filled). Edit:
# the name's already set and you're only changing the block, so focus search to type-to-find.
func _apply_focus() -> void:
	if _editing_entry and _kind == Kind.BLOCK:
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
	if _kind == Kind.SHAPE:
		if not _shape_id.is_empty():
			if _editing_entry:
				edited_shaped.emit(_editing_entry, n, _shape_id, _base_name)
			else:
				created_shaped.emit(n, _shape_id, _base_name)
		queue_free()
		return
	var block := _chooser.get_selected()
	if _editing_entry:
		edited.emit(_editing_entry, n, block)
	else:
		created.emit(n, block)
	queue_free()
