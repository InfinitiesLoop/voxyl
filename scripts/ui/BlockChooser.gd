class_name BlockChooser
extends HBoxContainer

# A "mini multi-library view" for picking the block type a palette entry resolves to. It's the
# shared heart of both block-assignment surfaces — the inventory add/edit popup
# (NewPaletteEntryDialog) and the Palettes editor's entry detail (HomeScreen) — so a UX
# improvement in one benefits the other. It reuses the same tech as the Libraries view:
#   • LibraryList     — a filter rail of the palette's scoped libraries, with an "All blocks"
#                       default (empty selection ⇒ every library, merged with dividers).
#   • BlockGrid       — the virtualized, section-divided icon grid + its own search box.
#   • BlockPreview3D  — the large rotating 3D render with its 1×1/1×3/3×3 layout bar.
#
# It is a pure lens on the material layer: it resolves block types through
# VoxelWorkspace.resolve_block_type scope order and never touches voxel data or commits an
# assignment itself. Single-click *explores* a block (loads the preview) without committing —
# the host decides when to commit: the popup on its OK button, the inline editor live via the
# `selection_changed` signal. `get_selected()` is always the currently-explored block, which
# starts at the entry's current assignment so the panel opens on what's already mapped.

# The user explored (previewed) a different block. Preview-only — no assignment happens here.
signal selection_changed(block_name: String)

var _palette: Palette
# Full, de-duplicated scoped item list (Array[BlockGrid.Item]) in resolve order (first-hit
# wins by name, matching VoxelWorkspace.resolve_block_type) — the universe the rail filters.
var _all_items: Array = []
var _owner_by_key: Dictionary = {}   # block name -> owning library name (its first-hit owner)
var _current_block: String = ""      # the committed assignment (drives the "Current:" chip)
var _selected_block: String = ""     # the explored block (what get_selected returns)

var _rail: LibraryList
var _grid: BlockGrid
var _preview: BlockPreview3D
var _current_swatch: ColorRect
var _current_name: Label

func _ready() -> void:
	add_theme_constant_override("separation", 10)

	# Left: the library filter rail — pure selection, no create/delete (that's the Libraries
	# view's job), with the "All blocks" default so nothing selected shows everything.
	_rail = LibraryList.new()
	_rail.list_title = "Libraries"
	_rail.allow_multi_select = true
	_rail.allow_add = false
	_rail.allow_delete = false
	_rail.include_all_row = true
	_rail.custom_minimum_size.x = 140
	_rail.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_rail.selection_changed.connect(_on_filter_changed)
	add_child(_rail)

	add_child(VSeparator.new())

	# Middle: the JEI-style icon grid (captions on, its search box pinned at the bottom).
	_grid = BlockGrid.new()
	_grid.show_captions = true
	_grid.cell_size = Vector2(56, 56)
	_grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_grid.item_selected.connect(_on_item_explored)
	add_child(_grid)

	add_child(VSeparator.new())

	# Right: the large rotating preview of the explored block + a persistent "Current:" chip
	# so the committed assignment stays visible while auditioning candidates.
	var right := VBoxContainer.new()
	right.custom_minimum_size.x = 220
	right.size_flags_vertical = Control.SIZE_EXPAND_FILL
	right.add_theme_constant_override("separation", 8)
	add_child(right)

	_preview = BlockPreview3D.new()
	_preview.custom_minimum_size = Vector2(0, 240)
	_preview.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_preview.size_flags_vertical = Control.SIZE_EXPAND_FILL
	right.add_child(_preview)

	var chip := HBoxContainer.new()
	chip.add_theme_constant_override("separation", 6)
	var cap := Label.new()
	cap.text = "Current:"
	cap.modulate = Color(1, 1, 1, 0.6)
	cap.add_theme_font_size_override("font_size", 12)
	cap.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	chip.add_child(cap)
	_current_swatch = ColorRect.new()
	_current_swatch.custom_minimum_size = Vector2(20, 20)
	_current_swatch.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	chip.add_child(_current_swatch)
	_current_name = Label.new()
	_current_name.clip_text = true
	_current_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_current_name.add_theme_font_size_override("font_size", 12)
	chip.add_child(_current_name)
	right.add_child(chip)

# Point the chooser at `palette` and open on `current_block_name` (empty = undecided). Must be
# called after the node is in the tree (both hosts add it, then configure). Builds the full
# deduped scoped item list once — the rail then just narrows which of these show.
func configure(palette: Palette, current_block_name: String) -> void:
	_palette = palette
	_current_block = current_block_name
	_selected_block = current_block_name
	_all_items = []
	_owner_by_key = {}
	var seen := {}
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
				_owner_by_key[bt.name] = lib_name
				# section = owning library; whether a divider actually renders is decided per
				# filter in _apply_filter (blanked when only one library is visible).
				_all_items.append(BlockGrid.block_item(bt, lib_name, lib_name))
	_rebuild_rail()
	_apply_filter([])          # empty = All blocks
	_preview.set_block(_resolve(_selected_block))
	_refresh_current_chip()

# The explored block (what a host commits). Starts at the entry's current assignment.
func get_selected() -> String:
	return _selected_block

# Focus the grid's search box so the user can type to filter immediately (edit mode).
func focus_search() -> void:
	if _grid:
		_grid.focus_search()

# Re-point the "Current:" chip after a host commits live (inline editor), so it tracks the
# newly-assigned block without a full rebuild.
func refresh_current(block_name: String) -> void:
	_current_block = block_name
	_refresh_current_chip()

# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

# List one rail row per library that actually contributes a block, in scope order. A library
# fully shadowed by a higher-priority one (all its names already taken) is skipped rather than
# offering a filter that lands on an empty grid.
func _rebuild_rail() -> void:
	var names: Array = []
	var seen := {}
	for it in _all_items:
		var owner_name: String = _owner_by_key.get(it.key, "")
		if owner_name != "" and not seen.has(owner_name):
			seen[owner_name] = true
			names.append(owner_name)
	_rail.populate(names)

# The rail selection changed. Empty ⇒ show every library (the "All blocks" state).
func _on_filter_changed(selected_libs: Array) -> void:
	_apply_filter(selected_libs)

# Populate the grid from the deduped universe, keeping only items whose owning library is in
# the filter (empty filter = keep all). Section dividers are shown only when 2+ libraries are
# visible — matching the Libraries view, where a single library needs no divider. Sections are
# mutated on our own items (never shared elsewhere), so re-filtering just re-tags them.
func _apply_filter(selected_libs: Array) -> void:
	var allow := {}
	for n in selected_libs:
		allow[n] = true
	var filtered: Array = []
	var owners_present := {}
	for it in _all_items:
		var owner_name: String = _owner_by_key.get(it.key, "")
		if allow.is_empty() or allow.has(owner_name):
			filtered.append(it)
			owners_present[owner_name] = true
	var multi := owners_present.size() >= 2
	for it in filtered:
		it.section = _owner_by_key.get(it.key, "") if multi else ""
	_grid.populate_items(filtered)
	_grid.set_selected(_selected_block)

# A grid cell was clicked: explore it (preview + highlight), announce it. No commit.
func _on_item_explored(key: String) -> void:
	_selected_block = key
	_grid.set_selected(key)
	_preview.set_block(_resolve(key))
	selection_changed.emit(key)

func _resolve(block_name: String) -> BlockType:
	if block_name.is_empty() or _palette == null:
		return null
	return VoxelWorld.workspace.resolve_block_type(block_name, _palette.library_names)

func _refresh_current_chip() -> void:
	var bt := _resolve(_current_block)
	_current_swatch.color = bt.color if bt else Color(0.35, 0.35, 0.35)
	_current_name.text = _current_block if not _current_block.is_empty() else "(undecided)"
