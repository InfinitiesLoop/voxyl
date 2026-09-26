class_name ImportProgressDialog
extends Window

# Modal progress + result window for a block import. A big vanilla import is hundreds
# of texture decodes/copies; running it in one blocking call freezes the window. This
# drives ImportService's incremental API, awaiting a frame every batch so the bar and
# label actually repaint on the main thread, then shows the result and — crucially —
# lets the user SEE the warnings (a bare "1706 warnings" is useless), categorized so
# they're digestible.

const _BATCH := 16          # blocks per frame; small enough to keep the UI live

# Fired when the user dismisses this dialog (Close button or the window's own close box),
# after warnings are shown. The opener (ImportPanel) awaits this to know when the report has
# actually been read, rather than just when the import work finished.
signal dismissed

var _bar: ProgressBar
var _status: Label
var _warn_summary: Label
var _warn_box: TextEdit
var _close_btn: Button

# A little fun instead of a bare progress bar: a filmstrip of the textures scrolling past as
# they import, with a center marker to sell "looking through a long list" — purely cosmetic,
# updated on the same cadence as the bar so it costs about what the bar already did.
const _THUMB_PX := 32
const _THUMB_GAP := 4
const _STRIP_LEN := 15   # odd, so one thumbnail sits exactly under the center marker
var _strip_row: HBoxContainer
var _recent_textures: Array[Texture2D] = []

func _ready() -> void:
	title = "Importing Blocks"
	size = Vector2i(520, 460)
	min_size = Vector2i(420, 320)
	exclusive = true
	close_requested.connect(_on_close)
	_build()

func _build() -> void:
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 14)
	add_child(margin)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 10)
	margin.add_child(vbox)

	_status = Label.new()
	_status.text = "Preparing…"
	vbox.add_child(_status)

	_bar = ProgressBar.new()
	_bar.min_value = 0
	_bar.value = 0
	vbox.add_child(_bar)

	vbox.add_child(_build_filmstrip())

	_warn_summary = Label.new()
	_warn_summary.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_warn_summary.visible = false
	vbox.add_child(_warn_summary)

	# Read-only, scrollable list of the actual warning lines (hidden until there are any).
	_warn_box = TextEdit.new()
	_warn_box.editable = false
	_warn_box.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_warn_box.scroll_fit_content_height = false
	_warn_box.visible = false
	vbox.add_child(_warn_box)

	_close_btn = Button.new()
	_close_btn.text = "Close"
	_close_btn.disabled = true
	_close_btn.size_flags_horizontal = Control.SIZE_SHRINK_END
	_close_btn.pressed.connect(_on_close)
	vbox.add_child(_close_btn)

# Run the import to completion, updating the bar across frames. Awaitable: the caller
# can `await run(...)` and then refresh, while the window stays open for the user to
# read warnings until they close it.
func run(service: ImportService, selection: Array) -> void:
	var total := service.begin_import(selection)
	_bar.max_value = maxi(total, 1)
	for i in total:
		service.import_step(i)
		if (i % _BATCH) == 0 or i == total - 1:
			_bar.value = i + 1
			_status.text = "Importing %d / %d…" % [i + 1, total]
			# The just-copied texture's PNG write may still be outstanding on a worker thread
			# (see MCTexImport.use_threads) — only ever flushed for real at end_import(), well
			# after this loop. Flush here too, just for the filmstrip's read, so it's not
			# racing an unwritten file; at most _BATCH writes outstanding, so this is cheap.
			MCTexImport.flush_writes()
			_push_texture(service.last_imported, service.last_imported_library)
			await get_tree().process_frame
	_status.text = "Saving library…"
	await get_tree().process_frame
	service.end_import()

	# Pre-bake the fresh blocks' preview icons into the shared disk cache so the block
	# grid shows them instantly instead of popping in lazily. The bar tracks it as a
	# second phase; the icons themselves are still resolved lazily elsewhere — this only
	# warms the cache. Baking needs the scene tree + a frame per batch, which this modal
	# (already in the tree, already pumping frames) provides.
	# Skip with no real display (headless tests): baking renders through off-screen
	# viewports, and RenderingServer.frame_post_draw never fires under the dummy driver, so
	# there'd be nothing to await and no grid to warm anyway.
	var imported := service.imported_block_types()
	if not imported.is_empty() and DisplayServer.get_name() != "headless":
		_status.text = "Baking previews…"
		_bar.value = 0
		var baker := BlockIconBaker.new()
		# This runs behind our modal, so favor bake throughput over UI smoothness with a bigger
		# atlas grid than the interactive default (see BlockIconBaker.batch): an 8×8 grid was the
		# wall-time sweet spot in benching — heavier per frame, but frame time doesn't matter
		# behind a modal, and going larger stopped helping once the readback left the hot path.
		baker.batch = 64
		add_child(baker)
		await baker.prebake(imported, func(baked: int, count: int) -> void:
			_bar.max_value = maxi(count, 1)
			_bar.value = baked
			_status.text = "Baking previews… %d / %d" % [baked, count])
		baker.free()
		_bar.value = _bar.max_value

	var w := service.warnings.size()
	_status.text = "Imported %d block(s)%s." % [
		service.imported_count, ("  (%d warning(s))" % w) if w > 0 else ""]
	_bar.value = _bar.max_value
	_show_warnings(service.warnings)
	_close_btn.disabled = false

# Prefix NeiRosterImporter.finalize() writes ("no texture match, dropped: N block(s) in X") —
# recognized here so the summary can total the real block count instead of the line count.
const _DROPPED_PREFIX := "no texture match, dropped: "

# The N from a "no texture match, dropped: N block(s) in X" line, or -1 if `line` isn't one.
static func _dropped_block_count(line: String) -> int:
	if not line.begins_with(_DROPPED_PREFIX):
		return -1
	var rest := line.substr(_DROPPED_PREFIX.length())
	var space := rest.find(" ")
	if space <= 0 or not rest.substr(0, space).is_valid_int():
		return -1
	return int(rest.substr(0, space))

# Show the warnings: a category summary (per message-prefix, the part before the first ':')
# up top, and the full list below so nothing is hidden. A category whose lines each carry
# their own "N block(s)" count (see _dropped_block_count) sums those Ns instead of just
# counting lines — otherwise the summary showed "133" (one line per mod) right above detail
# lines reading "5354 block(s) in gregtech", which never added up to anything a reader could
# reconcile.
func _show_warnings(warnings: Array) -> void:
	if warnings.is_empty():
		return
	var line_counts := {}    # category -> number of warning lines
	var block_totals := {}   # category -> summed block count, only for lines that carry one
	for w in warnings:
		var line := str(w)
		var cat := line
		var colon := cat.find(":")
		if colon > 0:
			cat = cat.substr(0, colon)
		line_counts[cat] = int(line_counts.get(cat, 0)) + 1
		var n := _dropped_block_count(line)
		if n >= 0:
			block_totals[cat] = int(block_totals.get(cat, 0)) + n
	var cats := line_counts.keys()
	cats.sort_custom(func(a, b): return line_counts[a] > line_counts[b])
	var summary := PackedStringArray()
	for c in cats:
		if block_totals.has(c):
			summary.append("• %s: %d block(s) across %d mod(s)" % [c, block_totals[c], line_counts[c]])
		else:
			summary.append("• %s: %d" % [c, line_counts[c]])
	_warn_summary.text = "Some blocks couldn't be fully translated (this is normal for a full game import):\n" + "\n".join(summary)
	_warn_summary.visible = true
	_warn_box.text = "\n".join(warnings)
	_warn_box.visible = true

func _on_close() -> void:
	dismissed.emit()
	queue_free()

# A fixed-height strip of recent textures with a center marker line drawn over them — the
# marker never moves; thumbnails shift in from the right and drop off the left as they import,
# so whichever one is passing under the marker reads as "the one being looked at right now".
func _build_filmstrip() -> Control:
	var clip := Control.new()
	clip.clip_contents = true
	clip.custom_minimum_size = Vector2(0, _THUMB_PX)
	_strip_row = HBoxContainer.new()
	_strip_row.add_theme_constant_override("separation", _THUMB_GAP)
	# Right-aligned within a FULL-rect anchor, not a manually-offset one sized to fit the row
	# itself — at build time the row has no children yet, so anchoring straight to its own
	# (then-zero) size would freeze it at zero width forever; a Control's size only follows
	# its children automatically through a Container's own layout, not through one-off anchors.
	# Full-rect + END alignment hugs new thumbnails to the right, with older ones pushed past
	# the left edge and clipped by `clip` above as the strip fills — the scrolling look, for free.
	_strip_row.alignment = BoxContainer.ALIGNMENT_END
	_strip_row.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	clip.add_child(_strip_row)
	var marker := ColorRect.new()
	marker.color = Color(1, 1, 1, 0.55)
	marker.mouse_filter = Control.MOUSE_FILTER_IGNORE
	marker.set_anchors_and_offsets_preset(Control.PRESET_CENTER_TOP)
	marker.offset_left = -1
	marker.offset_right = 1
	marker.offset_top = 0
	marker.offset_bottom = _THUMB_PX
	clip.add_child(marker)
	return clip

# Slide a newly-imported block's texture into the strip (front of the array = rightmost/
# newest), dropping the oldest once it's full. Silently does nothing without a texture — a
# failed step, or a block whose model has none — so the reel just holds its last frame.
func _push_texture(bt: BlockType, lib: BlockLibrary) -> void:
	if bt == null or lib == null:
		return
	var tex := _texture_for(bt, lib)
	if tex == null:
		return
	_recent_textures.append(tex)
	while _recent_textures.size() > _STRIP_LEN:
		_recent_textures.pop_front()
	for c in _strip_row.get_children():
		_strip_row.remove_child(c)
		c.queue_free()
	for t in _recent_textures:
		var r := TextureRect.new()
		r.texture = t
		r.custom_minimum_size = Vector2(_THUMB_PX, _THUMB_PX)
		r.stretch_mode = TextureRect.STRETCH_SCALE
		r.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		_strip_row.add_child(r)

# Any one texture off the block's model, just for the filmstrip's sake — which face doesn't
# matter, this is decorative, not a real preview.
func _texture_for(bt: BlockType, lib: BlockLibrary) -> Texture2D:
	var model := lib.get_block_model(bt.model_id)
	if model == null or model.textures.is_empty():
		return null
	var asset := lib.get_texture_asset(str(model.textures.values()[0]))
	return BlockTextureCache.face_texture(asset) if asset != null else null
