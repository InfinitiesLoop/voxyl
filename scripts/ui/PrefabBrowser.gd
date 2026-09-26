class_name PrefabBrowser
extends MarginContainer

# Home → Prefabs: every prefab in the workspace as a thumbnail grid (searchable by name, tags
# and notes), and the selected one's details beside it — a live 3D preview through its
# preferred palettes, rename, tags, notes, its handle, its preferred palette stack, and
# delete. A pure lens on VoxelWorld's prefabs: every change goes through VoxelWorld, so the
# inventory's Prefabs page and agents see it at once.

const _THUMB_PX := 128
const _DETAIL_W := 380

var _grid: BlockGrid
var _empty_label: Label
var _detail: VBoxContainer
var _preview: PrefabPreview
var _preview_hint: Label
var _selected := ""

func _ready() -> void:
	name = "Prefabs"
	for side in ["margin_left", "margin_right", "margin_top", "margin_bottom"]:
		add_theme_constant_override(side, 16)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 16)
	add_child(row)

	# Left: the big live preview on top, the prefab grid under it (drag the divider to trade).
	var left := VSplitContainer.new()
	left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(left)
	var top := PanelContainer.new()
	top.size_flags_vertical = Control.SIZE_EXPAND_FILL
	top.size_flags_stretch_ratio = 1.4
	left.add_child(top)
	_preview = PrefabPreview.new()
	_preview.custom_minimum_size = Vector2(0, 240)
	_preview.visible = false
	top.add_child(_preview)
	_preview_hint = Label.new()
	_preview_hint.text = "Select a prefab to see it in 3D.\nDrag to turn · wheel to zoom · shown through its preferred palettes."
	_preview_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_preview_hint.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_preview_hint.modulate = Color(1, 1, 1, 0.55)
	top.add_child(_preview_hint)

	var bottom := VBoxContainer.new()
	bottom.size_flags_vertical = Control.SIZE_EXPAND_FILL
	bottom.add_theme_constant_override("separation", 6)
	left.add_child(bottom)
	_empty_label = Label.new()
	_empty_label.text = "No prefabs yet. In the editor, select a region with the Select tool, then press Ctrl+P (or \"Save as prefab…\" in the selection panel)."
	_empty_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_empty_label.modulate = Color(1, 1, 1, 0.6)
	bottom.add_child(_empty_label)
	_grid = BlockGrid.new()
	_grid.show_captions = true
	_grid.cell_size = Vector2(90, 90)
	_grid.search_placeholder = "Search prefabs (name, tags, notes)…"
	_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_grid.item_selected.connect(_select)
	_grid.item_right_clicked.connect(_on_right_click)
	bottom.add_child(_grid)

	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(_DETAIL_W, 0)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	row.add_child(scroll)
	_detail = VBoxContainer.new()
	_detail.custom_minimum_size = Vector2(_DETAIL_W - 16, 0)
	_detail.add_theme_constant_override("separation", 8)
	scroll.add_child(_detail)

	VoxelWorld.prefabs_changed.connect(_refresh)
	VoxelWorld.workspace_changed.connect(_refresh)
	visibility_changed.connect(func(): if is_visible_in_tree(): _refresh())
	_refresh()

func _refresh() -> void:
	if _grid == null:
		return
	var list := VoxelWorld.workspace.prefabs.duplicate()
	list.sort_custom(func(a: Prefab, b: Prefab) -> bool: return a.name.naturalnocasecmp_to(b.name) < 0)
	var items: Array = []
	for p: Prefab in list:
		var it := BlockGrid.Item.new()
		it.key = p.name
		it.caption = p.name
		it.label = "%s — %d×%d×%d, %d cells" % [p.name, p.size.x, p.size.y, p.size.z, p.cell_count()]
		it.search_text = "%s %s %s" % [p.name, " ".join(p.tags), p.notes]
		it.texture = PrefabThumbs.texture_for(p, _THUMB_PX)
		it.placeholder_color = Color(0.4, 0.45, 0.55)
		items.append(it)
	_grid.populate_items(items)
	_empty_label.visible = items.is_empty()
	if VoxelWorld.workspace.get_prefab(_selected) == null:
		_selected = ""
	_grid.set_selected(_selected)
	_rebuild_detail()

func _select(key: String) -> void:
	_selected = key
	_rebuild_detail()

func _on_right_click(key: String, global_pos: Vector2) -> void:
	var p := VoxelWorld.workspace.get_prefab(key)
	if p == null:
		return
	var menu := PopupMenu.new()
	menu.add_item("Delete…", 0)
	menu.id_pressed.connect(func(_id: int): _confirm_delete(p))
	menu.popup_hide.connect(menu.queue_free)
	add_child(menu)
	menu.popup(Rect2i(Vector2i(global_pos), Vector2i.ZERO))

func _rebuild_detail() -> void:
	for c in _detail.get_children():
		c.queue_free()
	var p := VoxelWorld.workspace.get_prefab(_selected)
	_preview.visible = p != null
	_preview_hint.visible = p == null
	if p == null:
		var hint := Label.new()
		hint.text = "Select a prefab to see it in 3D and edit its details.\n\nTo place one, open a project and press E: the inventory has a Prefabs page."
		hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		hint.modulate = Color(1, 1, 1, 0.6)
		_detail.add_child(hint)
		return
	_preview.show_prefab(p)

	var edit := Button.new()
	edit.text = "Edit in the editor"
	edit.tooltip_text = "Open its cells like a project: build, undo, cut away… Leaving the editor saves them back into the prefab."
	edit.pressed.connect(func(): VoxelWorld.request_open_project(VoxelWorld.open_prefab_for_editing(p)))
	_detail.add_child(edit)

	var export_btn := Button.new()
	export_btn.text = "Export to Schematica…"
	export_btn.tooltip_text = "Write this prefab out as a real .schematic file (blocks/parts with a confirmed Minecraft identity only)"
	export_btn.pressed.connect(func(): SaveRegionDialog.open_export_prefab(self, p))
	_detail.add_child(export_btn)

	_detail.add_child(_caption("Name"))
	var name_edit := LineEdit.new()
	name_edit.text = p.name
	var commit_name := func(t: String) -> void:
		if t.strip_edges() != p.name:
			var err := VoxelWorld.update_prefab(p, {"name": t})
			if err.is_empty():
				_selected = p.name
			else:
				name_edit.text = p.name
	name_edit.text_submitted.connect(commit_name)
	name_edit.focus_exited.connect(func(): commit_name.call(name_edit.text))
	_detail.add_child(name_edit)

	var s := p.size
	_detail.add_child(_kv("Size", "%d × %d × %d  ·  %d cells" % [s.x, s.y, s.z, p.cell_count()]))
	_detail.add_child(_kv("Saved", Time.get_datetime_string_from_unix_time(p.modified_at, true) if p.modified_at > 0 else "unknown"))

	_detail.add_child(_caption("Handle (lands on your aim when placing; turns pivot about it)"))
	var anchor_pick := OptionButton.new()
	anchor_pick.add_item("Bottom corner (min x, y, z)", 0)
	anchor_pick.add_item("Bottom center", 1)
	if p.anchor == Vector3i.ZERO:
		anchor_pick.select(0)
	elif p.anchor == p.bottom_center():
		anchor_pick.select(1)
	else:
		anchor_pick.add_item("Custom %s" % str(p.anchor), 2)
		anchor_pick.select(2)
	anchor_pick.item_selected.connect(func(i: int):
		var id := anchor_pick.get_item_id(i)
		if id == 0:
			VoxelWorld.update_prefab(p, {"anchor": Vector3i.ZERO})
		elif id == 1:
			VoxelWorld.update_prefab(p, {"anchor": p.bottom_center()}))
	_detail.add_child(anchor_pick)

	_detail.add_child(_caption("Tags (comma separated)"))
	var tags_edit := LineEdit.new()
	tags_edit.text = ", ".join(p.tags)
	var commit_tags := func(t: String) -> void:
		var tags := Array(t.split(",", false))
		if ", ".join(tags.map(func(x: String) -> String: return x.strip_edges())) != ", ".join(p.tags):
			VoxelWorld.update_prefab(p, {"tags": tags})
	tags_edit.text_submitted.connect(commit_tags)
	tags_edit.focus_exited.connect(func(): commit_tags.call(tags_edit.text))
	_detail.add_child(tags_edit)

	_detail.add_child(_caption("Notes"))
	var notes := TextEdit.new()
	notes.text = p.notes
	notes.custom_minimum_size = Vector2(0, 64)
	notes.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	notes.focus_exited.connect(func():
		if notes.text != p.notes:
			VoxelWorld.update_prefab(p, {"notes": notes.text}))
	_detail.add_child(notes)

	_detail.add_child(HSeparator.new())
	_build_palettes(p)

	_detail.add_child(HSeparator.new())
	_detail.add_child(_caption("Semantics"))
	var counts := p.semantic_counts()
	var names := counts.keys()
	names.sort_custom(func(a, b): return counts[a] > counts[b] if counts[a] != counts[b] else str(a) < str(b))
	for sem in names:
		_detail.add_child(_kv(str(sem), "×%d" % counts[sem]))

	_detail.add_child(HSeparator.new())
	var del := Button.new()
	del.text = "Delete prefab…"
	del.pressed.connect(func(): _confirm_delete(p))
	_detail.add_child(del)

# The preferred palette stack (bottom → top, the last wins): reorder, remove, add. It only
# changes how the prefab previews and which palettes it offers where it's placed.
func _build_palettes(p: Prefab) -> void:
	_detail.add_child(_caption("Preferred palettes (bottom → top, the last wins). Used for its previews, and offered when a project placing it lacks its semantics."))
	for i in p.palette_names.size():
		var idx := i
		var pn: String = p.palette_names[idx]
		var row := HBoxContainer.new()
		var lbl := Label.new()
		lbl.text = "%d. %s%s" % [idx + 1, pn, "" if VoxelWorld.workspace.get_palette(pn) != null else "  (missing)"]
		lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(lbl)
		var up := Button.new()
		up.text = "↑"
		up.flat = true
		up.disabled = idx == 0
		up.pressed.connect(func():
			var names := Array(p.palette_names)
			names.insert(idx - 1, names.pop_at(idx))
			VoxelWorld.update_prefab(p, {"palettes": names}))
		row.add_child(up)
		var rm := Button.new()
		rm.text = "✕"
		rm.flat = true
		rm.pressed.connect(func():
			var names := Array(p.palette_names)
			names.remove_at(idx)
			VoxelWorld.update_prefab(p, {"palettes": names}))
		row.add_child(rm)
		_detail.add_child(row)
	var available: Array = []
	for pal in VoxelWorld.workspace.palettes:
		if not p.palette_names.has(pal.name):
			available.append(pal.name)
	if not available.is_empty():
		var add := Button.new()
		add.text = "+ Add palette"
		add.pressed.connect(func():
			var picker := SearchablePicker.new()
			get_tree().root.add_child(picker)
			picker.configure(available)
			picker.picked.connect(func(pn: String):
				var names := Array(p.palette_names)
				names.append(pn)
				VoxelWorld.update_prefab(p, {"palettes": names}))
			picker.popup_centered(Vector2i(300, 380)))
		_detail.add_child(add)

func _confirm_delete(p: Prefab) -> void:
	var d := ConfirmationDialog.new()
	d.title = "Delete prefab"
	d.dialog_text = "Delete \"%s\"? Copies already placed in projects stay." % p.name
	d.confirmed.connect(func():
		VoxelWorld.delete_prefab(p)
		d.queue_free())
	d.canceled.connect(d.queue_free)
	get_tree().root.add_child(d)
	d.popup_centered()

func _caption(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 12)
	l.modulate = Color(1, 1, 1, 0.65)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return l

func _note(text: String) -> Label:
	var l := _caption(text)
	l.add_theme_font_size_override("font_size", 11)
	return l

func _kv(key: String, value: String) -> Control:
	var row := HBoxContainer.new()
	var k := Label.new()
	k.text = key
	k.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	k.modulate = Color(1, 1, 1, 0.7)
	k.clip_text = true
	row.add_child(k)
	var v := Label.new()
	v.text = value
	row.add_child(v)
	return row

