class_name ImportPanel
extends Window

# The "Add blocks…" UX (Phase 5). Pick a source — a resource-pack `.zip`, a mod
# `.jar`, an unzipped pack/install folder, or a mods folder — browse and search the
# blocks it offers, multiselect, and import. Importing only fills the block-type
# library; assigning the results to palette semantics is the existing palette
# workflow, untouched.
#
# This is a thin shell over ImportService (which owns source detection + import) and
# MCImporter (the translator). The licensing note (decision 4) is always visible:
# the importer reads assets the user already owns and bundles no Minecraft content.

const _NOTE := "Reads blocks from your own installed game, resource packs, or mods. Voxyl bundles no Minecraft content."
const _FLAT_NOTE := "Pre-1.8 packs carry no model data — shapes are guessed from texture names (top/side/front…) and everything imports as a cube."

# Set by the opener (HomeScreen) to the Block Types tab's selected library, so imports
# default to the library the user is managing. "" → first existing non-basic library, or
# a new "imported" library.
var default_library := ""

var _service: ImportService
var _available: Array = []          # the full browse list; the ItemList shows a filtered view
var _current_path := ""             # the last chosen source path (re-browsed on mode change)
var _target_library_name := ""      # the resolved import target (created on first browse)

const _NEW_LIBRARY_ITEM := "New library…"

var _format: OptionButton
var _target_picker: OptionButton
var _locations: MenuButton
var _loc_entries: Array = []        # MCInstallLocations.candidates() for this platform
var _flat_note: Label
var _path_label: Label
var _search: LineEdit
var _list: ItemList
var _select_all_check: CheckBox
var _status: Label
var _import_btn: Button
var _file_dialog: FileDialog
var _dir_dialog: FileDialog

func _ready() -> void:
	title = "Add Blocks"
	size = Vector2i(560, 600)
	min_size = Vector2i(440, 420)
	close_requested.connect(_close)
	_build()

func _build() -> void:
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 14)
	add_child(margin)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	margin.add_child(vbox)

	# Format — which translator to run. Changing it re-browses the current source.
	var fmt_row := HBoxContainer.new()
	fmt_row.add_theme_constant_override("separation", 6)
	vbox.add_child(fmt_row)
	var fmt_lbl := Label.new()
	fmt_lbl.text = "Format:"
	fmt_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	fmt_row.add_child(fmt_lbl)
	_format = OptionButton.new()
	_format.add_item("Minecraft 1.8+ (block models)", ImportService.Mode.JSON)
	_format.add_item("Older / pre-1.8 (textures only)", ImportService.Mode.FLAT)
	_format.item_selected.connect(_on_format_changed)
	fmt_row.add_child(_format)

	# Target — which library the imported blocks land in. Imports never target the
	# built-in `basic` floor; the user picks an existing library or creates one.
	var tgt_row := HBoxContainer.new()
	tgt_row.add_theme_constant_override("separation", 6)
	vbox.add_child(tgt_row)
	var tgt_lbl := Label.new()
	tgt_lbl.text = "Add to library:"
	tgt_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	tgt_row.add_child(tgt_lbl)
	_target_picker = OptionButton.new()
	_target_picker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_target_picker.item_selected.connect(_on_target_selected)
	tgt_row.add_child(_target_picker)
	_refresh_target_picker()

	# Source pickers — file (archive) or folder (pack / assets / mods), plus a
	# launcher-aware shortcut that jumps the picker to where installs usually live.
	var src_row := HBoxContainer.new()
	src_row.add_theme_constant_override("separation", 6)
	vbox.add_child(src_row)
	var file_btn := Button.new()
	file_btn.text = "Choose .zip / .jar…"
	file_btn.pressed.connect(_pick_file)
	src_row.add_child(file_btn)
	var dir_btn := Button.new()
	dir_btn.text = "Choose folder…"
	dir_btn.pressed.connect(_pick_dir)
	src_row.add_child(dir_btn)
	_build_locations_menu()
	src_row.add_child(_locations)

	_path_label = Label.new()
	_path_label.text = "No source chosen."
	_path_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_path_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_path_label.tooltip_text = ""
	vbox.add_child(_path_label)

	var note := Label.new()
	note.text = _NOTE
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	note.modulate = Color(1, 1, 1, 0.6)
	note.add_theme_font_size_override("font_size", 11)
	vbox.add_child(note)

	# Shown only in pre-1.8 mode: the shapes-are-guessed caveat.
	_flat_note = Label.new()
	_flat_note.text = _FLAT_NOTE
	_flat_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_flat_note.modulate = Color(1, 0.85, 0.5, 0.85)
	_flat_note.add_theme_font_size_override("font_size", 11)
	_flat_note.visible = false
	vbox.add_child(_flat_note)

	vbox.add_child(HSeparator.new())

	# Search filter.
	_search = LineEdit.new()
	_search.placeholder_text = "Search blocks…"
	_search.clear_button_enabled = true
	_search.text_changed.connect(func(_t): _refilter())
	vbox.add_child(_search)

	# The multiselect list of available blocks.
	_list = ItemList.new()
	_list.select_mode = ItemList.SELECT_MULTI
	_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_list.item_activated.connect(func(_i): _import())   # double-click → import selection
	vbox.add_child(_list)

	# Actions. "Select all" is a checkbox (checked by default) — toggling it off
	# deselects everything; the list also starts fully selected after each browse.
	var action_row := HBoxContainer.new()
	action_row.add_theme_constant_override("separation", 6)
	vbox.add_child(action_row)
	_select_all_check = CheckBox.new()
	_select_all_check.text = "Select all"
	_select_all_check.button_pressed = true
	_select_all_check.toggled.connect(_on_select_all_toggled)
	action_row.add_child(_select_all_check)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	action_row.add_child(spacer)
	_import_btn = Button.new()
	_import_btn.text = "Import selected"
	_import_btn.disabled = true
	_import_btn.pressed.connect(_import)
	action_row.add_child(_import_btn)

	_status = Label.new()
	_status.text = ""
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	vbox.add_child(_status)

	_file_dialog = _make_dialog(FileDialog.FILE_MODE_OPEN_FILE)
	_file_dialog.filters = PackedStringArray(["*.zip,*.jar ; Resource packs & mods"])
	_file_dialog.file_selected.connect(_set_source)
	add_child(_file_dialog)

	_dir_dialog = _make_dialog(FileDialog.FILE_MODE_OPEN_DIR)
	_dir_dialog.dir_selected.connect(_set_source)
	add_child(_dir_dialog)

func _make_dialog(dialog_mode: FileDialog.FileMode) -> FileDialog:
	var d := FileDialog.new()
	d.access = FileDialog.ACCESS_FILESYSTEM
	d.file_mode = dialog_mode
	d.use_native_dialog = true
	d.size = Vector2i(700, 500)
	return d

# A drop-down of the usual MC install locations for this platform. Entries that exist
# on this machine are enabled and jump the right picker straight there; missing ones
# stay listed (disabled, "(not found)") so the user still sees where to look.
func _build_locations_menu() -> void:
	_locations = MenuButton.new()
	_locations.text = "Common locations"
	_locations.tooltip_text = "Jump to where Minecraft installs usually live"
	_loc_entries = MCInstallLocations.candidates()
	var pm := _locations.get_popup()
	for i in _loc_entries.size():
		var e: Dictionary = _loc_entries[i]
		pm.add_item(e["label"] if e["exists"] else "%s  (not found)" % e["label"], i)
		pm.set_item_tooltip(i, e["path"])
		pm.set_item_disabled(i, not e["exists"])
	pm.id_pressed.connect(_on_location_picked)

# Open the appropriate picker rooted at the chosen location.
func _on_location_picked(id: int) -> void:
	var e: Dictionary = _loc_entries[id]
	var dlg := _file_dialog if e["picker"] == "file" else _dir_dialog
	dlg.current_dir = e["path"]
	dlg.popup_centered()

func _pick_file() -> void:
	_file_dialog.popup_centered()

func _pick_dir() -> void:
	_dir_dialog.popup_centered()

func _mode() -> ImportService.Mode:
	return _format.get_selected_id() as ImportService.Mode

# Populate the target picker with existing non-basic libraries + a "New library…" item,
# resolving a default target (the opener's library, else the first one, else a new
# "imported"). The resolved name is always present even if not yet created on disk.
func _refresh_target_picker() -> void:
	_target_picker.clear()
	var libs: Array = []
	for n in VoxelWorld.workspace.list_libraries():
		if n != VoxelWorkspace.BASIC_LIBRARY:
			libs.append(n)
	if _target_library_name.is_empty():
		if not default_library.is_empty() and default_library != VoxelWorkspace.BASIC_LIBRARY:
			_target_library_name = default_library
		elif not libs.is_empty():
			_target_library_name = libs[0]
		else:
			_target_library_name = "imported"
	if _target_library_name not in libs:
		libs.append(_target_library_name)
	var sel := 0
	for i in libs.size():
		_target_picker.add_item(libs[i])
		if libs[i] == _target_library_name:
			sel = i
	_target_picker.add_item(_NEW_LIBRARY_ITEM)
	_target_picker.selected = sel

func _on_target_selected(idx: int) -> void:
	var text := _target_picker.get_item_text(idx)
	if text == _NEW_LIBRARY_ITEM:
		_prompt_new_library()
		return
	_target_library_name = text
	if not _current_path.is_empty():
		_set_source(_current_path)   # rebind the service to the new target

func _prompt_new_library() -> void:
	var dlg := AcceptDialog.new()
	dlg.title = "New Library"
	var input := LineEdit.new()
	input.placeholder_text = "Library name…"
	input.custom_minimum_size = Vector2(260, 0)
	dlg.add_child(input)
	dlg.confirmed.connect(func():
		var n := input.text.strip_edges()
		if not n.is_empty() and n != VoxelWorkspace.BASIC_LIBRARY:
			_target_library_name = n
			_refresh_target_picker()
			if not _current_path.is_empty():
				_set_source(_current_path)
		else:
			_refresh_target_picker()
		dlg.queue_free())
	dlg.canceled.connect(func():
		_refresh_target_picker()   # revert the selection off "New library…"
		dlg.queue_free())
	add_child(dlg)
	dlg.popup_centered()
	input.grab_focus()

# The import target, created in the workspace catalog if it doesn't exist yet.
func _resolve_target_library() -> BlockLibrary:
	return VoxelWorld.workspace.get_or_add_library(_target_library_name)

# Switching format: show/hide the caveat and re-browse the current source under it.
func _on_format_changed(_idx: int) -> void:
	_flat_note.visible = _mode() == ImportService.Mode.FLAT
	if not _current_path.is_empty():
		_set_source(_current_path)

# Chosen a path → detect source(s), browse, and populate the list.
func _set_source(path: String) -> void:
	if _service != null:
		_service.close()
	_current_path = path
	var sources := ImportService.detect_sources(path)
	_service = ImportService.new(sources, _resolve_target_library(), _mode())
	_available = _service.available_blocks()
	_path_label.text = path
	_path_label.tooltip_text = path
	_search.text = ""
	_refilter()
	if sources.is_empty():
		_status.text = "Couldn't read a Minecraft assets tree there."
	elif _available.is_empty():
		_status.text = "No blocks found — try the other format, or a different source."
	else:
		_status.text = "%d block(s) available." % _available.size()

# Rebuild the ItemList from _available, filtered by the (case-insensitive) search.
# Each row remembers its index into _available so a selection maps back to entries.
# Honors the "select all" checkbox so a fresh browse / search starts fully selected.
func _refilter() -> void:
	_list.clear()
	var needle := _search.text.strip_edges().to_lower()
	for i in _available.size():
		var ref: String = _available[i]["ref"]
		if needle.is_empty() or ref.to_lower().contains(needle):
			var idx := _list.add_item(ref)
			_list.set_item_metadata(idx, i)
	if _select_all_check.button_pressed:
		_set_all_selected(true)
	_import_btn.disabled = _list.item_count == 0

func _on_select_all_toggled(on: bool) -> void:
	_set_all_selected(on)

func _set_all_selected(on: bool) -> void:
	if on:
		for i in _list.item_count:
			_list.select(i, false)
	else:
		_list.deselect_all()

func _import() -> void:
	if _service == null:
		return
	var selection: Array = []
	for i in _list.item_count:
		if _list.is_selected(i):
			selection.append(_available[_list.get_item_metadata(i)])
	if selection.is_empty():
		_status.text = "Select one or more blocks to import."
		return
	# Drive the import through a modal progress window so a big batch doesn't freeze
	# the panel; it stays open afterwards for the user to read any warnings.
	_import_btn.disabled = true
	var dlg := ImportProgressDialog.new()
	get_tree().root.add_child(dlg)
	dlg.popup_centered()
	await dlg.run(_service, selection)
	VoxelWorld.workspace_changed.emit()
	_status.text = "Imported %d block(s)." % _service.imported_count
	_import_btn.disabled = _list.item_count == 0

func _close() -> void:
	if _service != null:
		_service.close()
	queue_free()
