class_name SaveRegionDialog
extends ConfirmationDialog

# Two spiritually-identical jobs share this dialog, because both are "take a region, let the
# user preview it turning in 3D, decide which semantics to leave out, then commit it
# somewhere":
#   - "Save selection as prefab…" (Ctrl+P, or the Select tool's overlay): name the selected
#     region, pick its handle, tag it, save it into the workspace.
#   - "Export to Schematica…" (the same overlay, or a saved prefab's own detail panel):
#     write the kept cells out as a real .schematic file on disk, via SchematicaExporter.
# The preview and the include/exclude/trim controls are identical either way; only the
# prefab-only fields (name/handle/tags) and the final commit step differ by `_mode`.
#
# Saving over an existing prefab name asks first (the button turns into Replace).

enum DialogMode { SAVE_PREFAB, EXPORT }

var _mode: DialogMode = DialogMode.SAVE_PREFAB
var _data: VoxelData
var _mn: Vector3i
var _mx: Vector3i
# Set only when exporting an already-saved prefab (as opposed to a live selection): its own
# preferred palette stack previews and resolves the export, not the open project's.
var _source_prefab: Prefab

var _name_edit: LineEdit
var _anchor_pick: OptionButton
var _tags_edit: LineEdit
var _info: Label
var _warn: Label
var _checks := {}          # semantic -> CheckBox
var _trim_check: CheckBox
var _trim_touched := false # the user set trim themselves: stop auto-setting it
var _preview: PrefabPreview
var _preview_key := ""

# Open for the current selection, to save it into the workspace as a named prefab. Without a
# project or a selection it says what's needed.
static func open(host: Node) -> void:
	if not _require_selection(host):
		return
	var d := SaveRegionDialog.new()
	d._mode = DialogMode.SAVE_PREFAB
	d._data = VoxelWorld.active_project.data
	d._mn = VoxelWorld.selection_min
	d._mx = VoxelWorld.selection_max
	host.get_tree().root.add_child(d)
	d._start()

# Open for the current selection, to write it out as a .schematic file.
static func open_export_region(host: Node) -> void:
	if not _require_selection(host):
		return
	var d := SaveRegionDialog.new()
	d._mode = DialogMode.EXPORT
	d._data = VoxelWorld.active_project.data
	d._mn = VoxelWorld.selection_min
	d._mx = VoxelWorld.selection_max
	host.get_tree().root.add_child(d)
	d._start()

# Open for an already-saved prefab, to write it out as a .schematic file. Its own cells and
# preferred palette stack drive the preview and the export — no open project needed.
static func open_export_prefab(host: Node, prefab: Prefab) -> void:
	var d := SaveRegionDialog.new()
	d._mode = DialogMode.EXPORT
	d._data = prefab.data
	d._mn = Vector3i.ZERO
	d._mx = prefab.size - Vector3i.ONE
	d._source_prefab = prefab
	host.get_tree().root.add_child(d)
	d._start()

static func _require_selection(host: Node) -> bool:
	if VoxelWorld.active_project != null and VoxelWorld.has_selection:
		return true
	var info := AcceptDialog.new()
	info.title = "Select a region"
	info.dialog_text = "Select a region first: the Select tool, then right-click two corners."
	info.confirmed.connect(info.queue_free)
	info.canceled.connect(info.queue_free)
	host.get_tree().root.add_child(info)
	info.popup_centered()
	return false

func _start() -> void:
	title = "Export to Schematica" if _mode == DialogMode.EXPORT else "Save selection as prefab"
	if _source_prefab != null:
		title = "Export \"%s\" to Schematica" % _source_prefab.name
	ok_button_text = "Export…" if _mode == DialogMode.EXPORT else "Save"
	var layout := HBoxContainer.new()
	layout.add_theme_constant_override("separation", 16)
	add_child(layout)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	box.custom_minimum_size = Vector2(400, 0)
	layout.add_child(box)
	# What will be kept, live: unticked semantics and the trim are applied, and it resolves
	# through the palettes it will actually be shown/exported with. Drag to turn, wheel to zoom.
	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	layout.add_child(right)
	_preview = PrefabPreview.new()
	_preview.custom_minimum_size = Vector2(420, 420)
	_preview.size_flags_vertical = Control.SIZE_EXPAND_FILL
	right.add_child(_preview)
	var note := _caption("Preview of what will be kept · drag to turn, wheel to zoom")
	note.custom_minimum_size = Vector2.ZERO
	note.autowrap_mode = TextServer.AUTOWRAP_OFF
	right.add_child(note)

	_info = Label.new()
	_info.modulate = Color(1, 1, 1, 0.7)
	box.add_child(_info)

	if _mode == DialogMode.SAVE_PREFAB:
		box.add_child(_caption("Name"))
		_name_edit = LineEdit.new()
		_name_edit.text = _unique_name("Prefab")
		_name_edit.select_all_on_focus = true
		_name_edit.text_changed.connect(func(_t: String): _check())
		_name_edit.text_submitted.connect(func(_t: String):
			if not get_ok_button().disabled:
				_save())
		box.add_child(_name_edit)

		box.add_child(_caption("Handle (the cell that lands on your aim when placing, and turns pivot about)"))
		_anchor_pick = OptionButton.new()
		_anchor_pick.add_item("Bottom corner (min x, y, z)", 0)
		_anchor_pick.add_item("Bottom center", 1)
		box.add_child(_anchor_pick)

		box.add_child(_caption("Tags (comma separated, for search)"))
		_tags_edit = LineEdit.new()
		_tags_edit.placeholder_text = "pillar, factory"
		box.add_child(_tags_edit)

	# What goes in: every semantic in the box with its count; untick to leave it out.
	var head := HBoxContainer.new()
	var inc := _caption("Include (untick to leave out)")
	inc.custom_minimum_size = Vector2.ZERO
	inc.autowrap_mode = TextServer.AUTOWRAP_OFF
	inc.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(inc)
	for pair in [["All", true], ["None", false]]:
		var b := Button.new()
		b.text = pair[0]
		b.flat = true
		b.focus_mode = Control.FOCUS_NONE
		b.pressed.connect(func():
			for c: CheckBox in _checks.values():
				c.set_pressed_no_signal(pair[1])
			_on_include_changed())
		head.add_child(b)
	box.add_child(head)
	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	var list := VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(list)
	box.add_child(scroll)
	var counts := RegionOps.semantic_counts(_data, _mn, _mx)
	var names := counts.keys()
	names.sort_custom(func(a, b): return counts[a] > counts[b] if counts[a] != counts[b] else str(a) < str(b))
	for sem in names:
		var row := HBoxContainer.new()
		var swatch := ColorRect.new()
		swatch.color = VoxelWorld.get_color_for_semantic(str(sem))
		swatch.custom_minimum_size = Vector2(14, 14)
		swatch.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(swatch)
		var cb := CheckBox.new()
		cb.text = str(sem)
		cb.button_pressed = true
		cb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		cb.toggled.connect(func(_on: bool): _on_include_changed())
		row.add_child(cb)
		var n := Label.new()
		n.text = "×%d" % counts[sem]
		n.modulate = Color(1, 1, 1, 0.7)
		row.add_child(n)
		list.add_child(row)
		_checks[str(sem)] = cb
	scroll.custom_minimum_size = Vector2(0, mini(names.size(), 8) * 30 + 4)

	_trim_check = CheckBox.new()
	_trim_check.text = "Shrink the box to what's kept"
	_trim_check.tooltip_text = "Drop empty rows left around the kept cells (turned on when you leave something out, so a pillar without its floor doesn't float a block up)"
	_trim_check.toggled.connect(func(_on: bool):
		_trim_touched = true
		_check())
	box.add_child(_trim_check)

	_warn = Label.new()
	_warn.add_theme_color_override("font_color", Color(1.0, 0.75, 0.35))
	_warn.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_warn.custom_minimum_size = Vector2(390, 0)
	box.add_child(_warn)

	_check()
	confirmed.connect(func():
		if _mode == DialogMode.EXPORT:
			_export()
		else:
			_save())
	canceled.connect(_close)
	_set_views_suspended(true)
	popup_centered()
	if _name_edit != null:
		_name_edit.grab_focus()

func _caption(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 12)
	l.modulate = Color(1, 1, 1, 0.65)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	# A wrapping label measures its height at its current width; with none yet it stands one
	# word per line and props the dialog up tall. Give it the column's width.
	l.custom_minimum_size = Vector2(390, 0)
	return l

func _unique_name(base: String) -> String:
	var n := 1
	while VoxelWorld.workspace.get_prefab("%s %d" % [base, n]) != null:
		n += 1
	return "%s %d" % [base, n]

func _excluded() -> Array:
	var out: Array = []
	for sem in _checks:
		if not (_checks[sem] as CheckBox).button_pressed:
			out.append(sem)
	return out

# Leaving something out turns trimming on (until the user sets it themselves).
func _on_include_changed() -> void:
	if not _trim_touched:
		_trim_check.set_pressed_no_signal(not _excluded().is_empty())
	_check()

# The cells actually kept (exclusions + trim applied), and the box they occupy. Both _check()
# (for the live size/preview readout) and _save()/_export() (for the actual commit) need
# exactly the same computation, so it lives in one place.
func _kept() -> Dictionary:
	var cells := RegionOps.cells_without(_data, _mn, _mx, _excluded())
	var lo := _mn
	var hi := _mx
	if _trim_check.button_pressed and not cells.is_empty():
		lo = Vector3i(1 << 30, 1 << 30, 1 << 30)
		hi = -lo
		for p: Vector3i in cells:
			lo = Vector3i(mini(lo.x, p.x), mini(lo.y, p.y), mini(lo.z, p.z))
			hi = Vector3i(maxi(hi.x, p.x), maxi(hi.y, p.y), maxi(hi.z, p.z))
	return {"cells": cells, "lo": lo, "dims": hi - lo + Vector3i.ONE}

# Refresh the size / count read-out and the confirm button for the current choices.
func _check() -> void:
	var kept := _kept()
	var cells: Dictionary = kept["cells"]
	var lo: Vector3i = kept["lo"]
	var dims: Vector3i = kept["dims"]
	_update_preview(cells, lo, dims)
	_info.text = "%d × %d × %d  ·  %d cells" % [dims.x, dims.y, dims.z, cells.size()]
	if _mode == DialogMode.EXPORT:
		get_ok_button().disabled = cells.is_empty()
		_warn.text = "Nothing is left to export." if cells.is_empty() else ""
		return
	var n := _name_edit.text.strip_edges()
	var taken := VoxelWorld.workspace.get_prefab(n) != null
	get_ok_button().disabled = n.is_empty() or cells.is_empty()
	get_ok_button().text = "Replace" if taken else "Save"
	if cells.is_empty():
		_warn.text = "Nothing is left to save."
	elif taken:
		_warn.text = "A prefab named \"%s\" exists — saving replaces it." % n
	else:
		_warn.text = ""

func _save() -> void:
	var n := _name_edit.text.strip_edges()
	if n.is_empty():
		return
	var anchor: Variant = null
	if _anchor_pick.get_selected_id() == 1:
		anchor = "bottom-center"
	var res: Variant = VoxelWorld.save_prefab_from_region(n, _mn, _mx, [], anchor, true,
		_excluded(), _trim_check.button_pressed)
	if res is Prefab:
		var tags := _tags_edit.text.split(",", false)
		if not tags.is_empty():
			VoxelWorld.update_prefab(res, {"tags": Array(tags)})
		PrefabThumbs.request_bake(res)
	_close()

# Write the kept cells out as a .schematic file. Everything the file-picker step and the
# actual export need is captured into locals first (rel cells, dims, the resolve callback):
# the dialog itself closes right away, same as a save, but the picker + write happen after,
# once this node may already be gone.
func _export() -> void:
	var kept := _kept()
	var cells: Dictionary = kept["cells"]
	if cells.is_empty():
		_close()
		return
	var lo: Vector3i = kept["lo"]
	var dims: Vector3i = kept["dims"]
	var rel := {}
	for p: Vector3i in cells:
		rel[p - lo] = cells[p]
	var src_prefab := _source_prefab
	var suggested := src_prefab.name if src_prefab != null \
		else (VoxelWorld.active_project.name if VoxelWorld.active_project != null else "export")
	var root := get_tree().root
	var export_cb := func() -> Dictionary:
		if src_prefab != null:
			VoxelWorld.begin_resolve_as(CaptureService.prefab_stage(src_prefab))
			var result: Dictionary = SchematicaExporter.export_cells(rel, dims)
			VoxelWorld.end_resolve_as()
			return result
		return SchematicaExporter.export_cells(rel, dims)
	_close()
	_pick_export_path(root, suggested, export_cb)

static func _pick_export_path(root: Node, suggested_name: String, export_cb: Callable) -> void:
	var dialog := FileDialog.new()
	dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.file_mode = FileDialog.FILE_MODE_SAVE_FILE
	dialog.use_native_dialog = true
	dialog.size = Vector2i(700, 500)
	dialog.filters = PackedStringArray(["*.schematic ; Schematica files"])
	dialog.current_file = _safe_filename(suggested_name) + ".schematic"
	var docs := OS.get_system_dir(OS.SYSTEM_DIR_DOCUMENTS)
	if not docs.is_empty():
		dialog.current_dir = docs
	root.add_child(dialog)
	dialog.file_selected.connect(func(path: String):
		_write_export(root, path, export_cb)
		dialog.queue_free())
	dialog.canceled.connect(dialog.queue_free)
	dialog.popup_centered()

static func _safe_filename(n: String) -> String:
	var out := n
	for ch in ["/", "\\", ":", "*", "?", "\"", "<", ">", "|"]:
		out = out.replace(ch, "_")
	out = out.strip_edges()
	return out if not out.is_empty() else "export"

static func _write_export(root: Node, path: String, export_cb: Callable) -> void:
	var result: Dictionary = export_cb.call()
	var bytes: PackedByteArray = result["bytes"]
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		_show_message(root, "Export failed", PackedStringArray(["Couldn't write to \"%s\"." % path]), PackedStringArray())
		return
	f.store_buffer(bytes)
	f.close()
	_show_export_report(root, path, result["report"])

static func _show_export_report(root: Node, path: String, report: Dictionary) -> void:
	var dims: Vector3i = report["size"]
	var lines := PackedStringArray([path, "%d × %d × %d  ·  %d cells written  ·  %d distinct blocks" % [
		dims.x, dims.y, dims.z, report["cells_written"], report["distinct_blocks"]]])
	if int(report.get("tile_entities", 0)) > 0:
		lines.append("%d shaped-part tile entities (ForgeMultipart / ArchitectureCraft)" % report["tile_entities"])

	var unmapped: Dictionary = report.get("unmapped", {})
	var empty_parts := int(report.get("empty_part_cells", 0))
	var warn_lines := PackedStringArray()
	if not unmapped.is_empty() or empty_parts > 0:
		warn_lines.append("Left out — no confirmed Minecraft identity:")
		var names := unmapped.keys()
		names.sort()
		for sem in names:
			warn_lines.append("  %s  ×%d" % [sem, unmapped[sem]])
		if empty_parts > 0:
			warn_lines.append("  %d part-cell(s) where nothing in them resolved to a real block" % empty_parts)
	_show_message(root, "Exported to Schematica", lines, warn_lines)

# A fixed-width AcceptDialog: every wrapping Label gets an explicit width (see _caption
# above) — without one, a Label measures its height at zero width before layout ever runs,
# so it stands one word per line and props the whole dialog up absurdly tall.
static func _show_message(root: Node, dtitle: String, lines: PackedStringArray, warn_lines: PackedStringArray) -> void:
	var d := AcceptDialog.new()
	d.title = dtitle
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	box.custom_minimum_size = Vector2(420, 0)
	d.add_child(box)

	var info := Label.new()
	info.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	info.custom_minimum_size = Vector2(420, 0)
	info.text = "\n".join(lines)
	box.add_child(info)

	if not warn_lines.is_empty():
		box.add_child(HSeparator.new())
		var warn := Label.new()
		warn.add_theme_color_override("font_color", Color(1.0, 0.75, 0.35))
		warn.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		warn.custom_minimum_size = Vector2(420, 0)
		warn.text = "\n".join(warn_lines)
		box.add_child(warn)

	d.confirmed.connect(d.queue_free)
	d.canceled.connect(d.queue_free)
	root.add_child(d)
	d.popup_centered()

func _close() -> void:
	_set_views_suspended(false)
	queue_free()

# Typing a name must not drive the 3D view (H toggles the cutaway, B the sky, …).
func _set_views_suspended(on: bool) -> void:
	var shell := get_tree().get_first_node_in_group("view_shell") if is_inside_tree() else null
	if shell != null and shell.has_method("set_views_suspended"):
		shell.call("set_views_suspended", on)

# Show the kept cells as a throwaway prefab (only rebuilt when what's kept changes, not on
# every keystroke). Previews through whichever palette stack will actually resolve them:
# the source prefab's own preferred stack when exporting one, otherwise a live selection's
# own project palettes filtered to what's actually used, equivalent to resolving against the
# full stack for cells confined to this box (a palette that touches none of these semantics
# can't change the result either way).
func _update_preview(cells: Dictionary, lo: Vector3i, dims: Vector3i) -> void:
	var key := "%s|%s|%d" % [",".join(_excluded()), str(lo), cells.size()]
	if key == _preview_key or cells.is_empty():
		return
	_preview_key = key
	var p := Prefab.new()
	p.name = "preview"
	for pos: Vector3i in cells:
		p.data.set_cell(pos - lo, cells[pos])
	p.size = dims
	p.palette_names = _source_prefab.palette_names if _source_prefab != null \
		else VoxelWorld.prefab_default_palettes(p.used_semantics())
	_preview.show_prefab(p)
