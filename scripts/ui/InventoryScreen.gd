class_name InventoryScreen
extends Control

# A full-screen, view-agnostic overlay for loading the hotbar — voxyl's take on the
# Minecraft inventory. It reuses the block-selector tech (BlockGrid) to preview the
# entries of whichever palette is selected on the left, and the same Hotbar control the
# editor chrome draws, so picking blocks into slots happens with one shared mental model.
# A "+" tile in the grid lets a new palette entry be added without leaving the project,
# and the selected palette's library subscriptions can be managed right here too.
#
# Interactions:
#   • E / Del            → toggle the screen (open from anywhere, incl. 3D edit mode)
#   • E / Del / Esc      → close it again
#   • click a palette     → browse that palette's entries on the right
#   • click a grid item  → load it into the active hotbar slot, then advance one slot
#   • click the "+" tile  → open a dialog to add a new entry to the selected palette
#   • right-click a tile  → delete that entry
#   • click a hotbar slot→ make it the active (target) slot   (1–9 / 0 also work)
#
# Opening while a 3D view is in fly mode does NOT leave that mode: the shell suspends
# the view (freeing the cursor) and restores it on close, so editing resumes in place.

signal opened
signal closed

const _MARGIN := 72

var _grid: BlockGrid
var _hotbar: Hotbar
var _stack: PalettePanel
var _lib_section: VBoxContainer
var _armed := false  # only react to the open keys while the editor is on screen

var _selected_palette_name: String = ""

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	visible = false
	_build_ui()
	# Keep the previews live if the palette stack or block types change while open.
	VoxelWorld.project_opened.connect(func(_p): if visible: _on_stack_changed())
	VoxelWorld.palette_stack_changed.connect(func(): if visible: _on_stack_changed())
	VoxelWorld.block_type_changed.connect(func(): if visible: _refresh_items())

# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

func _build_ui() -> void:
	# Dim backdrop; clicking it (outside the panel) closes, like dismissing a modal.
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.62)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	dim.gui_input.connect(func(ev: InputEvent):
		if ev is InputEventMouseButton and (ev as InputEventMouseButton).pressed:
			close())
	add_child(dim)

	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	# Pass-through so clicks in the margin gap reach the dim backdrop (close); the
	# panel below still gets its own input (filter is per-control, not inherited).
	margin.mouse_filter = Control.MOUSE_FILTER_IGNORE
	for side in ["margin_left", "margin_right", "margin_top", "margin_bottom"]:
		margin.add_theme_constant_override(side, _MARGIN)
	add_child(margin)

	var panel := PanelContainer.new()
	panel.mouse_filter = Control.MOUSE_FILTER_STOP
	# An explicit bordered, rounded card so it reads as a dialog rather than blending
	# into the dimmed editor behind it.
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.13, 0.14, 0.17, 1.0)
	sb.border_color = Color(0.42, 0.47, 0.58)
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(10)
	sb.set_content_margin_all(18)
	sb.shadow_color = Color(0, 0, 0, 0.5)
	sb.shadow_size = 16
	panel.add_theme_stylebox_override("panel", sb)
	margin.add_child(panel)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	panel.add_child(vbox)

	_build_header(vbox)
	vbox.add_child(HSeparator.new())

	var body := HBoxContainer.new()
	body.add_theme_constant_override("separation", 10)
	body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	vbox.add_child(body)

	_stack = PalettePanel.new()
	_stack.item_selected.connect(_on_palette_selected)
	body.add_child(_stack)

	body.add_child(VSeparator.new())

	var right := VBoxContainer.new()
	right.add_theme_constant_override("separation", 8)
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body.add_child(right)

	_lib_section = VBoxContainer.new()
	_lib_section.add_theme_constant_override("separation", 4)
	right.add_child(_lib_section)

	_grid = BlockGrid.new()
	_grid.show_captions = true
	_grid.cell_size = Vector2(64, 64)
	_grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_grid.item_selected.connect(_on_item_picked)
	_grid.item_right_clicked.connect(_on_entry_right_clicked)
	# The grid's own search box doubles as the palette-list filter — typing a term also
	# narrows which palettes show on the left (only ones with a matching entry).
	_grid.search_changed.connect(func(text: String): _stack.set_search_terms(BlockGrid.split_terms(text)))
	right.add_child(_grid)

	vbox.add_child(HSeparator.new())

	# The same Hotbar control the editor chrome uses — picks and the active-slot
	# highlight stay in sync with the bar below because both read VoxelWorld.
	_hotbar = Hotbar.new()
	vbox.add_child(_hotbar)

func _build_header(parent: Control) -> void:
	var row := HBoxContainer.new()
	var title := Label.new()
	title.text = "Inventory"
	title.add_theme_font_size_override("font_size", 18)
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(title)

	var hint := Label.new()
	hint.text = "Click a block to load the active slot  ·  E / Del / Esc to close"
	hint.add_theme_font_size_override("font_size", 12)
	hint.modulate = Color(1, 1, 1, 0.6)
	hint.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	row.add_child(hint)
	parent.add_child(row)

# ---------------------------------------------------------------------------
# Palette selection
# ---------------------------------------------------------------------------

func _on_palette_selected(palette_name: String) -> void:
	_selected_palette_name = palette_name
	_refresh_items()
	_refresh_library_section()

# Stack changed (palettes added/removed/reordered, or a project just opened): keep the
# selection if it still resolves, otherwise fall back to the first palette in the stack.
func _on_stack_changed() -> void:
	var project := VoxelWorld.active_project
	if not project or not project.palette_names.has(_selected_palette_name):
		_selected_palette_name = project.palette_names[0] if project and not project.palette_names.is_empty() else ""
		_stack.set_selected(_selected_palette_name)
	_refresh_items()
	_refresh_library_section()

# ---------------------------------------------------------------------------
# Library subscriptions for the selected palette (add / remove / reorder), same recipe
# as the standalone palette editor's library section (HomeScreen._build_palette_libraries)
# but refreshing this screen's own grid + hidden entirely for the builtin Default (whose
# library_names can't be edited) or when nothing is selected.
# ---------------------------------------------------------------------------

func _refresh_library_section() -> void:
	if not _lib_section:
		return
	for c in _lib_section.get_children():
		c.queue_free()

	var palette := VoxelWorld.workspace.get_palette(_selected_palette_name) if VoxelWorld.workspace else null
	if not palette or palette.builtin:
		_lib_section.visible = false
		return
	_lib_section.visible = true

	var lbl := Label.new()
	lbl.text = "Libraries (priority order, basic always applies last)"
	lbl.add_theme_font_size_override("font_size", 11)
	lbl.modulate = Color(1, 1, 1, 0.6)
	_lib_section.add_child(lbl)

	for i in palette.library_names.size():
		var idx := i
		var lib_name: String = palette.library_names[idx]
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 6)
		var nlbl := Label.new()
		nlbl.text = "%d. %s" % [idx + 1, lib_name]
		nlbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		nlbl.add_theme_font_size_override("font_size", 12)
		row.add_child(nlbl)
		var up := Button.new()
		up.text = "↑"; up.flat = true; up.disabled = idx == 0
		up.pressed.connect(func():
			VoxelWorld.move_palette_library(palette, idx, idx - 1)
			_refresh_library_section()
			_refresh_items())
		row.add_child(up)
		var rm := Button.new()
		rm.text = "✕"; rm.flat = true
		rm.pressed.connect(func():
			VoxelWorld.remove_palette_library(palette, idx)
			_refresh_library_section()
			_refresh_items())
		row.add_child(rm)
		_lib_section.add_child(row)

	# Add-library: libraries not already subscribed (basic is implicit, skip it), via a
	# searchable popup rather than a dropdown — a workspace can have far too many
	# libraries to manage in one flat list.
	var available: Array = []
	for n in VoxelWorld.workspace.list_libraries():
		if n != VoxelWorkspace.BASIC_LIBRARY and n not in palette.library_names:
			available.append(n)
	if not available.is_empty():
		var add_btn := Button.new()
		add_btn.text = "+ Add library"
		add_btn.pressed.connect(func():
			var picker := SearchablePicker.new()
			get_tree().root.add_child(picker)
			picker.configure(available)
			picker.picked.connect(func(library_name: String):
				VoxelWorld.add_palette_library(palette, library_name)
				_refresh_library_section()
				_refresh_items())
			picker.popup_centered(Vector2i(300, 380)))
		_lib_section.add_child(add_btn)

# ---------------------------------------------------------------------------
# Contents
# ---------------------------------------------------------------------------

# Rebuild the grid from the selected palette's own entries. Each cell previews the block
# type the entry currently resolves to (or a planning-color swatch when unmapped) — pure
# lens, no voxel data touched. A trailing "+" tile lets a new entry be added, unless the
# palette is the read-only builtin Default.
func _refresh_items() -> void:
	var palette := VoxelWorld.workspace.get_palette(_selected_palette_name) if VoxelWorld.workspace else null
	if not palette:
		_grid.populate_items([])
		return
	var items: Array = []
	for entry in palette.entries:
		var bt := VoxelWorld.workspace.resolve_block_type(entry.block_type_name, palette.library_names)
		var it := BlockGrid.Item.new()
		it.key = entry.semantic_name
		it.label = entry.semantic_name
		it.caption = entry.semantic_name
		it.block_type = bt
		it.placeholder_color = bt.color if bt else Color(0.35, 0.35, 0.35)
		items.append(it)
	if not palette.builtin:
		items.append(BlockGrid.add_item("Add"))
	_grid.populate_items(items)

# Load the picked entry into the active slot (or open the add-entry dialog), same click
# model as before. The active slot stays put so you can keep trying blocks in the same
# slot; pick the target slot with the wheel, a number key, or by clicking it on the bar
# below.
func _on_item_picked(key: String) -> void:
	if key == BlockGrid.ADD_KEY:
		_on_add_entry()
		return
	VoxelWorld.set_hotbar_slot(VoxelWorld.active_slot, key)

# Right-click an entry for a quick delete, without loading it into the hotbar first.
func _on_entry_right_clicked(key: String, global_pos: Vector2) -> void:
	var palette := VoxelWorld.workspace.get_palette(_selected_palette_name) if VoxelWorld.workspace else null
	if not palette or palette.builtin:
		return
	var entry := palette.get_entry(key)
	if not entry:
		return
	var menu := PopupMenu.new()
	menu.add_item("Edit", 0)
	menu.add_item("Delete", 1)
	menu.id_pressed.connect(func(id: int):
		if id == 0:
			_open_edit_entry_dialog(palette, entry)
		else:
			VoxelWorld.remove_palette_entry(palette, entry)
			_refresh_items())
	get_tree().root.add_child(menu)
	menu.popup_hide.connect(menu.queue_free)
	menu.popup(Rect2i(Vector2i(global_pos), Vector2i.ZERO))

# ---------------------------------------------------------------------------
# Add / edit entry — a dialog gathers the name + block pick and only mutates the palette
# on Create/Save (see NewPaletteEntryDialog); Cancel touches nothing.
# ---------------------------------------------------------------------------

func _on_add_entry() -> void:
	var palette := VoxelWorld.workspace.get_palette(_selected_palette_name) if VoxelWorld.workspace else null
	if not palette or palette.builtin:
		return
	var dlg := NewPaletteEntryDialog.new()
	get_tree().root.add_child(dlg)
	dlg.setup(palette, _unique_semantic_name(palette, "New"), _scoped_block_items(palette))
	dlg.created.connect(func(semantic_name: String, block_type_name: String):
		_create_entry(palette, semantic_name, block_type_name))
	dlg.popup_centered(Vector2i(560, 560))

func _create_entry(palette: Palette, semantic_name: String, block_type_name: String) -> void:
	var e := VoxelWorld.add_palette_entry(palette, semantic_name)
	if e and not block_type_name.is_empty():
		VoxelWorld.assign_palette_entry_block(palette, e, block_type_name)
	_refresh_items()

# Right-click "Edit": the same dialog, prefilled — lets the block type (or the semantic
# name) be changed without leaving the project.
func _open_edit_entry_dialog(palette: Palette, entry: PaletteEntry) -> void:
	var dlg := NewPaletteEntryDialog.new()
	get_tree().root.add_child(dlg)
	dlg.setup_edit(palette, entry, _scoped_block_items(palette))
	dlg.edited.connect(func(e: PaletteEntry, semantic_name: String, block_type_name: String):
		_apply_entry_edit(palette, e, semantic_name, block_type_name))
	dlg.popup_centered(Vector2i(560, 560))

func _apply_entry_edit(palette: Palette, entry: PaletteEntry, semantic_name: String, block_type_name: String) -> void:
	if semantic_name != entry.semantic_name:
		VoxelWorld.rename_palette_entry(palette, entry, semantic_name)
	VoxelWorld.assign_palette_entry_block(palette, entry, block_type_name)
	_refresh_items()

# "New", "New 2", "New 3", … — the first that no existing entry on this palette uses.
func _unique_semantic_name(palette: Palette, base: String) -> String:
	var candidate := base
	var i := 2
	while palette.get_entry(candidate) != null:
		candidate = "%s %d" % [base, i]
		i += 1
	return candidate

# Every block type a palette can map to: one BlockGrid.Item per block in its subscribed
# libraries (in priority order), then the basic-library fallback, de-duplicated by name —
# first hit wins, matching VoxelWorkspace.resolve_block_type's own scope order. Each
# item's search text folds in the *owning* library's name (see BlockGrid.block_item), so
# e.g. searching "ztones" finds every block from a "gtnh.ztones" library even when the
# block's own name/namespace never mentions "ztones".
func _scoped_block_items(palette: Palette) -> Array:
	var seen := {}
	var items: Array = []
	var libs := palette.library_names.duplicate()
	if VoxelWorkspace.BASIC_LIBRARY not in libs:
		libs.append(VoxelWorkspace.BASIC_LIBRARY)
	for lib_name in libs:
		var lib := VoxelWorld.workspace.get_library(lib_name)
		if lib == null:
			continue
		for bt in lib.sorted_block_types():
			if not seen.has(bt.name):
				seen[bt.name] = true
				items.append(BlockGrid.block_item(bt, lib_name))
	return items

# ---------------------------------------------------------------------------
# Open / close
# ---------------------------------------------------------------------------

func open() -> void:
	if visible:
		return
	_on_stack_changed()
	visible = true
	opened.emit()

func close() -> void:
	if not visible:
		return
	visible = false
	closed.emit()

# Armed only while the editor is on screen, so the home screen ignores E / Del.
func set_armed(armed: bool) -> void:
	_armed = armed
	if not armed:
		close()

# Mouse wheel and Tab, handled in _input (ahead of GUI). The wheel scrolls the block
# grid while the pointer is over it, and cycles the active hotbar slot otherwise;
# Shift+wheel always cycles slots. Tab jumps to the search box. Only active while the
# screen is open, so normal editing is untouched.
func _input(event: InputEvent) -> void:
	if not visible:
		return
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		var mb := event as InputEventMouseButton
		var delta := 0
		if mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			delta = 1
		elif mb.button_index == MOUSE_BUTTON_WHEEL_UP:
			delta = -1
		if delta != 0:
			# Over the grid (and not forced): let the event fall through to scroll it.
			if not mb.shift_pressed and _grid.is_in_scroll_area(mb.global_position):
				return
			_cycle_slot(delta)
			get_viewport().set_input_as_handled()
	elif event is InputEventKey and (event as InputEventKey).pressed \
			and (event as InputEventKey).keycode == KEY_TAB:
		_grid.focus_search()
		get_viewport().set_input_as_handled()

func _cycle_slot(delta: int) -> void:
	var n := VoxelWorld.HOTBAR_SIZE
	VoxelWorld.select_slot((VoxelWorld.active_slot + delta + n) % n)

# Toggle/close keys. _unhandled_input (not _input) so typing in the grid's search
# box — including the letter "e" — is consumed by that LineEdit and never reaches
# here. When nothing has focus (e.g. 3D fly mode) the keys arrive as unhandled.
func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey) or not (event as InputEventKey).pressed:
		return
	var kc := (event as InputEventKey).keycode
	if visible:
		if kc == KEY_E or kc == KEY_DELETE or kc == KEY_ESCAPE:
			close()
			get_viewport().set_input_as_handled()
	elif _armed and (kc == KEY_E or kc == KEY_DELETE):
		if VoxelWorld.active_project:
			open()
			get_viewport().set_input_as_handled()
