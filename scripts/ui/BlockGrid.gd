class_name BlockGrid
extends VBoxContainer

# JEI-style block browser: a scrollable flow of fixed-size icons with a live search box
# pinned at the bottom. A pure lens on a *collection of blocks* — each cell shows an icon
# baked by BlockIconBaker (the real 3D render of a block type) and emits the clicked item's
# key. It owns no data and never touches voxel data.
#
# It is item-based, not bespoke to block types: an Item carries a key (emitted on click), a
# search label, an optional caption drawn under the icon, and the BlockType used to bake the
# icon (or null → a planning-color placeholder). So the same grid shows raw block types
# (block_item) or palette entries (caller-built items mapping to a resolved block type).
#
# VIRTUALIZED: the cells are a uniform grid, so we never build a Control per item — that
# would create tens of thousands of nodes and, worse, force every icon to load from disk +
# upload to the GPU on the first layout (Godot records draw commands for every in-tree
# Control, clipped or not). A full modpack library (~22k blocks) did that in ~30s and pinned
# >1GB of VRAM. Instead a single fixed-height canvas gives the scrollbar its range, and only
# the rows within the viewport (plus a buffer) are realized as real cells — so only their
# icons load. Because the buffer rows are realized before they scroll into view and warm
# icons load synchronously from disk, nothing shows as an uninitialized placeholder mid-scroll.

signal item_selected(key: String)
# Back-compat: the Block Types tab listens to this; it fires alongside item_selected.
signal block_selected(block_name: String)
# Right-click on a non-"add" cell. `global_pos` is already in screen space (straight off
# the InputEventMouseButton), so a host can pop a context menu at it with no conversion.
# Emitted only — this grid stays a pure lens and never decides what right-click means.
signal item_right_clicked(key: String, global_pos: Vector2)
# Fires whenever the search box text changes, so a host screen can react beyond this grid
# — e.g. the Block Types tab also hides libraries with no matching block (see HomeScreen).
signal search_changed(text: String)

# A single grid cell's data. RefCounted so callers build them freely and the grid holds refs.
class Item extends RefCounted:
	var key: String                       # emitted on click; unique within the grid
	var label: String                     # tooltip text
	# What's actually matched against the search terms. Defaults to label, but a block
	# item widens this to also cover its library and namespace (see block_item) so a
	# search term can hit any "part" of a block's full identity without cluttering the
	# tooltip with that extra text.
	var search_text: String = ""
	var caption: String = ""              # optional text drawn under the icon
	var block_type: BlockType = null      # baked for the icon; null → placeholder
	var placeholder_color := Color(0.5, 0.5, 0.5)
	var is_add: bool = false              # draws a "+" glyph instead of an icon
	# Optional group name. Items must be contiguous by section (callers populate them
	# grouped, not interleaved) — whenever this differs from the previous item's non-empty
	# section, a full-width divider row is inserted before it. Empty ⇒ no divider, ever;
	# this is what every existing caller gets, unchanged. Not library-specific: any grouping
	# a caller wants (libraries, templates, ...) works the same way.
	var section: String = ""

# A trailing "add new" tile the caller appends last. Always emits ADD_KEY on click and is
# excluded from search filtering (it's chrome, not content).
const ADD_KEY := "__add__"
static func add_item(caption_text := "") -> Item:
	var it := Item.new()
	it.key = ADD_KEY
	it.label = ""
	it.caption = caption_text
	it.is_add = true
	return it

# Build an item that displays a block type directly (key/label = its name). `library_name`,
# when given, and the block's own namespace are folded into search_text (not the label) so
# searching "ztone" finds every block in a "ztones" library or "ztones" namespace even when
# neither is part of the block's own name. `section`, when given, groups this item under a
# divider — see Item.section.
static func block_item(bt: BlockType, library_name: String = "", section: String = "") -> Item:
	var it := Item.new()
	it.key = bt.name
	it.label = bt.name
	it.search_text = bt.search_haystack(library_name)
	it.block_type = bt
	it.placeholder_color = bt.color
	it.section = section
	return it

# Per-grid look, set before populate_items: cell footprint + whether to draw captions
# (captioned cells get a taller box with a text strip beneath the icon).
var cell_size := Vector2(50, 50)
var show_captions := false

var _canvas: Control                 # fixed-height virtual content; cells positioned inside it
var _scroll: ScrollContainer
var _search: LineEdit
var _baker: BlockIconBaker
var _items: Array = []               # Array[Item], as handed to populate_items()
var _filtered: Array = []            # Array[Item], _items passing the current search filter
var _active: Dictionary = {}         # filtered-index -> live cell Control (only visible rows)
var _pool: Array = []                # released cells kept for reuse, so scrolling rebinds
									 # rather than allocating/freeing nodes each row
var _cols: int = 0                   # columns at the current width (drives layout + row count)
var _selected: String = ""           # selected item key

# Row layout: precomputed once per _relayout (not per scroll tick) since section dividers
# make rows non-uniform — a plain idx/_cols division no longer finds a row's position or
# height. Each entry is a Dictionary: {is_header: true, title, y, height} for a divider, or
# {is_header: false, start, count, y, height} for a row of up to _cols filtered-items
# starting at index `start`. Sorted by `y`, so _update_visible binary-searches it.
var _rows: Array = []
var _active_headers: Dictionary = {} # row-index -> live header Control (only visible rows)
var _header_pool: Array = []         # released header controls kept for reuse
var _last_row_start: int = -1        # row-index window realized last update; skip if unchanged
var _last_row_end: int = -1

const _CAPTION_H := 20.0
const _H_SEP := 3.0                  # gap between cells in a row
const _V_SEP := 3.0                  # gap between rows
const _HEADER_H := 24.0              # height of a section-divider row
# Extra rows realized above and below the viewport so a row is already built (and its warm
# icon loaded) before it scrolls into view — no placeholder flash on a normal scroll.
const _BUFFER_ROWS := 4

func _ready() -> void:
	# The off-screen icon baker lives under the grid (it needs to be in the tree to
	# render); icon_ready redraws just the cells whose bake landed.
	_baker = BlockIconBaker.new()
	add_child(_baker)
	_baker.icon_ready.connect(_on_icon_ready)

	_scroll = ScrollContainer.new()
	_scroll.size_flags_horizontal = SIZE_EXPAND_FILL
	_scroll.size_flags_vertical = SIZE_EXPAND_FILL
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(_scroll)

	# A plain Control, not a flow container: we place cells by hand (see class doc). Its
	# minimum height is the full virtual content height, so the scrollbar spans every row
	# even though only the visible ones exist as nodes. ScrollContainer stretches its width
	# to the viewport (horizontal scroll disabled), so _canvas.resized fires on width change.
	_canvas = Control.new()
	_canvas.size_flags_horizontal = SIZE_EXPAND_FILL
	_canvas.resized.connect(_relayout)
	_scroll.add_child(_canvas)
	# Scrolling and viewport-height changes only shift which rows are visible, not the layout.
	_scroll.get_v_scroll_bar().value_changed.connect(func(_v): _update_visible())
	_scroll.resized.connect(_update_visible)

	_search = LineEdit.new()
	_search.placeholder_text = "Search blocks…"
	_search.clear_button_enabled = true
	_search.text_changed.connect(_apply_filter)
	# Right-click selects everything so a fresh search just types over the old one
	# (instead of popping the native context menu).
	_search.context_menu_enabled = false
	_search.gui_input.connect(_on_search_input)
	add_child(_search)

	if not _items.is_empty():
		_recompute_filtered("")
		_relayout()

# Replace the grid's contents with raw block types. Thin adapter over populate_items so the
# Block Types tab (and anything else handing in BlockTypes) is unchanged. `library_name`
# (when every block_type belongs to the same library, as in the Block Types tab) is folded
# into each item's search_text — see block_item.
func populate(block_types: Array, library_name: String = "") -> void:
	var items: Array = []
	for bt in block_types:
		items.append(block_item(bt, library_name))
	populate_items(items)

# Replace the grid's contents with arbitrary items. Re-applies the current search text so a
# refresh keeps any active filter, and returns to the top.
func populate_items(items: Array) -> void:
	_items = items
	if _canvas:
		_recompute_filtered(_search.text)
		# _relayout (rebuilds _rows to match the new _filtered) must run before touching
		# scroll_vertical — see the comment in _apply_filter for why.
		_relayout()
		_scroll.scroll_vertical = 0

# Re-bake icons after a block edit. With a name, only that block's icon is dropped and the
# cells showing it redraw; with none, the whole grid re-bakes (rarely needed — structural
# changes already invalidate the baker via workspace_changed).
func refresh_icons(block_name := "") -> void:
	if not _baker:
		return
	if block_name.is_empty():
		_baker.invalidate_all()
		for cell in _active.values():
			cell.queue_redraw()
	else:
		_baker.invalidate(block_name)
		_redraw_cells_for_block(block_name)

# Force a fresh bake of every block currently in the grid (ignoring both the in-memory
# and on-disk caches), then redraw. Used by the "Regenerate previews" action to re-run —
# and time — the whole bake pipeline. Awaitable; returns once all icons are baked + saved.
func force_rebake_all() -> void:
	if not _baker:
		return
	var blocks: Array = []
	for item in _items:
		if item.block_type != null:
			blocks.append(item.block_type)
	await _baker.prebake(blocks, Callable(), true)
	# prebake is bulk (disk-only): it neither refreshed nor retained in-memory icons, so
	# drop the now-stale memory cache and repaint — the visible cells reload from disk.
	_baker.invalidate_all()
	for cell in _active.values():
		cell.queue_redraw()

# Highlight an item by key (no signal). Called by detail panels so external selection and
# in-grid clicks stay in sync.
func set_selected(key: String) -> void:
	if _selected == key:
		return
	_selected = key
	for cell in _active.values():
		cell.queue_redraw()

func _apply_filter(text: String) -> void:
	_recompute_filtered(text)
	# Rebuild _rows against the new _filtered *before* touching scroll_vertical: assigning it
	# fires the scrollbar's value_changed synchronously (see the _update_visible connection in
	# _ready), and _update_visible indexes _filtered via _rows — so _rows must already match
	# the new _filtered or that handler reads stale row data (e.g. from a longer list) and
	# indexes off the end.
	_relayout()
	if _scroll:
		_scroll.scroll_vertical = 0
	search_changed.emit(text)

# Whether a global point falls inside the scrollable icon area — lets a host screen
# decide if the mouse wheel should scroll the grid or do something else.
func is_in_scroll_area(global_pos: Vector2) -> bool:
	return _scroll != null and _scroll.get_global_rect().has_point(global_pos)

# Focus the search box and select its contents — driven by Tab from a host screen
# so the user can start typing a query immediately.
func focus_search() -> void:
	if _search:
		_search.grab_focus()
		_search.select_all()

func _on_search_input(ev: InputEvent) -> void:
	if ev is InputEventMouseButton and (ev as InputEventMouseButton).pressed \
			and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_RIGHT:
		_search.grab_focus()
		_search.select_all()
		_search.accept_event()

# --- Virtualized layout -----------------------------------------------------

# Split a query on whitespace into lowercase terms. Shared with hosts (e.g. HomeScreen)
# that need to test the same terms against other haystacks — like a library's block names,
# to decide whether that library has any match at all.
static func split_terms(query: String) -> PackedStringArray:
	var terms := PackedStringArray()
	for t in query.strip_edges().to_lower().split(" ", false):
		terms.append(t)
	return terms

# True if haystack contains every term (AND, not OR) — case-insensitive. Empty terms match
# everything.
static func matches_all_terms(haystack: String, terms: PackedStringArray) -> bool:
	var h := haystack.to_lower()
	for t in terms:
		if not h.contains(t):
			return false
	return true

func get_search_text() -> String:
	return _search.text if _search else ""

# Clear the search box and re-apply (empty) filtering — used when a host screen wants to
# jump to a library/block without a stale query hiding it.
func clear_search() -> void:
	if _search and not _search.text.is_empty():
		_search.text = ""
		_apply_filter("")

# Rebuild the filtered item list from the current search text. The "add" tile is chrome and
# always kept; everything else must match every space-separated term (AND) against its
# search_text (falling back to label when unset) plus its caption.
#
# Every realized cell is bound to a *_filtered index*, so once that list changes an existing
# cell at index i now shows the wrong item. Drop them all here so _update_visible rebuilds the
# window against the new list — without this a search would keep the pre-filter cells on screen.
func _recompute_filtered(filter: String) -> void:
	var terms := split_terms(filter)
	_filtered = []
	for item in _items:
		var haystack: String = (item.search_text if not item.search_text.is_empty() else item.label) + " " + item.caption
		if item.is_add or terms.is_empty() or matches_all_terms(haystack, terms):
			_filtered.append(item)
	_clear_active()

func _cell_height() -> float:
	return cell_size.y + (_CAPTION_H if show_captions else 0.0)

# Recompute columns, rebuild the row layout (cell rows + any section-divider rows) for the
# current width, then refresh which rows are realized. Called on populate, filter change,
# and width change (via _canvas.resized).
func _relayout() -> void:
	if not _canvas:
		return
	var avail := _canvas.size.x
	if avail <= 0.0:
		avail = _scroll.size.x
	if avail <= 0.0:
		return   # not laid out yet; _canvas.resized will call us again once it has a width
	var cols := maxi(1, int((avail + _H_SEP) / (cell_size.x + _H_SEP)))
	if cols != _cols:
		# The column count changed, so every cell's position is stale — drop them all and
		# let _update_visible rebuild the visible window at the new stride.
		_cols = cols
		_clear_active()
	_build_rows()
	_update_visible()

# Build the row layout from _filtered + _cols: a header row wherever an item's section
# differs from the running section (see Item.section), else cell rows packed up to _cols
# items — a cell row ends early rather than spanning a section boundary, so the following
# header always starts a fresh row. Rows are non-uniform height, so each records its own
# `y`/`height` rather than relying on a fixed stride — that's what lets _update_visible
# binary-search straight to the visible window instead of a plain idx/_cols division.
func _build_rows() -> void:
	_rows = []
	var y := 0.0
	var i := 0
	var n := _filtered.size()
	var current_section := ""
	var first := true
	while i < n:
		var item: Item = _filtered[i]
		if item.section != "" and (first or item.section != current_section):
			var header_h := _HEADER_H + _V_SEP
			_rows.append({"is_header": true, "title": item.section, "y": y, "height": header_h})
			y += header_h
		current_section = item.section
		first = false
		var row_start := i
		var count := 0
		while count < _cols and i < n and _filtered[i].section == current_section:
			i += 1
			count += 1
		var row_h := _cell_height() + _V_SEP
		_rows.append({"is_header": false, "start": row_start, "count": count, "y": y, "height": row_h})
		y += row_h
	_canvas.custom_minimum_size.y = maxf(0.0, y - _V_SEP)
	_last_row_start = -1
	_last_row_end = -1

# Binary search _rows (sorted by ascending y) for the index of the last row whose top is
# at or before `y` — i.e. the row containing `y`, or the row just before it if `y` falls in
# a gap. Returns -1 if every row starts after `y`.
func _find_row_at_y(y: float) -> int:
	var lo := 0
	var hi := _rows.size() - 1
	var res := -1
	while lo <= hi:
		@warning_ignore("integer_division")
		var mid := (lo + hi) / 2
		if _rows[mid]["y"] <= y:
			res = mid
			lo = mid + 1
		else:
			hi = mid - 1
	return res

# Realize exactly the rows in the viewport (± the buffer) and release the rest — both
# section-header rows and cell rows. Cells/headers are rebound as they approach view and
# pooled once they scroll well past, so the live node count stays proportional to the
# viewport, not the library size — and scrolling reuses nodes instead of allocating them,
# which is what keeps it smooth.
func _update_visible() -> void:
	if _canvas == null or _cols <= 0 or _rows.is_empty():
		_clear_active()
		return
	var top: float = _scroll.scroll_vertical
	var view_h: float = _scroll.size.y
	var first_row := maxi(0, _find_row_at_y(top) - _BUFFER_ROWS)
	var last_visible := _find_row_at_y(top + view_h)
	if last_visible < 0:
		last_visible = 0
	var last_row := mini(_rows.size() - 1, last_visible + _BUFFER_ROWS)

	# Most scroll ticks don't cross a row boundary; when the window is unchanged there's
	# nothing to rebuild, so bail before touching any nodes.
	if first_row == _last_row_start and last_row == _last_row_end:
		return
	_last_row_start = first_row
	_last_row_end = last_row

	# Release headers/cells that fell outside the window back to their pools.
	for ridx in _active_headers.keys():
		if ridx < first_row or ridx > last_row:
			_release_header(_active_headers[ridx])
			_active_headers.erase(ridx)
	var keep_idx := {}
	for ridx in range(first_row, last_row + 1):
		var row: Dictionary = _rows[ridx]
		if row["is_header"]:
			if _active_headers.has(ridx):
				_active_headers[ridx].size.x = _canvas.size.x   # canvas may have resized since bind
			else:
				_active_headers[ridx] = _bind_header(_acquire_header(), row)
		else:
			for idx in range(row["start"], row["start"] + row["count"]):
				keep_idx[idx] = true
	for idx in _active.keys():
		if not keep_idx.has(idx):
			_release(_active[idx])
			_active.erase(idx)
	for ridx in range(first_row, last_row + 1):
		var row: Dictionary = _rows[ridx]
		if row["is_header"]:
			continue
		for idx in range(row["start"], row["start"] + row["count"]):
			if not _active.has(idx):
				var col: int = idx - int(row["start"])
				var pos := Vector2(col * (cell_size.x + _H_SEP), row["y"])
				_active[idx] = _bind_cell(_acquire(), _filtered[idx], pos)

func _clear_active() -> void:
	for cell in _active.values():
		_release(cell)
	_active.clear()
	for hdr in _active_headers.values():
		_release_header(hdr)
	_active_headers.clear()
	_last_row_start = -1
	_last_row_end = -1

# A cell to (re)use: a pooled one if available, else a fresh node wired up once. The draw and
# input handlers read the bound item from meta (not a captured var), so a cell is item-agnostic
# and can be rebound to any index without reconnecting signals. Pooled cells stay children of
# _canvas (just hidden) so they're freed with the grid rather than leaking as orphans.
func _acquire() -> Control:
	if not _pool.is_empty():
		var reused: Control = _pool.pop_back()
		reused.visible = true
		return reused
	var cell := Control.new()
	cell.custom_minimum_size = Vector2(cell_size.x, _cell_height())
	# Pixel art stays crisp when the baked icon is drawn down into the cell.
	cell.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	cell.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	cell.draw.connect(func(): _draw_cell(cell, cell.get_meta("item")))
	cell.gui_input.connect(func(ev: InputEvent): _on_cell_input(ev, cell.get_meta("item")))
	_canvas.add_child(cell)
	return cell

# Hold a cell for reuse: hide it (so it stops drawing / handling input) but keep it parented.
func _release(cell: Control) -> void:
	cell.visible = false
	_pool.append(cell)

# Point a cell at an item + explicit pixel position (from the row it belongs to — no longer
# derivable from idx/_cols alone once section headers break the uniform grid).
func _bind_cell(cell: Control, item: Item, pos: Vector2) -> Control:
	cell.set_meta("item", item)
	cell.tooltip_text = item.label
	cell.position = pos
	cell.size = Vector2(cell_size.x, _cell_height())
	cell.queue_redraw()   # a reused cell keeps its old drawing until told to repaint
	return cell

# A section-divider row: a plain full-width Control drawing its title, pooled the same way
# as cells (see _acquire).
func _acquire_header() -> Control:
	if not _header_pool.is_empty():
		var reused: Control = _header_pool.pop_back()
		reused.visible = true
		return reused
	var hdr := Control.new()
	hdr.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hdr.draw.connect(func(): _draw_header(hdr, hdr.get_meta("title")))
	_canvas.add_child(hdr)
	return hdr

func _release_header(hdr: Control) -> void:
	hdr.visible = false
	_header_pool.append(hdr)

func _bind_header(hdr: Control, row: Dictionary) -> Control:
	hdr.set_meta("title", row["title"])
	hdr.position = Vector2(0, row["y"])
	hdr.size = Vector2(_canvas.size.x, _HEADER_H)   # row["height"] also reserves the trailing gap
	hdr.queue_redraw()
	return hdr

func _draw_header(hdr: Control, title: String) -> void:
	var font := get_theme_default_font()
	hdr.draw_line(Vector2(0, hdr.size.y - 2), Vector2(hdr.size.x, hdr.size.y - 2),
		Color(1, 1, 1, 0.15), 1.0)
	hdr.draw_string(font, Vector2(2, hdr.size.y - 8), title,
		HORIZONTAL_ALIGNMENT_LEFT, hdr.size.x - 4, 13, Color(1, 1, 1, 0.85))

func _draw_cell(cell: Control, item: Item) -> void:
	# Icon occupies a centered square in the top region; the caption strip (if any) sits below.
	var caption_h := _CAPTION_H if show_captions else 0.0
	var icon_area := Rect2(Vector2.ZERO, Vector2(cell.size.x, cell.size.y - caption_h))
	var side := minf(icon_area.size.x, icon_area.size.y)
	var off := (icon_area.size - Vector2(side, side)) * 0.5
	var icon_rect := Rect2(off, Vector2(side, side))

	if item.is_add:
		_draw_add_glyph(cell, icon_rect)
	else:
		var icon := _baker.icon_for(item.block_type) if item.block_type != null else null
		if icon != null:
			cell.draw_texture_rect(icon, icon_rect, false)
		else:
			_draw_placeholder(cell, item, icon_rect)

	if item.key == _selected:
		cell.draw_rect(icon_area, Color(0.40, 0.80, 1.0, 0.18))
		cell.draw_rect(icon_area, Color(0.40, 0.80, 1.0, 0.90), false, 2.0)

	if show_captions and not item.caption.is_empty():
		var font := get_theme_default_font()
		var baseline := cell.size.y - caption_h * 0.5 + 5.0
		cell.draw_string(font, Vector2(2, baseline), item.caption,
			HORIZONTAL_ALIGNMENT_CENTER, cell.size.x - 4, 11)

# The trailing "add new" tile: a dashed-ish outlined square with a centered "+".
func _draw_add_glyph(cell: Control, area: Rect2) -> void:
	var inset := area.size * 0.15
	var rect := Rect2(area.position + inset, area.size - inset * 2.0)
	cell.draw_rect(rect, Color(1, 1, 1, 0.08))
	cell.draw_rect(rect, Color(1, 1, 1, 0.35), false, 1.5)
	var font := get_theme_default_font()
	var plus_size := 28
	cell.draw_string(font, area.position + area.size * 0.5 - Vector2(plus_size * 0.28, -plus_size * 0.32),
		"+", HORIZONTAL_ALIGNMENT_CENTER, -1, plus_size, Color(1, 1, 1, 0.7))

# Shown while a bake is pending (or for an unmapped item): a faint centered swatch of the
# item's planning color, so the cell hints at the block without flashing.
func _draw_placeholder(cell: Control, item: Item, area: Rect2) -> void:
	var inset := area.size * 0.22
	var rect := Rect2(area.position + inset, area.size - inset * 2.0)
	var c := item.placeholder_color
	cell.draw_rect(rect, Color(c.r, c.g, c.b, 0.35))

func _on_icon_ready(block_name: String) -> void:
	_redraw_cells_for_block(block_name)

func _redraw_cells_for_block(block_name: String) -> void:
	for cell in _active.values():
		var item: Item = cell.get_meta("item")
		if item.block_type != null and item.block_type.name == block_name:
			cell.queue_redraw()

func _on_cell_input(ev: InputEvent, item: Item) -> void:
	if not (ev is InputEventMouseButton) or not (ev as InputEventMouseButton).pressed:
		return
	var mb := ev as InputEventMouseButton
	if mb.button_index == MOUSE_BUTTON_LEFT:
		set_selected(item.key)
		item_selected.emit(item.key)
		block_selected.emit(item.key)
	elif mb.button_index == MOUSE_BUTTON_RIGHT and not item.is_add:
		item_right_clicked.emit(item.key, mb.global_position)
