class_name ImportProgressDialog
extends Window

# Modal progress + result window for a block import. A big vanilla import is hundreds
# of texture decodes/copies; running it in one blocking call freezes the window. This
# drives ImportService's incremental API, awaiting a frame every batch so the bar and
# label actually repaint on the main thread, then shows the result and — crucially —
# lets the user SEE the warnings (a bare "1706 warnings" is useless), categorized so
# they're digestible.

const _BATCH := 16          # blocks per frame; small enough to keep the UI live

var _bar: ProgressBar
var _status: Label
var _warn_summary: Label
var _warn_box: TextEdit
var _close_btn: Button

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
			await get_tree().process_frame
	_status.text = "Saving library…"
	await get_tree().process_frame
	service.end_import()

	var w := service.warnings.size()
	_status.text = "Imported %d block(s)%s." % [
		service.imported_count, ("  (%d warning(s))" % w) if w > 0 else ""]
	_bar.value = _bar.max_value
	_show_warnings(service.warnings)
	_close_btn.disabled = false

# Show the warnings: a category summary (count per message-prefix, the part before the
# first ':') up top, and the full list below so nothing is hidden.
func _show_warnings(warnings: Array) -> void:
	if warnings.is_empty():
		return
	var counts := {}
	for w in warnings:
		var cat := str(w)
		var colon := cat.find(":")
		if colon > 0:
			cat = cat.substr(0, colon)
		counts[cat] = int(counts.get(cat, 0)) + 1
	var cats := counts.keys()
	cats.sort_custom(func(a, b): return counts[a] > counts[b])
	var summary := PackedStringArray()
	for c in cats:
		summary.append("• %s: %d" % [c, counts[c]])
	_warn_summary.text = "Some blocks couldn't be fully translated (this is normal for a full game import):\n" + "\n".join(summary)
	_warn_summary.visible = true
	_warn_box.text = "\n".join(warnings)
	_warn_box.visible = true

func _on_close() -> void:
	queue_free()
