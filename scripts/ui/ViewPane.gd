class_name ViewPane
extends TabContainer

# A leaf of the tiling shell: a tab-group of view instances. MultiViewShell
# creates, splits, collapses, and re-tiles panes; this class only manages its
# own tabs, announces clicks for focus, and reports when it becomes empty.

signal pane_focus_requested(pane: ViewPane)
signal pane_emptied(pane: ViewPane)

# Shared id so a tab can be dragged from any pane into any other (Godot native).
const REARRANGE_GROUP := 42

func _ready() -> void:
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	drag_to_rearrange_enabled = true
	tabs_rearrange_group = REARRANGE_GROUP
	var tb := get_tab_bar()
	# TabContainer forwards the rearrange group to its TabBar but NOT the
	# drag-enabled flag, so set it on the bar directly or cross-pane drops are
	# rejected (the dragged tab shows the "no drop" cursor).
	tb.drag_to_rearrange_enabled = true
	tb.tabs_rearrange_group = REARRANGE_GROUP
	tb.tab_close_display_policy = TabBar.CLOSE_BUTTON_SHOW_ACTIVE_ONLY
	tb.tab_close_pressed.connect(_on_tab_close_pressed)
	tab_clicked.connect(func(_t): pane_focus_requested.emit(self))
	child_entered_tree.connect(func(_n): call_deferred("_retitle"))
	child_exiting_tree.connect(func(_n): call_deferred("_check_empty"))

func _on_tab_close_pressed(tab: int) -> void:
	var ctrl := get_tab_control(tab)
	if ctrl:
		remove_child(ctrl)
		ctrl.queue_free()

func _check_empty() -> void:
	if is_inside_tree() and get_tab_count() == 0:
		pane_emptied.emit(self)

# Each view stores its tab label as meta so the title survives a cross-pane drag
# (TabContainer otherwise falls back to the node's sanitized name).
func _retitle() -> void:
	for i in get_tab_count():
		var c := get_tab_control(i)
		if c and c.has_meta("tab_title"):
			set_tab_title(i, c.get_meta("tab_title"))
