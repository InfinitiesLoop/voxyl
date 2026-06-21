class_name PaneDropLayer
extends Control

# A document-area-wide overlay that becomes a drop target only while a tab is
# being dragged. It catches drops anywhere over the panes — body, tab bar, or an
# empty pane — and routes them to MultiViewShell, and draws the hover highlight.
# (Dropping on a tab bar alone left empty panes unreachable.)

var shell: MultiViewShell
var hover_rect := Rect2()

func _can_drop_data(_at_position: Vector2, data: Variant) -> bool:
	return shell != null and shell.is_tab_drag(data)

func _drop_data(_at_position: Vector2, data: Variant) -> void:
	if shell:
		shell.drop_tab(data, get_global_mouse_position())

func _draw() -> void:
	if hover_rect.size.x > 0.0 and hover_rect.size.y > 0.0:
		draw_rect(hover_rect, Color(0.3, 0.72, 1.0, 0.12))
		draw_rect(Rect2(hover_rect.position + Vector2.ONE, hover_rect.size - Vector2(2, 2)),
			Color(0.3, 0.72, 1.0, 0.95), false, 2.0)
