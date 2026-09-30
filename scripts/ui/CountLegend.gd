class_name CountLegend
extends VBoxContainer

# A box's (or prefab's) contents as a legend, with a "Semantics | Blocks" switch:
#   Semantics — what each cell means, the palette-independent intent (busiest first).
#   Blocks    — the ACTUAL blocks those resolve to under the palette, merged where several
#               semantics share one, with shaped parts counted as their own items (see
#               MaterialList). What you need to gather to build it in-game; "Copy list" puts it
#               on the clipboard.
# One control for every place that shows such a tally (the Select tool's panel, a prefab's
# details), so they can't drift apart on what they show. It reads the palette live and stores
# nothing (Principle 3): feed it a RegionOps.stats-shaped dictionary, and — for a prefab, which
# resolves through its own palettes rather than the open project's — the stand-in project to
# resolve as (CaptureService.prefab_stage).

# The body was rebuilt (mode flip, new data) and may have a different height: a host that
# sizes itself to its content should re-fit.
signal content_changed

const MODE_SEMANTIC := "semantic"
const MODE_BLOCK := "block"
const _DIM := Color(0.72, 0.76, 0.84)
const _WIDTH := 400.0

# Remembered across every legend: flipping to Blocks in the selection panel opens a prefab's
# details that way too — a session is usually after one view or the other.
static var _mode := MODE_SEMANTIC

var _font: int
var _max_height: float
var _stats := {}
var _resolve_as: VoxelProject = null
var _air := -1
var _semantics_btn: Button
var _blocks_btn: Button
var _copy_btn: Button
var _scroll: ScrollContainer
var _list: VBoxContainer
var _rows: Array = []   # the material rows last built, for Copy

func _init(font_size := 15, max_height := 320.0, width := _WIDTH) -> void:
	_font = font_size
	_max_height = max_height
	custom_minimum_size.x = width
	add_theme_constant_override("separation", 6)

	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 4)
	add_child(head)
	var group := ButtonGroup.new()
	_semantics_btn = _mode_button("Semantics", MODE_SEMANTIC, group,
		"What each cell means, independent of any palette")
	_blocks_btn = _mode_button("Blocks", MODE_BLOCK, group,
		"The actual blocks those resolve to under the current palette: what to gather to build it in-game. Semantics that share a block merge into one row.")
	head.add_child(_semantics_btn)
	head.add_child(_blocks_btn)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(spacer)
	_copy_btn = Button.new()
	_copy_btn.text = "Copy list"
	_copy_btn.tooltip_text = "Copy this block list to the clipboard, one item per line"
	_copy_btn.focus_mode = Control.FOCUS_NONE
	_copy_btn.add_theme_font_size_override("font_size", _font - 1)
	_copy_btn.pressed.connect(_copy)
	head.add_child(_copy_btn)

	_scroll = ScrollContainer.new()
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(_scroll)
	_list = VBoxContainer.new()
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list.add_theme_constant_override("separation", 3)
	_scroll.add_child(_list)

# `stats` is a RegionOps.stats result ({blocks, parts}); `resolve_as` the project whose palette
# stack to resolve through instead of the open one (null = the open project); `air` >= 0 adds a
# hollow "Air" row (the count of empty cells in a box).
func set_data(stats: Dictionary, resolve_as: VoxelProject = null, air := -1) -> void:
	_stats = stats
	_resolve_as = resolve_as
	_air = air
	_rebuild()

func _mode_button(text: String, mode: String, group: ButtonGroup, tip: String) -> Button:
	var b := Button.new()
	b.text = text
	b.tooltip_text = tip
	b.toggle_mode = true
	b.button_group = group
	b.focus_mode = Control.FOCUS_NONE
	b.add_theme_font_size_override("font_size", _font - 1)
	b.pressed.connect(func() -> void:
		if _mode != mode:
			_mode = mode
			_rebuild())
	return b

func _rebuild() -> void:
	for child in _list.get_children():
		_list.remove_child(child)
		child.queue_free()
	_semantics_btn.set_pressed_no_signal(_mode == MODE_SEMANTIC)
	_blocks_btn.set_pressed_no_signal(_mode == MODE_BLOCK)
	_copy_btn.visible = _mode == MODE_BLOCK
	_rows = []
	if _resolve_as != null:
		VoxelWorld.begin_resolve_as(_resolve_as)
	if _mode == MODE_BLOCK:
		_rows = MaterialList.from_stats(_stats)
		for row: Dictionary in _rows:
			_list.add_child(_block_row(row))
	else:
		var counts := RegionOps.stats_semantic_counts(_stats)
		var names := counts.keys()
		names.sort_custom(func(a, b): return counts[a] > counts[b] if counts[a] != counts[b] else a < b)
		for semantic: String in names:
			_list.add_child(_count_row(VoxelWorld.get_color_for_semantic(semantic), semantic, counts[semantic]))
	if _resolve_as != null:
		VoxelWorld.end_resolve_as()
	if _list.get_child_count() == 0:
		_list.add_child(_note("Nothing placed here."))
	# Air last, hollow: a tally of what's NOT there, not a block type.
	if _air >= 0:
		_list.add_child(_count_row(Color.TRANSPARENT, "Air", _air, true))
	_fit.call_deferred()

# Size the scroll area to its rows (capped, so a hundred-block region scrolls instead of
# filling the screen). Deferred so the rows have entered the tree and know their fonts.
func _fit() -> void:
	_scroll.custom_minimum_size.y = minf(_list.get_combined_minimum_size().y, _max_height)
	content_changed.emit()

# "[swatch] name … count" — `hollow` dims it and outlines the swatch (the air row).
func _count_row(fill: Color, text: String, count: int, hollow := false) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	row.add_child(_swatch(fill, hollow))
	var name_label := Label.new()
	name_label.text = text
	name_label.add_theme_font_size_override("font_size", _font)
	name_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_label.clip_text = true
	name_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	row.add_child(name_label)
	var count_label := Label.new()
	count_label.text = grouped(count)
	count_label.add_theme_font_size_override("font_size", _font)
	count_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	row.add_child(count_label)
	if hollow:
		name_label.add_theme_color_override("font_color", _DIM)
		count_label.add_theme_color_override("font_color", _DIM)
	return row

# One item of the block list: its title and count, then dim detail lines (library + Minecraft
# id; which semantics merged). Lines are single-line and trimmed, with the full text in the
# tooltip, so every row has a fixed height and the list can size itself without a layout pass.
func _block_row(row: Dictionary) -> Control:
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 0)
	box.add_child(_count_row(row["color"], MaterialList.title(row), row["count"], row["undecided"]))
	var lines := MaterialList.detail_lines(row)
	for line in lines:
		var pad := MarginContainer.new()
		pad.add_theme_constant_override("margin_left", 24)
		var label := Label.new()
		label.text = line
		label.add_theme_font_size_override("font_size", _font - 3)
		label.add_theme_color_override("font_color", _DIM)
		label.clip_text = true
		label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		pad.add_child(label)
		box.add_child(pad)
	box.tooltip_text = "\n".join([MaterialList.title(row)] + lines)
	return box

# A 16px palette-color chip, read live from the palette. Hollow draws a faint outline over nothing.
func _swatch(fill: Color, hollow: bool) -> Panel:
	var box := Panel.new()
	box.custom_minimum_size = Vector2(16, 16)
	box.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var sb := StyleBoxFlat.new()
	if hollow:
		sb.bg_color = Color.TRANSPARENT
		sb.border_color = Color(0.5, 0.55, 0.62)
		sb.set_border_width_all(1)
	else:
		sb.bg_color = fill
	sb.set_corner_radius_all(3)
	box.add_theme_stylebox_override("panel", sb)
	return box

func _note(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", _font)
	l.add_theme_color_override("font_color", _DIM)
	return l

func _copy() -> void:
	DisplayServer.clipboard_set(MaterialList.to_text(_rows))
	_copy_btn.text = "Copied!"
	get_tree().create_timer(1.2).timeout.connect(func() -> void:
		if is_instance_valid(_copy_btn):
			_copy_btn.text = "Copy list")

# Thousands-grouped string — a region can span millions of cells.
static func grouped(n: int) -> String:
	var s := str(absi(n))
	var out := ""
	var c := 0
	for i in range(s.length() - 1, -1, -1):
		out = s[i] + out
		c += 1
		if c % 3 == 0 and i > 0:
			out = "," + out
	return ("-" if n < 0 else "") + out
