class_name SearchablePicker
extends PopupPanel

# A generic "pick one name from a searchable list" popup — the reusable replacement for
# any plain OptionButton listing every candidate, which stops scaling once there are more
# than a handful (e.g. picking a library to subscribe a palette to, out of a whole
# workspace's worth). Not block-aware — plain strings, no icons — so it fits anywhere a
# name needs picking out of a long flat list.

signal picked(name: String)

var _candidates: Array = []
var _search: LineEdit
var _list: VBoxContainer

func _ready() -> void:
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["margin_left", "margin_right", "margin_top", "margin_bottom"]:
		margin.add_theme_constant_override(side, 10)
	add_child(margin)

	var vbox := VBoxContainer.new()
	vbox.size_flags_vertical = Control.SIZE_EXPAND_FILL
	margin.add_child(vbox)

	_search = LineEdit.new()
	_search.placeholder_text = "Search…"
	_search.clear_button_enabled = true
	_search.text_changed.connect(_rebuild_list)
	vbox.add_child(_search)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	vbox.add_child(scroll)

	_list = VBoxContainer.new()
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_list)

	popup_hide.connect(queue_free)

	if not _candidates.is_empty():
		_rebuild_list("")
	_search.grab_focus()

# Candidates to offer, e.g. every library a palette isn't already subscribed to.
func configure(candidates: Array) -> void:
	_candidates = candidates
	if _list:
		_rebuild_list(_search.text if _search else "")

func _rebuild_list(filter: String) -> void:
	for c in _list.get_children():
		c.queue_free()
	var terms := BlockGrid.split_terms(filter)
	for candidate_name in _candidates:
		if not terms.is_empty() and not BlockGrid.matches_all_terms(candidate_name, terms):
			continue
		var btn := Button.new()
		btn.text = candidate_name
		btn.flat = true
		btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
		var captured := candidate_name as String
		btn.pressed.connect(func():
			picked.emit(captured)
			hide())
		_list.add_child(btn)
