class_name BlockPreview3D
extends Control

# A real, rotatable 3D render of a single library block, for the Block Types detail
# panel. It mirrors View3D's viewport/light/material setup but frames one centered
# block instead of a project: same shared BlockMesher geometry and the same
# NEAREST-filtered textured materials, so a block looks identical here and in-scene.
#
# It resolves model + textures straight from the BlockType (library blocks aren't in
# any project/palette), staying a lens on the material layer — no voxel data involved.

# Look direction the camera sits along (normalized); zoom scales the distance. Kept in
# sync with BlockIconBaker so the live preview and the baked grid icon read the same: a
# raised 3/4 view from the -X/-Z side, so MC stairs (default model opens toward -X) show
# their stepped face toward the camera, not their solid back.
const _CAM_DIR := Vector3(-0.9, 1.0, -1.2)
const _AUTO_SPIN := 0.6   # radians/sec idle rotation

# Selectable layouts, shown so a block can be judged in context (a lone block, a 1×3
# column, a 3×3 wall) instead of only by itself. Cols × rows in the XY plane, so the
# patch stands up vertically like a wall rather than lying flat as a floor.
const _LAYOUTS := [
	{"label": "1×1", "size": Vector2i(1, 1)},
	{"label": "1×3", "size": Vector2i(1, 3)},
	{"label": "3×3", "size": Vector2i(3, 3)},
]

var _viewport: SubViewport
var _camera: Camera3D
var _pivot: Node3D

var _block: BlockType         # current block, re-instanced per layout change
var _layout := Vector2i(1, 1)  # cols × rows currently rendered

# Last layout chosen by the user, in this session. HomeScreen tears down and rebuilds a
# fresh BlockPreview3D every time a different block is selected, so a plain instance var
# would silently reset to 1×1 each time — keep the choice on the class instead so it
# carries over as the user browses different block types.
static var _last_layout := Vector2i(1, 1)

var _cam_dist := 2.6
var _dragging := false
var _drag_last := Vector2.ZERO

func _ready() -> void:
	var svc := SubViewportContainer.new()
	svc.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	svc.stretch = true
	svc.gui_input.connect(_on_svc_input)
	add_child(svc)

	_viewport = SubViewport.new()
	_viewport.transparent_bg = true
	_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	# Isolate the preview in its own World3D. Otherwise the SubViewport shares the
	# window's world with the (possibly hidden) View3D panes, whose sky sphere, grid
	# plane and lights would bleed into the preview behind the block.
	_viewport.own_world_3d = true
	svc.add_child(_viewport)

	# Shared lighting rig (kept identical to the baked grid icons via BlockLightRig) so
	# the rotatable preview and the grid swatch read the same. Lower ambient + a stronger
	# key give shaded, saturated faces instead of the flat, washed-out look of heavy fill.
	# The key light follows the camera direction so the faces in view stay lit.
	BlockLightRig.apply(_viewport, _CAM_DIR)

	_camera = Camera3D.new()
	_viewport.add_child(_camera)
	_update_camera()

	_pivot = Node3D.new()
	_viewport.add_child(_pivot)

	_layout = _last_layout
	_build_layout_bar()
	set_process(true)

func _process(delta: float) -> void:
	if not _dragging and is_visible_in_tree():
		_pivot.rotation.y += delta * _AUTO_SPIN

# Render `bt` (or clear when null) via the shared BlockRender3D builder, so this
# rotatable preview and the baked grid icons resolve geometry + materials the same way.
func set_block(bt: BlockType) -> void:
	_block = bt
	_rebuild_layout()

# Rebuild the rendered patch: one freshly-built MeshInstance3D per cell of the current
# layout, arranged in the XY plane (cols across, rows up) and centered on the pivot so
# it spins about the middle. Fresh instances mean stale per-surface overrides never
# linger across blocks/layouts.
func _rebuild_layout() -> void:
	for c in _pivot.get_children():
		c.queue_free()
	if _block == null:
		return
	var cols := _layout.x
	var rows := _layout.y
	for cx in cols:
		for cy in rows:
			var mi := MeshInstance3D.new()
			_pivot.add_child(mi)
			BlockRender3D.build_into(mi, _block)
			mi.position = Vector3(cx - (cols - 1) * 0.5, cy - (rows - 1) * 0.5, 0.0)
	# Pull the camera back so the whole patch frames, resetting any prior zoom.
	_cam_dist = _base_dist_for_layout()
	_update_camera()

# Camera distance that frames the current patch: the single-block default, grown by the
# patch's largest side so a 3×3 reads at the same on-screen size as a 1×1.
func _base_dist_for_layout() -> float:
	return 2.6 + float(maxi(_layout.x, _layout.y) - 1) * 1.4

# --- Input: drag-to-spin + scroll-to-zoom -----------------------------------

func _on_svc_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		match mb.button_index:
			MOUSE_BUTTON_LEFT:
				_dragging = mb.pressed
				_drag_last = mb.position
			MOUSE_BUTTON_WHEEL_UP:
				if mb.pressed:
					_cam_dist = clampf(_cam_dist - 0.3, 1.5, 10.0)
					_update_camera()
			MOUSE_BUTTON_WHEEL_DOWN:
				if mb.pressed:
					_cam_dist = clampf(_cam_dist + 0.3, 1.5, 10.0)
					_update_camera()
	elif event is InputEventMouseMotion and _dragging:
		var rel := (event as InputEventMouseMotion).relative
		_pivot.rotation.y -= rel.x * 0.01
		_pivot.rotation.x = clampf(_pivot.rotation.x - rel.y * 0.01, -1.3, 1.3)

# --- Internals --------------------------------------------------------------

# A centered row of layout toggles pinned along the bottom of the viewport. The row
# itself ignores the mouse so drag-to-spin still works in the empty space around the
# buttons; only the buttons capture clicks. They share a ButtonGroup so the active
# footprint stays visibly pressed.
func _build_layout_bar() -> void:
	var bar := HBoxContainer.new()
	bar.anchor_left = 0.0; bar.anchor_right = 1.0
	bar.anchor_top = 1.0; bar.anchor_bottom = 1.0
	bar.offset_top = -36; bar.offset_bottom = -8
	bar.alignment = BoxContainer.ALIGNMENT_CENTER
	bar.add_theme_constant_override("separation", 4)
	bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var group := ButtonGroup.new()
	for layout in _LAYOUTS:
		var btn := Button.new()
		btn.text = layout["label"]
		btn.toggle_mode = true
		btn.button_group = group
		btn.focus_mode = Control.FOCUS_NONE
		if layout["size"] == _layout:
			btn.button_pressed = true
		var footprint: Vector2i = layout["size"]
		btn.pressed.connect(func(): _set_layout(footprint))
		bar.add_child(btn)
	add_child(bar)

func _set_layout(footprint: Vector2i) -> void:
	if footprint == _layout:
		return
	_layout = footprint
	_last_layout = footprint
	_rebuild_layout()

func _update_camera() -> void:
	if not _camera:
		return
	_camera.position = _CAM_DIR.normalized() * _cam_dist
	_camera.look_at(Vector3.ZERO, Vector3.UP)
