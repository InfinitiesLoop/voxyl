class_name ProjectSettingsDialog
extends AcceptDialog

# The open project's own settings (as opposed to SettingsDialog, which is the app's). Things about
# where the build sits in the world it plans, that belong to the project rather than to any view:
# which way north points, and where the heavy grid lines fall. Changes apply live (every 3D view
# re-reads them through VoxelWorld.project_settings_changed) and are saved with the project, so
# there is no Apply step — the button just closes. More will live here later.

# [project direction, label] — which of the project's axes points toward the world's north.
const _NORTHS := [
	["north", "−Z   (default: the project already faces north)"],
	["east", "+X   (east is the world's north)"],
	["south", "+Z   (south is the world's north)"],
	["west", "−X   (west is the world's north)"],
]

var _north: OptionButton
var _grid_x: SpinBox
var _grid_z: SpinBox
var _preview: CompassRose
var _syncing := false

func _ready() -> void:
	title = "Project settings"
	ok_button_text = "Done"
	min_size = Vector2i(560, 0)
	var project := VoxelWorld.active_project
	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 10)
	add_child(vbox)

	var blurb := Label.new()
	blurb.text = "Line the project up with the world you're really building in. Both save with the project."
	blurb.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	blurb.custom_minimum_size = Vector2(520, 0)
	blurb.add_theme_color_override("font_color", Color(0.7, 0.7, 0.72))
	vbox.add_child(blurb)

	# North.
	vbox.add_child(_heading("North"))
	var north_row := HBoxContainer.new()
	north_row.add_theme_constant_override("separation", 14)
	vbox.add_child(north_row)
	var north_col := VBoxContainer.new()
	north_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	north_col.add_theme_constant_override("separation", 6)
	north_row.add_child(north_col)
	north_col.add_child(_caption("Which of the project's directions points toward the world's north. The compass in each 3D view follows it, and north stays north wherever a build leaves or enters: prefabs and copies remember it and are turned to the destination project's, and Export to Schematica turns the build so this side faces the game's north. The tools' own direction words (north = −Z, …) keep meaning the project's axes."))
	_north = OptionButton.new()
	for pair in _NORTHS:
		_north.add_item(pair[1])
	_north.item_selected.connect(func(_i: int): _apply())
	north_col.add_child(_north)
	_preview = CompassRose.new()
	_preview.tooltip_text = "As seen from above with the project's −Z at the top"
	north_row.add_child(_preview)

	vbox.add_child(HSeparator.new())

	# Major grid offset.
	vbox.add_child(_heading("Major grid"))
	vbox.add_child(_caption("The heavy grid lines run every 16 cells, like Minecraft's chunk borders. Set where they fall so they line up with your world's: a line runs along the west / north edge of the cells at x = X, X ± 16, … and z = Z, Z ± 16, …"))
	var grid_row := HBoxContainer.new()
	grid_row.add_theme_constant_override("separation", 10)
	vbox.add_child(grid_row)
	_grid_x = _offset_box("X")
	_grid_z = _offset_box("Z")
	for box: SpinBox in [_grid_x, _grid_z]:
		var label := Label.new()
		label.text = "X offset" if box == _grid_x else "Z offset"
		grid_row.add_child(label)
		grid_row.add_child(box)
	var reset := Button.new()
	reset.text = "Reset"
	reset.tooltip_text = "Lines at multiples of 16 from the project origin"
	reset.pressed.connect(func():
		_grid_x.value = 0
		_grid_z.value = 0)
	grid_row.add_child(reset)

	_load(project)

func _heading(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 17)
	return l

func _caption(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.custom_minimum_size = Vector2(380, 0)
	l.add_theme_color_override("font_color", Color(0.7, 0.7, 0.72))
	return l

# A 0..15 spin box that wraps (the grid repeats every 16), applying each change live.
func _offset_box(_axis: String) -> SpinBox:
	var box := SpinBox.new()
	box.min_value = 0
	box.max_value = VoxelProject.MAJOR_GRID - 1
	box.step = 1
	box.rounded = true
	box.allow_greater = false
	box.custom_minimum_size = Vector2(90, 0)
	box.value_changed.connect(func(_v: float): _apply())
	return box

func _load(project: VoxelProject) -> void:
	if project == null:
		return
	_syncing = true
	_north.select(maxi(0, VoxelProject.NORTH_DIRS.find(project.north_dir)))
	_grid_x.value = project.grid_offset.x
	_grid_z.value = project.grid_offset.y
	_syncing = false
	_refresh_preview(project.north_vector())

func _apply() -> void:
	if _syncing:
		return
	var dir: String = _NORTHS[_north.selected][0]
	VoxelWorld.set_project_settings(dir, Vector2i(int(_grid_x.value), int(_grid_z.value)))
	var project := VoxelWorld.active_project
	if project != null:
		_refresh_preview(project.north_vector())

# Seen from above with the project's own −Z at the top: the needle points wherever north is.
func _refresh_preview(north: Vector2) -> void:
	_preview.heading = CompassRose.heading_for(Vector2(0, -1), north)

static func open(parent: Node) -> void:
	if VoxelWorld.active_project == null:
		return
	var d := ProjectSettingsDialog.new()
	d.close_requested.connect(d.queue_free)
	d.confirmed.connect(d.queue_free)
	parent.get_tree().root.add_child(d)
	d.popup_centered()
