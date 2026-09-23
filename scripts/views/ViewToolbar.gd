class_name ViewToolbar
extends HBoxContainer

# The slim toolbar over a 3D view (top-left): one dropdown per render option in
# ViewOptions, plus camera presets. Each 3D view has its own, so a Textured view can sit
# beside an Intent view of the same build. It edits only that view's lens settings and
# follows the view's settings_changed, so a change made elsewhere (an agent's view_set)
# shows here live.

const CAMERA_PRESETS := [
	["Frame all", "se", 30.0],
	["Front (from south)", "s", 0.0],
	["Back (from north)", "n", 0.0],
	["Left (from west)", "w", 0.0],
	["Right (from east)", "e", 0.0],
	["Top", "s", "top"],
	["Iso", "se", "iso"],
]

enum { CUT_ABOVE, CUT_SELECTION, CUT_EDIT, CUT_TOGGLE, CUT_CLEAR }

var view: View3D
var _pickers := {}   # option id -> OptionButton
var _cut_menu: MenuButton

func _init(p_view: View3D) -> void:
	view = p_view

func _ready() -> void:
	add_theme_constant_override("separation", 4)
	mouse_filter = Control.MOUSE_FILTER_PASS
	for o in ViewOptions.OPTIONS:
		if not o.get("toolbar", true):
			continue
		var ob := OptionButton.new()
		ob.focus_mode = Control.FOCUS_NONE
		ob.tooltip_text = str(o["label"])
		ob.flat = true
		for c in o["choices"]:
			ob.add_item("%s: %s" % [o["label"], c[1]])
			ob.set_item_tooltip(ob.item_count - 1, str(c[2]))
		var id := str(o["id"])
		ob.item_selected.connect(func(i: int): view.set_render_options({id: o["choices"][i][0]}))
		add_child(ob)
		_pickers[id] = ob
	var cam := MenuButton.new()
	cam.text = "Camera ▾"
	cam.flat = true
	cam.focus_mode = Control.FOCUS_NONE
	for p in CAMERA_PRESETS:
		cam.get_popup().add_item(p[0])
	cam.get_popup().id_pressed.connect(_on_camera_preset)
	add_child(cam)
	_cut_menu = MenuButton.new()
	_cut_menu.text = "Cutaway ▾"
	_cut_menu.flat = true
	_cut_menu.focus_mode = Control.FOCUS_NONE
	_cut_menu.tooltip_text = "Hide part of the build to see inside. Or select a region and choose \"Cut away\" from its panel (MMB)."
	var cp := _cut_menu.get_popup()
	cp.add_item("Cut above camera", CUT_ABOVE)
	cp.add_item("Cut away selection", CUT_SELECTION)
	cp.add_item("Adjust bounds…", CUT_EDIT)
	cp.add_check_item("Cutaway on  (H / End)", CUT_TOGGLE)
	cp.add_item("Clear", CUT_CLEAR)
	cp.about_to_popup.connect(_sync_cut_menu)
	cp.id_pressed.connect(_on_cut_item)
	add_child(_cut_menu)
	var bg := StyleBoxFlat.new()
	bg.bg_color = Color(0.05, 0.05, 0.08, 0.55)
	bg.set_corner_radius_all(4)
	for c in get_children():
		(c as Control).add_theme_stylebox_override("normal", bg)
	view.settings_changed.connect(_sync)
	_sync()

func _sync() -> void:
	for id in _pickers:
		var ob: OptionButton = _pickers[id]
		var vals := ViewOptions.values(id)
		ob.select(maxi(0, vals.find(str(view.render_options[id]))))

func _on_camera_preset(i: int) -> void:
	var p: Array = CAMERA_PRESETS[i]
	var p_data := VoxelWorld.active_project.data if VoxelWorld.active_project else null
	var aabb := p_data.get_used_aabb() if p_data else []
	if aabb.is_empty():
		aabb = [Vector3i(-4, 0, -4), Vector3i(4, 4, 4)]
	view.frame_cells(aabb[0], aabb[1], CameraFraming.bearing(p[1]), p[2])

# Cutaway menu: the box itself lives in VoxelWorld (shared by every 3D view); the view owns
# the bounds panel.
func _sync_cut_menu() -> void:
	var cp := _cut_menu.get_popup()
	var has := VoxelWorld.has_cutaway
	cp.set_item_disabled(cp.get_item_index(CUT_SELECTION), not VoxelWorld.has_selection)
	cp.set_item_disabled(cp.get_item_index(CUT_EDIT), not has)
	cp.set_item_disabled(cp.get_item_index(CUT_TOGGLE), not has)
	cp.set_item_disabled(cp.get_item_index(CUT_CLEAR), not has)
	cp.set_item_checked(cp.get_item_index(CUT_TOGGLE), has and VoxelWorld.cutaway_enabled)

func _on_cut_item(id: int) -> void:
	match id:
		CUT_ABOVE:
			view.cut_above_camera()
			view.open_cutaway_panel()
		CUT_SELECTION:
			VoxelWorld.set_cutaway(VoxelWorld.selection_min, VoxelWorld.selection_max)
			view.open_cutaway_panel()
		CUT_EDIT:
			view.open_cutaway_panel()
		CUT_TOGGLE:
			VoxelWorld.set_cutaway_enabled(not VoxelWorld.cutaway_enabled)
		CUT_CLEAR:
			VoxelWorld.clear_cutaway()
