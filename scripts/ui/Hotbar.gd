class_name Hotbar
extends Control

# The single, view-agnostic toolbar. It lives in the editor chrome (not inside any
# view) and drives VoxelWorld's shared hotbar state, so 2D and 3D edits all place
# the same selected block. Twelve slots; each holds a semantic name ("" = empty) and
# shows a baked preview of the block it resolves to plus that semantic's name.
#
# Interactions:
#   • Left-click a slot          → make it the active (selected) slot
#   • Right-click a slot         → clear it
#   • 1–9, 0                     → select that slot (slots 11+ via wheel / click)
#   • E / Del                    → open the inventory to load slots (see InventoryScreen)
# Blocks are loaded into slots from the inventory screen (Minecraft-style), not from a
# palette list. This same control is embedded in that screen so the active-slot
# highlight stays in sync. The 3D and 2D views feed it too (e.g. 3D middle-click "pick
# block"). Block orientation is not a global mode — it's chosen per placement.
# A generic palette_block drop is still accepted so a future drag source can feed it.

const SLOT := 58.0
const GAP := 6.0
const CAPTION_H := 16.0  # name strip drawn beneath each slot

var _hover_drop := -1  # slot currently under a palette-block drag, or -1
var _baker: BlockIconBaker  # bakes the real 3D icon for each slot's block

func _ready() -> void:
	custom_minimum_size = Vector2(0, SLOT + CAPTION_H + 14.0)
	mouse_filter = Control.MOUSE_FILTER_STOP
	# Baked icons are pixel art when textured; keep them crisp when scaled into a slot.
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_baker = BlockIconBaker.new()
	_baker.batch = VoxelWorld.HOTBAR_SIZE  # only ever a dozen slots to bake
	add_child(_baker)
	_baker.icon_ready.connect(func(_n): queue_redraw())
	VoxelWorld.hotbar_changed.connect(queue_redraw)
	VoxelWorld.active_slot_changed.connect(func(_s): queue_redraw())
	VoxelWorld.selection_changed.connect(func(_s): queue_redraw())
	VoxelWorld.palette_stack_changed.connect(_on_appearance_changed)
	VoxelWorld.block_type_changed.connect(_on_appearance_changed)
	VoxelWorld.project_opened.connect(func(_p): queue_redraw())
	gui_input.connect(_on_gui_input)

# A palette/block-type edit can change what a slot's semantic resolves to, so drop the
# baked icons and re-bake on the next draw.
func _on_appearance_changed() -> void:
	if _baker:
		_baker.invalidate_all()
	queue_redraw()

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

func _row_origin() -> Vector2:
	var total := VoxelWorld.HOTBAR_SIZE * SLOT + (VoxelWorld.HOTBAR_SIZE - 1) * GAP
	# Center the slot+caption block vertically so the name strip has room below.
	return Vector2((size.x - total) * 0.5, (size.y - (SLOT + CAPTION_H)) * 0.5)

func _slot_rect(i: int) -> Rect2:
	var o := _row_origin()
	return Rect2(o.x + i * (SLOT + GAP), o.y, SLOT, SLOT)

func _slot_at(pos: Vector2) -> int:
	for i in VoxelWorld.HOTBAR_SIZE:
		if _slot_rect(i).has_point(pos):
			return i
	return -1

# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

func _on_gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		var mb := event as InputEventMouseButton
		var slot := _slot_at(mb.position)
		if slot < 0:
			return
		if mb.button_index == MOUSE_BUTTON_LEFT:
			VoxelWorld.select_slot(slot)
			accept_event()
		elif mb.button_index == MOUSE_BUTTON_RIGHT:
			VoxelWorld.set_hotbar_slot(slot, "")
			accept_event()

# Number keys select slots no matter where focus is — but only when an edit view
# isn't already consuming them (3D fly-mode marks them handled first).
func _unhandled_input(event: InputEvent) -> void:
	if not is_visible_in_tree() or not VoxelWorld.active_project:
		return
	if not (event is InputEventKey) or not (event as InputEventKey).pressed:
		return
	var kc := (event as InputEventKey).keycode
	if kc >= KEY_1 and kc <= KEY_9:
		VoxelWorld.select_slot(kc - KEY_1)
		get_viewport().set_input_as_handled()
	elif kc == KEY_0:
		VoxelWorld.select_slot(9)  # the tenth slot
		get_viewport().set_input_as_handled()

# ---------------------------------------------------------------------------
# Drag & drop from the palette
# ---------------------------------------------------------------------------

func _can_drop_data(at_position: Vector2, data: Variant) -> bool:
	var ok: bool = data is Dictionary and (data as Dictionary).get("type", "") == "palette_block"
	var slot := _slot_at(at_position) if ok else -1
	if slot != _hover_drop:
		_hover_drop = slot
		queue_redraw()
	return ok and slot >= 0

func _drop_data(at_position: Vector2, data: Variant) -> void:
	var slot := _slot_at(at_position)
	if slot < 0:
		slot = VoxelWorld.active_slot
	VoxelWorld.set_hotbar_slot(slot, (data as Dictionary).get("semantic", ""))
	VoxelWorld.select_slot(slot)
	_hover_drop = -1
	queue_redraw()

func _notification(what: int) -> void:
	if what == NOTIFICATION_DRAG_END and _hover_drop != -1:
		_hover_drop = -1
		queue_redraw()

# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

func _draw() -> void:
	var font := ThemeDB.fallback_font
	var has_project := VoxelWorld.active_project != null
	for i in VoxelWorld.HOTBAR_SIZE:
		var rect := _slot_rect(i)
		var semantic := VoxelWorld.hotbar[i] if has_project and i < VoxelWorld.hotbar.size() else ""
		var is_active := i == VoxelWorld.active_slot
		# Dark recessed slot background under everything.
		draw_rect(rect, Color(0.16, 0.16, 0.18))
		if semantic.is_empty():
			draw_string(font, rect.position + Vector2(SLOT * 0.5 - 4.0, SLOT * 0.5 + 6.0),
				"+", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(1, 1, 1, 0.18))
		else:
			var bt := VoxelWorld.get_block_type_object_for_semantic(semantic)
			var icon := _baker.icon_for(bt) if bt else null
			if icon != null:
				draw_texture_rect(icon, rect.grow(-3), false)
			else:
				# Until the icon bakes (or for an unmapped semantic): the planning color
				# plus a shape silhouette, so the slot still reads at a glance.
				var color := VoxelWorld.get_color_for_semantic(semantic)
				draw_rect(rect.grow(-5), color)
				_draw_shape_hint(rect, VoxelWorld.get_shape_for_semantic(semantic))
			_draw_caption(font, rect, semantic, is_active)
		# Selection / hover-drop frame.
		if i == _hover_drop:
			draw_rect(rect.grow(1), Color(1.0, 0.85, 0.3, 0.95), false, 2.5)
		else:
			draw_rect(rect, Color(1, 1, 1, 0.85 if is_active else 0.2), false,
				2.5 if is_active else 1.0)
		var key_hint := _key_hint(i)
		if not key_hint.is_empty():
			draw_string(font, rect.position + Vector2(4.0, 13.0), key_hint,
				HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(1, 1, 1, 0.65))

# The semantic name assigned to a slot, drawn (and clipped) in the strip below it.
func _draw_caption(font: Font, rect: Rect2, semantic: String, is_active: bool) -> void:
	var col := Color(1, 1, 1, 0.95 if is_active else 0.6)
	draw_string(font, Vector2(rect.position.x - GAP * 0.5, rect.end.y + 12.0), semantic,
		HORIZONTAL_ALIGNMENT_CENTER, SLOT + GAP, 10, col)

# The number-key label for a slot: 1–9 for the first nine, 0 for the tenth, and
# nothing for any extra slots (reachable only by scroll wheel or click).
func _key_hint(i: int) -> String:
	if i < 9:
		return str(i + 1)
	if i == 9:
		return "0"
	return ""

# A small monochrome silhouette so slabs/stairs read differently from cubes.
func _draw_shape_hint(rect: Rect2, shape: BlockType.Shape) -> void:
	var c := Color(0, 0, 0, 0.35)
	match shape:
		BlockType.Shape.SLAB:
			draw_rect(Rect2(rect.position + Vector2(8, SLOT - 16), Vector2(SLOT - 16, 8)), c)
		BlockType.Shape.STAIRS:
			draw_rect(Rect2(rect.position + Vector2(8, SLOT - 16), Vector2(SLOT - 16, 8)), c)
			draw_rect(Rect2(rect.position + Vector2(SLOT - 20, SLOT - 26), Vector2(12, 10)), c)
