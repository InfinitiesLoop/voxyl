class_name NewPaletteEntryDialog
extends ConfirmationDialog

# "New palette entry…" / "Edit palette entry…" — one dialog, two modes (create / edit) and
# two kinds of entry, picked with the Block / Shape tabs:
#   Block — a semantic name + a BlockChooser (the shared "mini multi-library view") to pick
#           the block it resolves to.
#   Shape — the same, plus a shape (ShapeCatalog) the block is cut into: covers, strips,
#           corners, …, placed as parts (.plans/shaped-parts.md).
# The block is optional either way — leaving it unpicked keeps the entry undecided, the
# "build before you decide" path. Pure UI: it only gathers the picks and emits them on
# confirm; the caller does the actual VoxelWorld mutation. That split is what makes Cancel
# free — nothing changes unless `created` or `edited` fires. `shape_id` is "" for a Block.

signal created(semantic_name: String, block_type_name: String, shape_id: String)
signal edited(entry: PaletteEntry, semantic_name: String, block_type_name: String, shape_id: String)

enum Kind { BLOCK, SHAPE }

var _palette: Palette
var _editing_entry: PaletteEntry = null  # null → create mode
var _kind := Kind.BLOCK
var _name_edit: LineEdit
var _chooser: BlockChooser
var _block_btn: Button
var _shape_btn: Button
var _shape_page: Control
var _shape_buttons := {}         # shape id -> Button (the open page's)
var _glyphs: Array[ShapeGlyph] = []
var _page_tabs: Array[Button] = []
var _shape_grid: GridContainer
var _page := 0
var _shape_id := ""
# Create mode, Shape kind: the name follows the picks ("Oak Planks Strip") until the user
# types their own.
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

	# Block / Shape tabs.
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
	kind_hint.text = "  A shape cuts the block into covers, strips, corners, …"
	kind_hint.modulate = Color(1, 1, 1, 0.55)
	kind_row.add_child(kind_hint)
	vbox.add_child(kind_row)

	vbox.add_child(HSeparator.new())

	# Shape column (Shape tab only) beside the block chooser (both tabs).
	var body := HBoxContainer.new()
	body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body.add_theme_constant_override("separation", 16)
	vbox.add_child(body)
	_shape_page = _build_shape_page()
	body.add_child(_shape_page)
	_chooser = BlockChooser.new()
	_chooser.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_chooser.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_chooser.selection_changed.connect(func(_b: String): _on_picks_changed())
	body.add_child(_chooser)

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

# The shape column: a tab per catalog page (Microblocks, Roofing, …) over a scrolling grid of
# glyph buttons for that page. Only the open page's buttons exist at a time.
func _build_shape_page() -> Control:
	var left := VBoxContainer.new()
	left.add_theme_constant_override("separation", 6)
	left.custom_minimum_size = Vector2(330, 0)
	var shape_cap := Label.new()
	shape_cap.text = "Shape"
	left.add_child(shape_cap)
	var tabs := HFlowContainer.new()
	var tab_group := ButtonGroup.new()
	var pages := ShapeCatalog.pages()
	for i in pages.size():
		var t := Button.new()
		t.text = str(pages[i][0])
		t.toggle_mode = true
		t.button_group = tab_group
		t.add_theme_font_size_override("font_size", 11)
		t.pressed.connect(func(): _show_page(i))
		tabs.add_child(t)
		_page_tabs.append(t)
	left.add_child(tabs)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	left.add_child(scroll)
	_shape_grid = GridContainer.new()
	_shape_grid.columns = 3
	_shape_grid.add_theme_constant_override("h_separation", 6)
	_shape_grid.add_theme_constant_override("v_separation", 6)
	scroll.add_child(_shape_grid)
	var hint := Label.new()
	hint.text = "Changing the shape later only\naffects pieces placed afterwards."
	hint.add_theme_font_size_override("font_size", 11)
	hint.modulate = Color(1, 1, 1, 0.55)
	left.add_child(hint)
	_show_page(0)
	return left

# Fill the grid with page `index`'s shapes, keeping the picked shape's button pressed.
func _show_page(index: int) -> void:
	var pages := ShapeCatalog.pages()
	if index < 0 or index >= pages.size():
		return
	_page = index
	for i in _page_tabs.size():
		_page_tabs[i].set_pressed_no_signal(i == index)
	for c in _shape_grid.get_children():
		c.queue_free()
	_shape_buttons.clear()
	_glyphs.clear()
	var group := ButtonGroup.new()
	for id in pages[index][1]:
		_shape_grid.add_child(_shape_button(str(id), group))
	if _shape_buttons.has(_shape_id):
		(_shape_buttons[_shape_id] as Button).set_pressed_no_signal(true)
	_on_picks_changed()

# The page showing `shape_id` (its first), or 0.
func _page_of(shape_id: String) -> int:
	var pages := ShapeCatalog.pages()
	for i in pages.size():
		if (pages[i][1] as Array).has(shape_id):
			return i
	return 0

func _shape_button(id: String, group: ButtonGroup) -> Button:
	var b := Button.new()
	b.toggle_mode = true
	b.button_group = group
	b.custom_minimum_size = Vector2(100, 84)
	b.tooltip_text = ShapeCatalog.name_of(id)
	var box := VBoxContainer.new()
	box.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	box.alignment = BoxContainer.ALIGNMENT_CENTER
	var glyph := ShapeGlyph.new()
	glyph.shape_id = id
	glyph.custom_minimum_size = Vector2(48, 48)
	glyph.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	box.add_child(glyph)
	_glyphs.append(glyph)
	var label := Label.new()
	label.text = ShapeCatalog.name_of(id)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.custom_minimum_size = Vector2(94, 0)
	label.add_theme_font_size_override("font_size", 10)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	box.add_child(label)
	b.add_child(box)
	b.pressed.connect(func():
		_shape_id = id
		_on_picks_changed())
	_shape_buttons[id] = b
	return b

func _set_kind(kind: Kind) -> void:
	_kind = kind
	_block_btn.set_pressed_no_signal(kind == Kind.BLOCK)
	_shape_btn.set_pressed_no_signal(kind == Kind.SHAPE)
	_shape_page.visible = kind == Kind.SHAPE
	_on_picks_changed()

# Create mode. Set once, right after instantiation *and after the dialog is in the tree* (so
# the chooser's _ready has run) — `palette` checks name uniqueness on confirm and scopes the
# chooser's block list. Opens undecided unless `block` is given; `as_shape` opens on the
# Shape tab ("New shape from this…").
func setup(palette: Palette, default_name: String, block := "", as_shape := false) -> void:
	_palette = palette
	_set_name(default_name)
	_name_auto = true
	_chooser.configure(palette, block)
	if as_shape:
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
	_show_page(_page_of(_shape_id))
	_set_kind(Kind.SHAPE if entry.is_shaped() else Kind.BLOCK)

# Keep the glyphs in the picked block's planning color, the auto-name current, and OK
# enabled only when a Shape entry has a shape.
func _on_picks_changed() -> void:
	var block := _chooser.get_selected() if _chooser else ""
	var bt: BlockType = null
	if _palette and not block.is_empty():
		bt = VoxelWorld.workspace.resolve_block_type(block, _palette.library_names)
	var col := bt.color if bt else Color(0.62, 0.62, 0.66)
	for g in _glyphs:
		g.color = col
	if _name_auto and _kind == Kind.SHAPE and not _shape_id.is_empty():
		var n := ShapeCatalog.name_of(_shape_id)
		if not block.is_empty():
			n = "%s %s" % [_pretty_block_name(block), n]
		_set_name(_unique_name(n))
	var ok := get_ok_button()
	if ok:
		ok.disabled = _kind == Kind.SHAPE and _shape_id.is_empty()

# "minecraft:oak_planks" / "sets/azur/azur_ (14)" → "Oak Planks" / "Azur (14)".
static func _pretty_block_name(block: String) -> String:
	var leaf := block.get_slice("/", block.get_slice_count("/") - 1)
	leaf = leaf.get_slice(":", leaf.get_slice_count(":") - 1)
	return leaf.replace("_", " ").strip_edges().capitalize()

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
	if n.is_empty() or (_kind == Kind.SHAPE and _shape_id.is_empty()):
		queue_free()
		return
	var collision := _palette.get_entry(n) if _palette else null
	if collision != null and collision != _editing_entry:
		queue_free()
		return
	var block := _chooser.get_selected()
	var shape := _shape_id if _kind == Kind.SHAPE else ""
	if _editing_entry:
		edited.emit(_editing_entry, n, block, shape)
	else:
		created.emit(n, block, shape)
	queue_free()
