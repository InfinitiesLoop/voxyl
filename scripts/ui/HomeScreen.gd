class_name HomeScreen
extends Control

signal open_project_requested(project: VoxelProject)

var _projects_container: VBoxContainer
# Projects tab (accordion) state: which card is expanded (selected), the current filter
# substring, and a mtime-keyed cache of loaded thumbnail textures so _refresh doesn't
# reload PNGs from disk on every rebuild.
var _expanded_project_name: String = ""
var _project_filter: String = ""
var _thumb_cache: Dictionary = {}
var _palettes_list: LibraryList
var _library_rail: LibraryList
var _selected_library: BlockLibrary
var _block_grid: BlockGrid
var _bt_detail: Control
var _bt_preview: BlockPreview3D
var _selected_block_type: String = ""
var _editing_palette: Palette
# Palettes tab: an icon grid of entries (like the Block Types tab) + a right-hand detail
# panel. _palette_header is rebuilt per palette (title + collapsible library subscriptions +
# entries header); _palette_grid + _entry_detail persist and are re-populated.
var _palette_grid: BlockGrid
var _palette_header: VBoxContainer
var _entry_detail: Control
var _selected_entry_semantic: String = ""

func _ready() -> void:
	var tabs := TabContainer.new()
	tabs.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(tabs)

	tabs.add_child(_build_projects_tab())
	tabs.add_child(_build_palettes_tab())
	tabs.add_child(_build_block_types_tab())

	VoxelWorld.workspace_changed.connect(_refresh)
	# Returning from the editor bakes a fresh thumbnail during save_active_project but
	# fires no workspace_changed, so rebuild the project cards on show to pick up the new
	# preview (and any last-edited re-sort).
	visibility_changed.connect(func():
		if visible and _projects_container:
			_rebuild_projects())
	_refresh()

# ---------------------------------------------------------------------------
# Projects tab
# ---------------------------------------------------------------------------

func _build_projects_tab() -> Control:
	var root := _margin(16)
	root.name = "Projects"

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 12)
	root.add_child(vbox)

	var header := HBoxContainer.new()
	vbox.add_child(header)

	var title := Label.new()
	title.text = "Projects"
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(title)

	var filter_edit := LineEdit.new()
	filter_edit.placeholder_text = "Filter projects…"
	filter_edit.clear_button_enabled = true
	filter_edit.custom_minimum_size = Vector2(200, 0)
	filter_edit.text_changed.connect(func(t: String):
		_project_filter = t
		_rebuild_projects())
	header.add_child(filter_edit)

	var new_btn := Button.new()
	new_btn.text = "New Project"
	new_btn.pressed.connect(_on_new_project)
	header.add_child(new_btn)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	vbox.add_child(scroll)

	_projects_container = VBoxContainer.new()
	_projects_container.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_projects_container.add_theme_constant_override("separation", 8)
	scroll.add_child(_projects_container)

	return root

# Rebuild the accordion list: filter by the current substring, sort by last-edited
# descending (tie-break name), one card each. Sorts a copy — the canonical
# workspace.projects order is never touched.
func _rebuild_projects() -> void:
	for c in _projects_container.get_children():
		c.queue_free()
	var shown: Array = _visible_projects()
	if shown.is_empty():
		var empty := Label.new()
		empty.text = "No projects match your filter." if not _project_filter.strip_edges().is_empty() else "No projects yet — create one to get started."
		empty.add_theme_color_override("font_color", Color(0.6, 0.6, 0.6))
		_projects_container.add_child(empty)
		return
	for project in shown:
		_projects_container.add_child(_make_project_row(project))

# Projects matching the filter, sorted by modified_at desc then name.
func _visible_projects() -> Array:
	var needle := _project_filter.strip_edges().to_lower()
	var shown: Array = []
	for project in VoxelWorld.workspace.projects:
		if needle.is_empty() or project.name.to_lower().contains(needle):
			shown.append(project)
	shown.sort_custom(func(a, b):
		if a.modified_at != b.modified_at:
			return a.modified_at > b.modified_at
		return a.name.naturalnocasecmp_to(b.name) < 0)
	return shown

# An accordion card: an always-visible header (thumbnail + name + edited-relative) that
# toggles expansion, and — when expanded — a detail body (larger preview, stats, rename,
# Open, Delete). One card is expanded at a time; the expanded one is styled as selected.
func _make_project_row(project: VoxelProject) -> Control:
	var expanded := project.name == _expanded_project_name

	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.22, 0.24, 0.30) if expanded else Color(0.18, 0.18, 0.20)
	style.set_corner_radius_all(6)
	style.set_content_margin_all(10)
	if expanded:
		style.set_border_width_all(2)
		style.border_color = Color(0.42, 0.56, 0.85)

	var card := PanelContainer.new()
	card.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	card.add_theme_stylebox_override("panel", style)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 10)
	card.add_child(vbox)

	vbox.add_child(_make_project_header(project, expanded))
	if expanded:
		vbox.add_child(HSeparator.new())
		vbox.add_child(_make_project_detail(project))
	return card

# The clickable header row. Single click toggles expansion (selecting this card and
# collapsing any other); double-click opens the project.
func _make_project_header(project: VoxelProject, expanded: bool) -> Control:
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 14)
	header.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	header.gui_input.connect(func(ev: InputEvent):
		if ev is InputEventMouseButton and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT and (ev as InputEventMouseButton).pressed:
			if (ev as InputEventMouseButton).double_click:
				open_project_requested.emit(project)
			else:
				_toggle_project(project.name))

	header.add_child(_thumb_control(project, Vector2(60, 60)))

	var caret := Label.new()
	caret.text = "▾" if expanded else "▸"
	caret.add_theme_color_override("font_color", Color(0.7, 0.7, 0.7))
	caret.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	caret.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.add_child(caret)

	var name_lbl := Label.new()
	name_lbl.text = project.name
	name_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	name_lbl.add_theme_font_size_override("font_size", 15)
	name_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.add_child(name_lbl)

	var edited_lbl := Label.new()
	edited_lbl.text = "edited " + _relative_time(project.modified_at)
	edited_lbl.add_theme_color_override("font_color", Color(0.6, 0.6, 0.6))
	edited_lbl.add_theme_font_size_override("font_size", 12)
	edited_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	edited_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.add_child(edited_lbl)
	return header

# The expanded detail body: metadata/stats, rename field, Open + Delete. The preview
# lives in the header thumbnail — no second copy here.
func _make_project_detail(project: VoxelProject) -> Control:
	var info := VBoxContainer.new()
	info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	info.add_theme_constant_override("separation", 6)

	info.add_child(_kv("Created", _format_date(project.created_at)))
	info.add_child(_kv("Last edited", _format_date(project.modified_at)))
	var palettes := ", ".join(project.palette_names) if not project.palette_names.is_empty() else "(none)"
	info.add_child(_kv("Palettes", palettes))
	var total := project.data.cells.size() if project.data else 0
	info.add_child(_kv("Blocks", str(total)))
	info.add_child(_kv("Dimensions", _dimensions_text(project)))

	# Per-semantic breakdown, most-used first.
	var counts := project.semantic_counts() if project.data else {}
	if not counts.is_empty():
		var pairs: Array = counts.keys()
		pairs.sort_custom(func(a, b): return counts[a] > counts[b])
		var breakdown := PackedStringArray()
		for k in pairs:
			breakdown.append("%s ×%d" % [k, counts[k]])
		info.add_child(_kv("By type", ", ".join(breakdown)))

	info.add_child(HSeparator.new())

	# Rename field.
	var rename_lbl := Label.new()
	rename_lbl.text = "Name"
	rename_lbl.add_theme_font_size_override("font_size", 12)
	info.add_child(rename_lbl)
	var rename_edit := LineEdit.new()
	rename_edit.text = project.name
	rename_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rename_edit.text_submitted.connect(func(t: String): _rename_project(project, t))
	rename_edit.focus_exited.connect(func(): _rename_project(project, rename_edit.text))
	info.add_child(rename_edit)

	# Actions.
	var actions := HBoxContainer.new()
	actions.add_theme_constant_override("separation", 8)
	var open_btn := Button.new()
	open_btn.text = "Open"
	open_btn.pressed.connect(func(): open_project_requested.emit(project))
	actions.add_child(open_btn)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	actions.add_child(spacer)
	var del_btn := Button.new()
	del_btn.text = "Delete"
	del_btn.pressed.connect(func(): _confirm_delete_project(project))
	actions.add_child(del_btn)
	info.add_child(actions)

	return info

# A "label: value" row for the detail panel. Value wraps so long lists stay readable.
func _kv(key: String, value: String) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var k := Label.new()
	k.text = key
	k.custom_minimum_size.x = 90
	k.add_theme_color_override("font_color", Color(0.65, 0.65, 0.65))
	k.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	row.add_child(k)
	var v := Label.new()
	v.text = value
	v.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	v.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	row.add_child(v)
	return row

# Toggle which card is expanded — collapse if this one was already open, else select it.
func _toggle_project(project_name: String) -> void:
	_expanded_project_name = "" if _expanded_project_name == project_name else project_name
	_rebuild_projects()

# Rename via ProjectStore (moves the .tres + thumbnail on disk). No-op on
# empty/unchanged/collision. Keeps this card expanded under the new name.
func _rename_project(project: VoxelProject, new_name: String) -> void:
	var n := new_name.strip_edges()
	if n.is_empty() or n == project.name:
		return
	if ProjectStore.rename_project(VoxelWorld.workspace, project.name, n):
		_expanded_project_name = n
		VoxelWorld.workspace_changed.emit()

# Confirm-then-delete, replacing the old inline ✕. Drops the in-memory project + its
# on-disk file and thumbnail.
func _confirm_delete_project(project: VoxelProject) -> void:
	var dialog := ConfirmationDialog.new()
	dialog.title = "Delete Project"
	dialog.dialog_text = "Delete \"%s\"? This can't be undone." % project.name
	dialog.confirmed.connect(func():
		VoxelWorld.workspace.remove_project(project.name)
		ProjectStore.delete_project(project.name)  # also drop the on-disk file + thumbnail
		if _expanded_project_name == project.name:
			_expanded_project_name = ""
		VoxelWorld.workspace_changed.emit()
		dialog.queue_free())
	dialog.canceled.connect(func(): dialog.queue_free())
	get_tree().root.add_child(dialog)
	dialog.popup_centered()

# A fixed-size preview: the baked thumbnail texture when present, else the drawn voxyl
# logo. mouse_filter IGNORE so clicks fall through to the header toggle.
func _thumb_control(project: VoxelProject, dims: Vector2) -> Control:
	var tex := _card_thumb(project)
	if tex != null:
		var rect := TextureRect.new()
		rect.texture = tex
		rect.custom_minimum_size = dims
		rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		rect.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
		return rect
	var logo := Control.new()
	logo.custom_minimum_size = dims
	logo.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	logo.mouse_filter = Control.MOUSE_FILTER_IGNORE
	logo.draw.connect(func(): _draw_voxyl_logo(logo))
	return logo

# Load (and cache) a project's thumbnail texture, or null when none is baked yet. Keyed
# by path+mtime so a re-saved preview refreshes but repeated _refresh calls don't reload.
func _card_thumb(project: VoxelProject) -> Texture2D:
	var path := ProjectStore.thumbnail_path_for(project.name)
	if not FileAccess.file_exists(path):
		return null
	var mtime := FileAccess.get_modified_time(path)
	var cached: Dictionary = _thumb_cache.get(path, {})
	if cached.get("mtime", -1) == mtime:
		return cached["tex"]
	var img := Image.load_from_file(path)
	if img == null or img.is_empty():
		return null
	var tex := ImageTexture.create_from_image(img)
	_thumb_cache[path] = {"mtime": mtime, "tex": tex}
	return tex

# Absolute date/time, or "unknown" for legacy projects that predate timestamps.
func _format_date(unix: int) -> String:
	if unix <= 0:
		return "unknown"
	var d := Time.get_datetime_dict_from_unix_time(unix)
	return "%04d-%02d-%02d %02d:%02d" % [d.year, d.month, d.day, d.hour, d.minute]

# Coarse relative time for the header ("just now", "5m ago", "3d ago", or a date).
func _relative_time(unix: int) -> String:
	if unix <= 0:
		return "never"
	var secs := int(Time.get_unix_time_from_system()) - unix
	if secs < 60:
		return "just now"
	if secs < 3600:
		return "%dm ago" % floori(secs / 60.0)
	if secs < 86400:
		return "%dh ago" % floori(secs / 3600.0)
	if secs < 86400 * 7:
		return "%dd ago" % floori(secs / 86400.0)
	var d := Time.get_datetime_dict_from_unix_time(unix)
	return "%04d-%02d-%02d" % [d.year, d.month, d.day]

# "W × H × D" of the build's occupied bounds, or "empty" when nothing is placed.
func _dimensions_text(project: VoxelProject) -> String:
	if project.data == null:
		return "empty"
	var aabb := project.data.get_used_aabb()
	if aabb.is_empty():
		return "empty"
	var dim: Vector3i = aabb[1] - aabb[0] + Vector3i.ONE
	return "%d × %d × %d" % [dim.x, dim.y, dim.z]

func _draw_voxyl_logo(ctl: Control) -> void:
	var s: float = minf(ctl.size.x, ctl.size.y) / 14.0
	var ix := Vector2(s, s * 0.5); var iy := Vector2(0.0, -s); var iz := Vector2(-s, s * 0.5)
	var o := ctl.size * 0.5
	var p: Callable = func(x: float, y: float, z: float) -> Vector2: return o + ix * x + iy * y + iz * z

	# X arm — gray Base: top and front face
	ctl.draw_colored_polygon(PackedVector2Array([p.call(0,6,4), p.call(10,6,4), p.call(10,6,6), p.call(0,6,6)]), Color(0.80, 0.80, 0.80))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(0,4,6), p.call(10,4,6), p.call(10,6,6), p.call(0,6,6)]), Color(0.55, 0.55, 0.55))
	# Z arm — brick Highlight: top and right face
	ctl.draw_colored_polygon(PackedVector2Array([p.call(4,6,0), p.call(6,6,0), p.call(6,6,10), p.call(4,6,10)]), Color(0.88, 0.50, 0.38))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(6,4,0), p.call(6,4,10), p.call(6,6,10), p.call(6,6,0)]), Color(0.65, 0.33, 0.24))
	# Y arm — wood Accent: top, front, right (drawn last — tallest, always on top)
	ctl.draw_colored_polygon(PackedVector2Array([p.call(4,10,4), p.call(6,10,4), p.call(6,10,6), p.call(4,10,6)]), Color(0.90, 0.72, 0.45))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(4,0,6), p.call(6,0,6), p.call(6,10,6), p.call(4,10,6)]), Color(0.75, 0.58, 0.35))
	ctl.draw_colored_polygon(PackedVector2Array([p.call(6,0,4), p.call(6,0,6), p.call(6,10,6), p.call(6,10,4)]), Color(0.65, 0.50, 0.28))

func _on_new_project() -> void:
	var dialog := AcceptDialog.new()
	dialog.title = "New Project"
	var input := LineEdit.new()
	input.placeholder_text = "Project name..."
	input.set_custom_minimum_size(Vector2(260, 0))
	dialog.add_child(input)
	dialog.confirmed.connect(func():
		var n := input.text.strip_edges()
		if not n.is_empty() and not VoxelWorld.workspace.get_project(n):
			var project := VoxelWorld.workspace.add_project(n)
			project.palette_names.append("Default")  # start subscribed to the built-in palette
			ProjectStore.save_project(project)  # persist immediately so it survives a restart
			_expanded_project_name = n  # select the new project so its detail is open
			VoxelWorld.workspace_changed.emit()
		dialog.queue_free()
	)
	dialog.canceled.connect(func(): dialog.queue_free())
	get_tree().root.add_child(dialog)
	dialog.popup_centered()
	input.grab_focus()

# ---------------------------------------------------------------------------
# Palettes tab
# ---------------------------------------------------------------------------

func _build_palettes_tab() -> Control:
	var root := Control.new()
	root.name = "Palettes"

	var split := HSplitContainer.new()
	split.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.add_child(split)

	# Left: palette library
	var left := _margin(12)
	left.custom_minimum_size.x = 200
	split.add_child(left)

	_palettes_list = LibraryList.new()
	_palettes_list.list_title = "Palettes"
	_palettes_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_palettes_list.add_requested.connect(_on_add_palette)
	_palettes_list.delete_requested.connect(_on_delete_palette)
	_palettes_list.item_selected.connect(_on_palette_selected)
	left.add_child(_palettes_list)

	# Middle + right: entry grid and a detail panel for the selected entry — mirrors the
	# Block Types tab layout (grid + pinned-width detail).
	var inner := HSplitContainer.new()
	inner.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	split.add_child(inner)

	inner.add_child(_build_palette_middle())

	_entry_detail = _build_entry_detail()
	inner.add_child(_entry_detail)
	inner.resized.connect(func(): inner.split_offset = maxi(0, int(inner.size.x) - 332))

	return root

# Middle pane: a rebuilt header (title + collapsible library subscriptions + entries header)
# above a persistent icon grid of entries. The grid persists so switching palettes
# re-populates rather than recreating the icon baker.
func _build_palette_middle() -> Control:
	var root := _margin(12)
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	root.add_child(vbox)

	_palette_header = VBoxContainer.new()
	_palette_header.add_theme_constant_override("separation", 8)
	vbox.add_child(_palette_header)

	var placeholder := Label.new()
	placeholder.name = "Placeholder"
	placeholder.text = "Select a palette to edit it."
	_palette_header.add_child(placeholder)

	_palette_grid = BlockGrid.new()
	_palette_grid.show_captions = true
	_palette_grid.cell_size = Vector2(60, 60)
	_palette_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_palette_grid.item_selected.connect(_on_entry_selected)
	vbox.add_child(_palette_grid)

	return root

# The right detail panel for the selected entry: same styled fixed-width shell as the Block
# Types tab's _build_bt_detail, holding a scrollable vbox filled by _refresh_entry_detail.
func _build_entry_detail() -> Control:
	var panel := PanelContainer.new()
	panel.custom_minimum_size.x = 320
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.13, 0.13, 0.15)
	sb.content_margin_left = 16
	sb.content_margin_right = 16
	sb.content_margin_top = 16
	sb.content_margin_bottom = 16
	panel.add_theme_stylebox_override("panel", sb)

	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	panel.add_child(scroll)

	var vbox := VBoxContainer.new()
	vbox.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vbox.add_theme_constant_override("separation", 10)
	scroll.add_child(vbox)

	var placeholder := Label.new()
	placeholder.name = "Placeholder"
	placeholder.text = "Select an entry to edit it."
	vbox.add_child(placeholder)

	panel.set_meta("vbox", vbox)
	return panel

func _on_palette_selected(palette_name: String) -> void:
	var palette := VoxelWorld.workspace.get_palette(palette_name)
	if not palette:
		return
	_editing_palette = palette
	_selected_entry_semantic = ""
	_rebuild_palette_header()
	_refresh_palette_grid()
	_refresh_entry_detail()

# Rebuild the middle pane's header: title, the collapsible library-subscription section, and
# the "Entries" header with an add button. Kept separate from the grid so the grid persists.
func _rebuild_palette_header() -> void:
	if not _palette_header:
		return
	for c in _palette_header.get_children():
		c.queue_free()
	if not _editing_palette:
		var ph := Label.new()
		ph.name = "Placeholder"
		ph.text = "Select a palette to edit it."
		_palette_header.add_child(ph)
		return

	var title := Label.new()
	title.text = _editing_palette.name
	title.add_theme_font_size_override("font_size", 16)
	_palette_header.add_child(title)

	# Collapsible "Libraries" section: a toggle button shows/hides the subscription editor,
	# which is rebuilt by the existing _build_palette_libraries.
	var lib_body := VBoxContainer.new()
	lib_body.add_theme_constant_override("separation", 6)
	lib_body.visible = false
	var toggle := Button.new()
	toggle.toggle_mode = true
	toggle.flat = true
	toggle.alignment = HORIZONTAL_ALIGNMENT_LEFT
	toggle.text = "▸ Libraries"
	toggle.toggled.connect(func(on: bool):
		lib_body.visible = on
		toggle.text = ("▾ " if on else "▸ ") + "Libraries")
	_palette_header.add_child(toggle)
	_build_palette_libraries(lib_body, _editing_palette)
	_palette_header.add_child(lib_body)

	_palette_header.add_child(HSeparator.new())

	var entries_row := HBoxContainer.new()
	var entries_lbl := Label.new()
	entries_lbl.text = "Entries"
	entries_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	entries_row.add_child(entries_lbl)
	var add_btn := Button.new()
	add_btn.text = "Add entry"
	add_btn.pressed.connect(_on_add_entry)
	entries_row.add_child(add_btn)
	_palette_header.add_child(entries_row)

# Populate the entry grid: one cell per entry, its icon baked from the resolved block type
# (null → undecided placeholder) and its caption the semantic name.
func _refresh_palette_grid() -> void:
	if not _palette_grid:
		return
	if not _editing_palette:
		_palette_grid.populate_items([])
		return
	var items: Array = []
	for entry in _editing_palette.entries:
		var bt := VoxelWorld.workspace.resolve_block_type(entry.block_type_name, _editing_palette.library_names)
		var it := BlockGrid.Item.new()
		it.key = entry.semantic_name
		it.label = entry.semantic_name
		it.caption = entry.semantic_name
		it.block_type = bt
		it.placeholder_color = bt.color if bt else Color(0.35, 0.35, 0.35)
		items.append(it)
	_palette_grid.populate_items(items)
	_palette_grid.set_selected(_selected_entry_semantic)

func _on_entry_selected(key: String) -> void:
	_selected_entry_semantic = key
	if _palette_grid:
		_palette_grid.set_selected(key)
	_refresh_entry_detail()

# The detail panel for the selected entry: rename its semantic name + reassign its block type
# (via the reusable BlockPicker popup) + delete it.
func _refresh_entry_detail() -> void:
	if not _entry_detail:
		return
	var vbox: VBoxContainer = _entry_detail.get_meta("vbox")
	for c in vbox.get_children():
		c.queue_free()
	await get_tree().process_frame

	var entry := _editing_palette.get_entry(_selected_entry_semantic) if _editing_palette else null
	if not entry:
		var lbl := Label.new()
		lbl.name = "Placeholder"
		lbl.text = "Select an entry to edit it."
		vbox.add_child(lbl)
		return

	var name_lbl := Label.new()
	name_lbl.text = "Semantic name"
	vbox.add_child(name_lbl)
	var name_edit := LineEdit.new()
	name_edit.text = entry.semantic_name
	name_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_edit.text_submitted.connect(func(t): _rename_entry(entry, t))
	name_edit.focus_exited.connect(func(): _rename_entry(entry, name_edit.text))
	vbox.add_child(name_edit)

	vbox.add_child(HSeparator.new())

	var bt_lbl := Label.new()
	bt_lbl.text = "Block type"
	vbox.add_child(bt_lbl)

	var bt := VoxelWorld.workspace.resolve_block_type(entry.block_type_name, _editing_palette.library_names)
	var bt_row := HBoxContainer.new()
	bt_row.add_theme_constant_override("separation", 8)
	var swatch := ColorRect.new()
	swatch.custom_minimum_size = Vector2(28, 28)
	swatch.color = bt.color if bt else Color(0.35, 0.35, 0.35)
	swatch.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	bt_row.add_child(swatch)
	var bt_name := Label.new()
	bt_name.text = entry.block_type_name if not entry.block_type_name.is_empty() else "(undecided)"
	bt_name.clip_text = true
	bt_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	bt_name.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	bt_row.add_child(bt_name)
	var change_btn := Button.new()
	change_btn.text = "Change…"
	change_btn.pressed.connect(func(): _open_block_picker(entry))
	bt_row.add_child(change_btn)
	vbox.add_child(bt_row)

	vbox.add_child(HSeparator.new())

	var del_btn := Button.new()
	del_btn.text = "Delete entry"
	del_btn.pressed.connect(func():
		_editing_palette.entries.erase(entry)
		_selected_entry_semantic = ""
		_save_palettes()
		_refresh_palette_grid()
		_refresh_entry_detail())
	vbox.add_child(del_btn)

# Rename an entry's semantic name, guarding empty / collision with another entry. Keeps the
# grid selection on the new name.
func _rename_entry(entry: PaletteEntry, new_name: String) -> void:
	var n := new_name.strip_edges()
	if n.is_empty() or n == entry.semantic_name:
		return
	if _editing_palette.get_entry(n) != null:
		return   # another entry already owns this name
	entry.semantic_name = n
	_selected_entry_semantic = n
	_save_palettes()
	_refresh_palette_grid()
	_refresh_entry_detail()

# Open the reusable block picker scoped to this palette's libraries; the pick reassigns the
# entry's block type. Built from BlockGrid items so the picker stays generic.
func _open_block_picker(entry: PaletteEntry) -> void:
	var items: Array = []
	for n in _scoped_block_type_names(_editing_palette):
		var bt := VoxelWorld.workspace.resolve_block_type(n, _editing_palette.library_names)
		items.append(BlockGrid.block_item(bt) if bt else _unmapped_item(n))
	var picker := BlockPicker.new()
	picker.picked.connect(func(key: String):
		entry.block_type_name = key
		VoxelWorld.notify_block_type_changed()
		_save_palettes()
		_refresh_palette_grid()
		_refresh_entry_detail())
	get_tree().root.add_child(picker)
	picker.set_items(items, "Assign block type")
	picker.popup_centered()

# A picker item for a block-type name that doesn't resolve in scope (planning placeholder).
func _unmapped_item(bt_name: String) -> BlockGrid.Item:
	var it := BlockGrid.Item.new()
	it.key = bt_name
	it.label = bt_name
	it.caption = bt_name
	return it

# Append a new entry with a unique default name + empty block type, then select it so the
# user renames / assigns it in the detail panel.
func _on_add_entry() -> void:
	if not _editing_palette:
		return
	var e := PaletteEntry.new()
	e.semantic_name = _unique_semantic_name("New")
	_editing_palette.entries.append(e)
	_selected_entry_semantic = e.semantic_name
	_save_palettes()
	_refresh_palette_grid()
	_refresh_entry_detail()

# "New", "New 2", "New 3", … — the first that no existing entry uses.
func _unique_semantic_name(base: String) -> String:
	var candidate := base
	var i := 2
	while _editing_palette.get_entry(candidate) != null:
		candidate = "%s %d" % [base, i]
		i += 1
	return candidate

# The block-type names a palette can map to: every block in its subscribed libraries
# (in priority order), then the basic-library fallback, de-duplicated.
func _scoped_block_type_names(palette: Palette) -> Array:
	var seen := {}
	var names: Array = []
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
				names.append(bt.name)
	return names

# The palette's library-subscription editor: its ordered library_names (each with
# move-up / remove) plus an "add" picker of libraries it doesn't yet subscribe to.
# Editing it rescopes the entry pickers, so any change rebuilds the whole editor.
func _build_palette_libraries(vbox: VBoxContainer, palette: Palette) -> void:
	var lbl := Label.new()
	lbl.text = "Libraries (priority order, basic always applies last)"
	lbl.add_theme_font_size_override("font_size", 12)
	vbox.add_child(lbl)

	for i in palette.library_names.size():
		var idx := i
		var lib_name: String = palette.library_names[idx]
		var lrow := HBoxContainer.new()
		lrow.add_theme_constant_override("separation", 6)
		var nlbl := Label.new()
		nlbl.text = "%d. %s" % [idx + 1, lib_name]
		nlbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		lrow.add_child(nlbl)
		var up := Button.new()
		up.text = "↑"
		up.flat = true
		up.disabled = idx == 0
		up.pressed.connect(func():
			palette.library_names.remove_at(idx)
			palette.library_names.insert(idx - 1, lib_name)
			_save_palettes()
			_on_palette_selected(palette.name))
		lrow.add_child(up)
		var rem := Button.new()
		rem.text = "✕"
		rem.flat = true
		rem.pressed.connect(func():
			palette.library_names.remove_at(idx)
			_save_palettes()
			_on_palette_selected(palette.name))
		lrow.add_child(rem)
		vbox.add_child(lrow)

	# Add-library picker: libraries not already subscribed (basic is implicit, skip it).
	var available: Array = []
	for n in VoxelWorld.workspace.list_libraries():
		if n != VoxelWorkspace.BASIC_LIBRARY and n not in palette.library_names:
			available.append(n)
	if available.is_empty():
		return
	var add_row := HBoxContainer.new()
	add_row.add_theme_constant_override("separation", 6)
	var picker := OptionButton.new()
	picker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	for n in available:
		picker.add_item(n)
	add_row.add_child(picker)
	var add_btn := Button.new()
	add_btn.text = "Add library"
	add_btn.pressed.connect(func():
		if picker.selected < 0:
			return
		palette.library_names.append(available[picker.selected])
		_save_palettes()
		_on_palette_selected(palette.name))
	add_row.add_child(add_btn)
	vbox.add_child(add_row)

func _save_palettes() -> void:
	LibraryStore.save_palettes(VoxelWorld.workspace)

func _on_add_palette(palette_name: String) -> void:
	if not VoxelWorld.workspace.get_palette(palette_name):
		VoxelWorld.workspace.add_palette(palette_name)
		_save_palettes()
		VoxelWorld.workspace_changed.emit()

func _on_delete_palette(palette_name: String) -> void:
	VoxelWorld.workspace.remove_palette(palette_name)
	_save_palettes()
	VoxelWorld.workspace_changed.emit()

# ---------------------------------------------------------------------------
# Block Types tab
# ---------------------------------------------------------------------------

func _build_block_types_tab() -> Control:
	var root := Control.new()
	root.name = "Libraries"

	# Library-scoped layout: [library rail | grid | detail]. Selecting a library in the
	# rail is the management context — the grid + actions all act on that one library.
	var split := HSplitContainer.new()
	split.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.add_child(split)

	# Far left: the library rail (create/rename/delete; rename+delete no-op for basic).
	var rail_box := _margin(12)
	rail_box.custom_minimum_size.x = 180
	split.add_child(rail_box)
	_library_rail = LibraryList.new()
	_library_rail.list_title = "Libraries"
	_library_rail.allow_rename = true
	_library_rail.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_library_rail.add_requested.connect(_on_add_library)
	_library_rail.delete_requested.connect(_on_delete_library)
	_library_rail.rename_requested.connect(_on_rename_library)
	_library_rail.item_selected.connect(_on_library_selected)
	rail_box.add_child(_library_rail)
	split.split_offset = 180

	var inner := HSplitContainer.new()
	inner.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	split.add_child(inner)

	# Middle (main): action header + the JEI-style icon grid.
	var right := _margin(12)
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	inner.add_child(right)

	var rvbox := VBoxContainer.new()
	rvbox.add_theme_constant_override("separation", 8)
	right.add_child(rvbox)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	rvbox.add_child(header)

	var new_btn := Button.new()
	new_btn.text = "New block…"
	new_btn.pressed.connect(_on_new_block)
	header.add_child(new_btn)

	# Import blocks from the user's own MC assets — they land in this same grid.
	var import_btn := Button.new()
	import_btn.text = "Add blocks…"
	import_btn.pressed.connect(_on_import_blocks)
	header.add_child(import_btn)

	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(spacer)

	# Jump to the selected library's folder on disk.
	var folder_btn := Button.new()
	folder_btn.text = "Open folder"
	folder_btn.tooltip_text = "Reveal this library's folder in your file browser"
	folder_btn.pressed.connect(_on_open_library_folder)
	header.add_child(folder_btn)

	_block_grid = BlockGrid.new()
	_block_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_block_grid.block_selected.connect(_on_block_type_selected)
	rvbox.add_child(_block_grid)

	# Right: detail / edit panel for the selected block (3D preview + fields). Pinned to
	# a fixed width on the right so the divider doesn't drift as blocks are selected; the
	# resized hook keeps it there as the window (or the rail divider) resizes.
	_bt_detail = _build_bt_detail()
	inner.add_child(_bt_detail)
	inner.resized.connect(func(): inner.split_offset = maxi(0, int(inner.size.x) - 352))

	return root

# ---------------------------------------------------------------------------
# Library rail (Block Types tab)
# ---------------------------------------------------------------------------

func _on_add_library(library_name: String) -> void:
	if VoxelWorld.workspace.get_library(library_name) != null:
		return
	VoxelWorld.workspace.get_or_add_library(library_name)
	LibraryStore.save_library(VoxelWorld.workspace.get_library(library_name))
	_selected_library = VoxelWorld.workspace.get_library(library_name)
	_library_rail.selected = library_name
	VoxelWorld.workspace_changed.emit()

func _on_delete_library(library_name: String) -> void:
	var lib := VoxelWorld.workspace.get_library(library_name)
	if lib == null or lib.builtin:
		return   # the basic floor is undeletable
	VoxelWorld.workspace.remove_library(library_name)
	# Also remove the on-disk folder, or load_persisted re-finds it on the next launch and
	# the library comes back (the "ghost library that won't delete" bug).
	LibraryStore.delete_library(library_name)
	if _selected_library == lib:
		_selected_library = null
	VoxelWorld.workspace_changed.emit()

func _on_library_selected(library_name: String) -> void:
	_selected_library = VoxelWorld.workspace.get_library(library_name)
	_selected_block_type = ""
	if _block_grid:
		_block_grid.populate(_selected_library.sorted_block_types() if _selected_library else [])
	_refresh_bt_detail()

# Rename a library: prompt for a new name, then move it on disk + repoint palettes via
# LibraryStore. The basic floor is undeletable/unrenamable, so its ✎ no-ops.
func _on_rename_library(library_name: String) -> void:
	var lib := VoxelWorld.workspace.get_library(library_name)
	if lib == null or lib.builtin:
		return
	var dialog := AcceptDialog.new()
	dialog.title = "Rename Library"
	var input := LineEdit.new()
	input.text = library_name
	input.placeholder_text = "Library name…"
	input.custom_minimum_size = Vector2(260, 0)
	dialog.add_child(input)
	dialog.confirmed.connect(func():
		if LibraryStore.rename_library(VoxelWorld.workspace, library_name, input.text):
			if _selected_library == lib:
				_selected_library = lib   # same instance, new name
			VoxelWorld.workspace_changed.emit()
		dialog.queue_free())
	dialog.canceled.connect(func(): dialog.queue_free())
	get_tree().root.add_child(dialog)
	dialog.popup_centered()
	input.grab_focus()
	input.select_all()

# Reveal the selected library's folder in the OS file browser. Persist first so the
# folder exists even for a library that's only been created in memory.
func _on_open_library_folder() -> void:
	if _selected_library == null:
		return
	LibraryStore.save_library(_selected_library)
	OS.shell_open(ProjectSettings.globalize_path(AssetLibrary.path_for(_selected_library.name)))

# Pick a sensible selected library after a refresh: keep the current one if it still
# exists, else fall back to the first library (basic on a fresh install).
func _ensure_selected_library() -> void:
	if _selected_library != null and VoxelWorld.workspace.get_library(_selected_library.name) != null:
		return
	_selected_library = VoxelWorld.workspace.libraries[0] if not VoxelWorld.workspace.libraries.is_empty() else null

# The left detail panel shell: a styled PanelContainer (its background makes the
# split seam visible) at a fixed width, holding a scrollable vbox. The fixed width +
# clipped labels keep the divider from shifting as different blocks are selected.
# _refresh_bt_detail fills the vbox, which is stashed in meta so the rebuild finds it.
func _build_bt_detail() -> Control:
	var panel := PanelContainer.new()
	panel.custom_minimum_size.x = 340
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.13, 0.13, 0.15)
	sb.content_margin_left = 16
	sb.content_margin_right = 16
	sb.content_margin_top = 16
	sb.content_margin_bottom = 16
	panel.add_theme_stylebox_override("panel", sb)

	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	panel.add_child(scroll)

	var vbox := VBoxContainer.new()
	vbox.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vbox.add_theme_constant_override("separation", 10)
	scroll.add_child(vbox)

	var placeholder := Label.new()
	placeholder.name = "Placeholder"
	placeholder.text = "Select a block to edit it."
	vbox.add_child(placeholder)

	panel.set_meta("vbox", vbox)
	return panel

func _on_block_type_selected(bt_name: String) -> void:
	_selected_block_type = bt_name
	if _block_grid:
		_block_grid.set_selected(bt_name)
	_refresh_bt_detail()

func _refresh_bt_detail() -> void:
	if not _bt_detail:
		return
	var vbox: VBoxContainer = _bt_detail.get_meta("vbox")
	for c in vbox.get_children():
		c.queue_free()
	_bt_preview = null
	await get_tree().process_frame

	var bt := _selected_library.get_block_type(_selected_block_type) if _selected_library else null
	if not bt:
		var lbl := Label.new()
		lbl.name = "Placeholder"
		lbl.text = "Select a block to edit it."
		vbox.add_child(lbl)
		return

	# Name is read-only: palette entries reference block types by name, so renaming
	# would silently break those refs (rename is intentionally out of scope).
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	var name_lbl := Label.new()
	name_lbl.text = bt.name
	name_lbl.add_theme_font_size_override("font_size", 16)
	name_lbl.clip_text = true
	name_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	header.add_child(name_lbl)
	var files_btn := Button.new()
	files_btn.text = "Open folder"
	files_btn.tooltip_text = "Reveal this block in the library in your file browser"
	files_btn.pressed.connect(func(): _on_open_in_files(bt))
	header.add_child(files_btn)
	vbox.add_child(header)

	# Live, rotatable 3D render of the block.
	_bt_preview = BlockPreview3D.new()
	_bt_preview.custom_minimum_size = Vector2(0, 280)
	_bt_preview.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vbox.add_child(_bt_preview)
	_bt_preview.set_block(bt)

	vbox.add_child(_labeled_picker("Color", bt.color, func(c: Color):
		bt.color = c
		_after_block_edit(bt)))

	vbox.add_child(_labeled_picker("Tint", bt.tint, func(c: Color):
		bt.tint = c
		_after_block_edit(bt)))

	var shape_row := HBoxContainer.new()
	var shape_lbl := Label.new()
	shape_lbl.text = "Shape"
	shape_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	shape_row.add_child(shape_lbl)
	var shape_opt := OptionButton.new()
	for s in ["Full", "Slab", "Stairs"]:
		shape_opt.add_item(s)
	shape_opt.selected = int(bt.shape)
	shape_opt.item_selected.connect(func(idx: int):
		bt.shape = idx as BlockType.Shape
		_after_block_edit(bt))
	shape_row.add_child(shape_opt)
	vbox.add_child(shape_row)

	vbox.add_child(HSeparator.new())

	var tex_header := Label.new()
	tex_header.text = "Textures"
	vbox.add_child(tex_header)
	_build_texture_bindings(vbox, bt)

	vbox.add_child(HSeparator.new())

	var del_btn := Button.new()
	del_btn.text = "Delete block"
	del_btn.pressed.connect(func(): _on_delete_block_type(bt.name))
	vbox.add_child(del_btn)

# A "<caption> [color]" row whose ColorPickerButton invokes `on_change(Color)`.
func _labeled_picker(caption: String, value: Color, on_change: Callable) -> HBoxContainer:
	var row := HBoxContainer.new()
	var lbl := Label.new()
	lbl.text = caption
	lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(lbl)
	var btn := ColorPickerButton.new()
	btn.color = value
	btn.custom_minimum_size = Vector2(90, 0)
	btn.color_changed.connect(on_change)
	row.add_child(btn)
	return row

# Texture-binding rows for the block's model. A block with no explicit (textured)
# model gets a "Set texture…" action that creates a full-cube model; one with bound
# keys lists each with a swatch + "Replace…".
func _build_texture_bindings(vbox: VBoxContainer, bt: BlockType) -> void:
	var model := _editable_model(bt)
	if model == null or not model.has_textures():
		var set_btn := Button.new()
		set_btn.text = "Set texture…"
		set_btn.pressed.connect(func(): _on_set_texture(bt))
		vbox.add_child(set_btn)
		return
	for key in model.textures:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 8)
		row.add_child(_texture_swatch(model.textures[key]))
		var klbl := Label.new()
		klbl.text = key
		klbl.tooltip_text = key
		klbl.clip_text = true
		klbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		klbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(klbl)
		var rep := Button.new()
		rep.text = "Replace…"
		rep.pressed.connect(func(): _on_replace_texture(bt, model, key))
		row.add_child(rep)
		vbox.add_child(row)

# A 32×32 preview of a bound texture: the image itself (NEAREST) when loadable, else
# a flat swatch of its planning average color.
func _texture_swatch(asset_id: String) -> Control:
	var asset := VoxelWorld.workspace.get_texture_asset(asset_id)
	if asset != null and not asset.image_path.is_empty():
		var img := BlockTextureCache.cached_texture(asset.image_path)
		if img != null:
			var swatch := TextureRect.new()
			swatch.texture = img
			swatch.custom_minimum_size = Vector2(32, 32)
			swatch.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
			swatch.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			return swatch
	var rect := ColorRect.new()
	rect.color = asset.average_color if asset != null else Color(0.5, 0.5, 0.5)
	rect.custom_minimum_size = Vector2(32, 32)
	return rect

# The block's own editable model (explicit model_id), or null for a built-in shape
# (no model to edit yet — the "Set texture…" path creates one). Scoped to the selected
# library so editing acts on that library's model.
func _editable_model(bt: BlockType) -> BlockModel:
	if bt.model_id.is_empty() or _selected_library == null:
		return null
	return _selected_library.get_block_model(bt.model_id)

func _on_set_texture(bt: BlockType) -> void:
	if _selected_library == null:
		return
	_pick_png(func(path: String):
		var lib := _selected_library
		var asset := TextureIngest.ingest_file(lib, path, "custom:%s/all" % bt.name)
		if asset == null:
			return
		var model := lib.get_block_model("custom:%s" % bt.name)
		if model == null:
			model = BlockModel.new()
			model.id = "custom:%s" % bt.name
			lib.add_block_model(model)
		model.elements = [BlockModel.box_element(Vector3.ZERO, Vector3.ONE, "all")]
		model.textures = {"all": asset.id}
		bt.model_id = model.id
		bt.color = asset.average_color
		_after_block_edit(bt)
		_refresh_bt_detail())

# Rebind one texture key to a freshly ingested PNG. The new asset gets a per-block id
# so replacing never clobbers a shared imported texture's pixels.
func _on_replace_texture(bt: BlockType, model: BlockModel, key: String) -> void:
	if _selected_library == null:
		return
	_pick_png(func(path: String):
		var asset := TextureIngest.ingest_file(_selected_library, path, "custom:%s/%s" % [bt.name, key])
		if asset == null:
			return
		model.textures[key] = asset.id
		_after_block_edit(bt)
		_refresh_bt_detail())

# Common post-edit: notify views, refresh this block's preview + grid icon, persist the
# block's library.
func _after_block_edit(bt: BlockType) -> void:
	VoxelWorld.notify_block_type_changed()
	if _bt_preview:
		_bt_preview.set_block(bt)
	if _block_grid:
		_block_grid.refresh_icons(bt.name)
	if _selected_library:
		LibraryStore.save_library(_selected_library)

func _on_new_block() -> void:
	var dlg := NewBlockDialog.new()
	dlg.submitted.connect(_create_block)
	get_tree().root.add_child(dlg)
	dlg.popup_centered()

# Build a new block type from the dialog's picks. Textures are optional: with none,
# the block is a gray full cube (the "build before you decide" path); with an "all"
# texture and optional Top/Bottom, a full-cube BlockModel is bound to those keys.
func _create_block(block_name: String, all_path: String, top_path: String, bottom_path: String) -> void:
	var lib := _selected_library
	if lib == null or lib.get_block_type(block_name) != null:
		return
	var bt := lib.add_block_type(block_name)
	var all_asset := _ingest_opt(lib, all_path, block_name, "all")
	var top_asset := _ingest_opt(lib, top_path, block_name, "top")
	var bottom_asset := _ingest_opt(lib, bottom_path, block_name, "bottom")
	if all_asset != null or top_asset != null or bottom_asset != null:
		var model := BlockModel.new()
		model.id = "custom:%s" % block_name
		var elem := BlockModel.box_element(Vector3.ZERO, Vector3.ONE, "all")
		model.textures = {}
		if all_asset != null:
			model.textures["all"] = all_asset.id
		if top_asset != null:
			model.textures["top"] = top_asset.id
			elem["faces"][BlockModel.Dir.UP] = BlockModel.make_face("top")
		if bottom_asset != null:
			model.textures["bottom"] = bottom_asset.id
			elem["faces"][BlockModel.Dir.DOWN] = BlockModel.make_face("bottom")
		model.elements = [elem]
		lib.add_block_model(model)
		bt.model_id = model.id
		var primary := all_asset if all_asset != null else (top_asset if top_asset != null else bottom_asset)
		bt.color = primary.average_color
	LibraryStore.save_library(lib)
	VoxelWorld.workspace_changed.emit()
	_selected_block_type = block_name
	if _block_grid:
		_block_grid.set_selected(block_name)
	_refresh_bt_detail()

# Ingest an optional PNG under a per-block/key id; null when no path was chosen.
func _ingest_opt(lib: BlockLibrary, path: String, block_name: String, key: String) -> TextureAsset:
	if path.is_empty():
		return null
	return TextureIngest.ingest_file(lib, path, "custom:%s/%s" % [block_name, key])

func _on_import_blocks() -> void:
	var panel := ImportPanel.new()
	# Default the import target to the Block Types tab's selected library (never basic);
	# the panel still lets the user pick or create another.
	if _selected_library != null and not _selected_library.builtin:
		panel.default_library = _selected_library.name
	get_tree().root.add_child(panel)
	panel.popup_centered()

# Reveal the block's saved resource in the OS file browser. Persists first so the
# .tres exists, then highlights it (falling back to the library root if needed). The
# block lives under its library's folder.
func _on_open_in_files(bt: BlockType) -> void:
	if _selected_library == null:
		return
	LibraryStore.save_library(_selected_library)
	var rel := AssetLibrary.in_library(_selected_library.name, AssetLibrary.BLOCK_TYPES_DIR) \
		.path_join(bt.name.validate_filename() + ".tres")
	var abs_path := ProjectSettings.globalize_path(AssetLibrary.path_for(rel))
	if FileAccess.file_exists(abs_path):
		OS.shell_show_in_file_manager(abs_path)
	else:
		OS.shell_open(ProjectSettings.globalize_path(AssetLibrary.path_for(_selected_library.name)))

func _on_delete_block_type(block_name: String) -> void:
	if _selected_library == null:
		return
	_selected_library.remove_block_type(block_name)
	if _selected_block_type == block_name:
		_selected_block_type = ""
	LibraryStore.save_library(_selected_library)
	VoxelWorld.workspace_changed.emit()
	_refresh_bt_detail()

# Pick a PNG from the OS filesystem and hand its path to `on_pick`.
func _pick_png(on_pick: Callable) -> void:
	var fd := FileDialog.new()
	fd.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	fd.access = FileDialog.ACCESS_FILESYSTEM
	fd.filters = PackedStringArray(["*.png ; PNG Images"])
	fd.use_native_dialog = true
	fd.file_selected.connect(func(p: String):
		on_pick.call(p)
		fd.queue_free())
	fd.canceled.connect(fd.queue_free)
	get_tree().root.add_child(fd)
	fd.popup_centered(Vector2i(720, 500))

# ---------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------

func _refresh(_arg = null) -> void:
	if _projects_container:
		_rebuild_projects()
	if _palettes_list:
		_palettes_list.populate(VoxelWorld.workspace.palettes.map(func(p): return p.name))
	_ensure_selected_library()
	if _library_rail:
		_library_rail.selected = _selected_library.name if _selected_library else ""
		_library_rail.populate(VoxelWorld.workspace.list_libraries())
	if _block_grid:
		_block_grid.populate(_selected_library.sorted_block_types() if _selected_library else [])

func _margin(px: int) -> MarginContainer:
	var m := MarginContainer.new()
	for side in ["left", "right", "top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, px)
	return m
