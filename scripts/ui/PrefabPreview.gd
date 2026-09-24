class_name PrefabPreview
extends Control

# A live, orbitable 3D look at a prefab through its preferred palettes, with no project open:
# an offscreen-flagged View3D (so it never takes editing input or touches the open build)
# whose source is the prefab's stand-in project. Drag to orbit, wheel to zoom.

var _view: View3D
var _prefab: Prefab
var _yaw := 135.0      # compass bearing the camera looks from (se)
var _elev := 28.0
var _zoom := 1.0
var _dragging := false

func _ready() -> void:
	clip_contents = true
	_view = View3D.new()
	_view.offscreen = true
	add_child(_view)
	_view.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_view.set_active(false)
	_view.set_cutaway_override([])
	var opts := ViewOptions.defaults()
	opts.merge(CaptureService.THUMB_RENDER, true)
	_view.set_render_options(opts)
	# Input goes to this catcher, not the view (an offscreen view ignores it anyway).
	var catcher := Control.new()
	catcher.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	catcher.mouse_filter = Control.MOUSE_FILTER_STOP
	catcher.gui_input.connect(_on_input)
	add_child(catcher)
	resized.connect(_update_camera)
	if _prefab != null:
		show_prefab(_prefab)

func show_prefab(prefab: Prefab) -> void:
	_prefab = prefab
	if _view == null or prefab == null:
		return
	_view.set_source_project(CaptureService.prefab_stage(prefab))
	_update_camera()

func _process(_delta: float) -> void:
	if _view != null and is_visible_in_tree():
		_view.flush_pending()   # offscreen views hold their rebuilds until asked

func _on_input(ev: InputEvent) -> void:
	if ev is InputEventMouseButton:
		var mb := ev as InputEventMouseButton
		match mb.button_index:
			MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT, MOUSE_BUTTON_MIDDLE:
				_dragging = mb.pressed
			MOUSE_BUTTON_WHEEL_UP:
				if mb.pressed:
					_zoom = maxf(0.25, _zoom / 1.12)
					_update_camera()
			MOUSE_BUTTON_WHEEL_DOWN:
				if mb.pressed:
					_zoom = minf(4.0, _zoom * 1.12)
					_update_camera()
	elif ev is InputEventMouseMotion and _dragging:
		var mm := ev as InputEventMouseMotion
		_yaw = fposmod(_yaw - mm.relative.x * 0.4, 360.0)
		_elev = clampf(_elev + mm.relative.y * 0.3, -10.0, 89.0)
		_update_camera()

func _update_camera() -> void:
	if _view == null or _prefab == null or size.x < 2.0 or size.y < 2.0:
		return
	var px := Vector2i(size)
	var pose := CaptureService.prefab_pose(_prefab, _yaw, _elev, px, false, 40.0)
	var target: Vector3 = pose["target"]
	var pos: Vector3 = target + (pose["pos"] - target) * _zoom
	_view.set_camera_pose(pos, target, 40.0)
