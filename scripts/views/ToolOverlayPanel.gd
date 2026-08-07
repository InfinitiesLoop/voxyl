class_name ToolOverlayPanel
extends PanelContainer

# Shared framing for a tool's middle-click overlay — the opaque bordered card, its title,
# and the content column that the owning tool fills. Paste was the first tool to grow one
# of these; the framing lives here (not inline in View3D) so every tool overlay looks and
# behaves the same and only the rows inside `content` vary by tool.
#
# The open/close *mechanism* (MMB frees the cursor to reveal the overlay, MMB or a click
# re-captures it to hide it) and the positioning live in View3D, which owns the fly state.
# A middle-click anywhere on the card — blank space included, not just the viewport behind
# it — closes it, so it's surfaced here as a signal for the view to re-capture the cursor.
signal close_requested

# The column tools add their rows to. Everything above it (title + separator) is fixed frame.
var content: VBoxContainer
var _title_label: Label

func _init(title: String = "") -> void:
	visible = false
	# STOP so clicks on the card (including blank space) don't fall through to the viewport;
	# the whole point of the overlay is a set of real, clickable controls over the 3D view.
	mouse_filter = Control.MOUSE_FILTER_STOP
	custom_minimum_size = Vector2(260, 0)

	# Opaque bordered card (same recipe the paste popup used inline) — a bare PanelContainer
	# falls back to the theme's default panel style, which reads as translucent over the view.
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.13, 0.14, 0.17, 1.0)
	sb.border_color = Color(0.42, 0.47, 0.58)
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(10)
	sb.set_content_margin_all(16)
	sb.shadow_color = Color(0, 0, 0, 0.5)
	sb.shadow_size = 12
	add_theme_stylebox_override("panel", sb)

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 10)
	add_child(col)

	_title_label = Label.new()
	_title_label.text = title
	_title_label.add_theme_font_size_override("font_size", 20)
	col.add_child(_title_label)
	col.add_child(HSeparator.new())

	content = VBoxContainer.new()
	content.add_theme_constant_override("separation", 8)
	col.add_child(content)

func set_title(text: String) -> void:
	_title_label.text = text

func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed \
			and (event as InputEventMouseButton).button_index == MOUSE_BUTTON_MIDDLE:
		close_requested.emit()
		accept_event()
