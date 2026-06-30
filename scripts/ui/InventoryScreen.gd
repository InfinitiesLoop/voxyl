class_name InventoryScreen
extends Control

# A full-screen, view-agnostic overlay for loading the hotbar — voxyl's take on the
# Minecraft inventory. It reuses the block-selector tech (BlockGrid) to preview every
# template item the project's palettes expose, and the same Hotbar control the editor
# chrome draws, so picking blocks into slots happens with one shared mental model.
#
# Interactions:
#   • E / Del            → toggle the screen (open from anywhere, incl. 3D edit mode)
#   • E / Del / Esc      → close it again
#   • click a grid item  → load it into the active hotbar slot, then advance one slot
#   • click a hotbar slot→ make it the active (target) slot   (1–9 / 0 also work)
#
# Opening while a 3D view is in fly mode does NOT leave that mode: the shell suspends
# the view (freeing the cursor) and restores it on close, so editing resumes in place.

signal opened
signal closed

const _MARGIN := 72

var _grid: BlockGrid
var _hotbar: Hotbar
var _armed := false  # only react to the open keys while the editor is on screen

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	visible = false
	_build_ui()
	# Keep the previews live if the palette stack or block types change while open.
	VoxelWorld.project_opened.connect(func(_p): if visible: _refresh_items())
	VoxelWorld.palette_stack_changed.connect(func(): if visible: _refresh_items())
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
	_build_palettes(vbox)
	vbox.add_child(HSeparator.new())

	_grid = BlockGrid.new()
	_grid.show_captions = true
	_grid.cell_size = Vector2(64, 64)
	_grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_grid.item_selected.connect(_on_item_picked)
	vbox.add_child(_grid)

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

func _build_palettes(parent: Control) -> void:
	var row := HBoxContainer.new()
	var lbl := Label.new()
	lbl.text = "Palettes"
	lbl.add_theme_font_size_override("font_size", 12)
	lbl.modulate = Color(1, 1, 1, 0.7)
	lbl.custom_minimum_size = Vector2(64, 0)
	row.add_child(lbl)

	var stack := PalettePanel.new()
	stack.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(stack)
	parent.add_child(row)

# ---------------------------------------------------------------------------
# Contents
# ---------------------------------------------------------------------------

# Rebuild the grid from the project's merged template items. Each cell previews the
# block type the semantic currently resolves to (or a planning-color swatch when the
# semantic is unmapped) — pure lens, no voxel data touched.
func _refresh_items() -> void:
	var items: Array = []
	for sem in VoxelWorld.merged_semantic_names():
		var it := BlockGrid.Item.new()
		it.key = sem
		it.label = sem
		it.caption = sem
		it.block_type = VoxelWorld.get_block_type_object_for_semantic(sem)
		it.placeholder_color = VoxelWorld.get_color_for_semantic(sem)
		items.append(it)
	_grid.populate_items(items)

# Load the picked template item into the active slot. The active slot stays put so
# you can keep trying blocks in the same slot; pick the target slot with the wheel,
# a number key, or by clicking it on the bar below.
func _on_item_picked(semantic: String) -> void:
	VoxelWorld.set_hotbar_slot(VoxelWorld.active_slot, semantic)

# ---------------------------------------------------------------------------
# Open / close
# ---------------------------------------------------------------------------

func open() -> void:
	if visible:
		return
	_refresh_items()
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
