extends RefCounted
# quickstart: library=real seed=demo

# Chapter: semantic blocks and palettes, on the demo Conduit Pillar. The alternate palettes are made
# off camera with the same tools an agent would use; on camera the viewer adds them to the project.

const PILLAR := Vector3(0.0, 9.0, 0.0)
const SANDSTONE := {"Core": "cut_sandstone", "Mass": "sandstone", "Joint": "chiseled_sandstone",
	"Corbel Step": "smooth_sandstone", "Corner Rod": "gold_block", "Collar": "smooth_sandstone",
	"Plinth Chamfer": "smooth_sandstone", "Plinth Corner": "smooth_sandstone", "Channel Edge": "quartz_block",
	"Channel Sill": "quartz_block", "Channel Glow": "glowstone", "Beam Flange": "cut_sandstone"}
const COPPER := {"Core": "weathered_cut_copper", "Mass": "weathered_copper", "Joint": "copper_grate",
	"Corbel Step": "cut_copper", "Corner Rod": "copper_block", "Collar": "cut_copper",
	"Plinth Chamfer": "oxidized_cut_copper", "Plinth Corner": "oxidized_cut_copper", "Channel Edge": "copper_block",
	"Channel Sill": "exposed_copper", "Channel Glow": "sea_lantern", "Beam Flange": "oxidized_copper"}

func _make_palette(d, palette_name: String, mapping: Dictionary) -> void:
	await d.agent("palette_create", {"name": palette_name, "from": "Conduit Pillar"})
	var sets := []
	for sem in mapping:
		sets.append({"semantic": sem, "block": mapping[sem]})
	await d.agent("palette_update", {"name": palette_name, "libraries": ["minecraft"], "set": sets})

# Add a palette to the open project through the inventory, then close it again.
func _add_palette(d, palette_name: String) -> void:
	await d.press(KEY_E)
	await d.wait(0.5)
	var picker: OptionButton = d.ctl(func(c): return c is OptionButton and d.ancestor_of(c, "InventoryScreen") != null)
	var index := -1
	for i in picker.item_count:
		if picker.get_item_text(i) == palette_name:
			index = i
	await d.pick_option(picker, index)
	var plus: Control = d.ctl(func(c): return c is Button and (c as Button).text == "+" and c.get_parent() == picker.get_parent())
	await d.click(plus)
	await d.wait(0.8)
	await d.press(KEY_E)
	d.hide_pointer()

# Right-click an inventory entry, choose Edit, pick another block in the chooser and save.
func _edit_entry(d, tooltip: String) -> void:
	await d.press(KEY_E)
	await d.wait(0.5)
	var entry: Control = d.ctl({"tooltip": tooltip})
	await d.right_click(entry)
	await d.wait(0.35)
	var menu: PopupMenu = null
	for n in d.get_tree().root.get_children():
		if n is PopupMenu and n.visible:
			menu = n
	# a vignette on the entry (and its menu) for as long as it takes to pick "Edit"
	d.spotlight(d.rect_of(entry).merge(Rect2(Vector2(menu.position), Vector2(menu.size))), 16.0)
	await d.click(Vector2(menu.position) + Vector2(26.0, 14.0))     # "Edit"
	await d.spotlight_off()
	if is_instance_valid(menu):
		menu.hide()
	await d.wait(1.0)
	# The chooser shows the block it points at now (cyan); take the magenta one two rows below the top.
	var target := Vector2(845.0, 538.0)
	var tile: Control = d.ctl(func(c): return c.tooltip_text != "" and c.get_window() != d.get_tree().root 		and not (c is Button) and Ui_dist(d, c, target) < 28.0)
	if tile == null:
		tile = d.ctl(func(c): return c.tooltip_text != "" and not (c is Button) and Ui_dist(d, c, target) < 40.0)
	if tile != null:
		await d.click(tile)
	else:
		await d.click(target)
	await d.wait(1.0)
	await d.click({"text": "Save", "class": "Button"})
	await d.wait(0.8)
	await d.press(KEY_E)
	d.hide_pointer()

func Ui_dist(d, c: Control, p: Vector2) -> float:
	return d.rect_of(c).get_center().distance_to(p)

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	await _make_palette(d, "Warm Sandstone", SANDSTONE)
	await _make_palette(d, "Oxidized Copper", COPPER)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.agent("selection_clear")
	await d.settle(30)
	var view = d.view3d()
	d.orbit_pose(PILLAR, 23.0, 11.0, 0.0)           # exactly where the orbit below begins
	await d.settle(20)
	d.mark("start")
	await d.fade_in(0.7)

	# --- semantic blocks: the hotbar ----------------------------------------------
	d.say("hotbar")
	d.orbit(PILLAR, 23.0, 11.0, 0.0, 70.0, 6.0)     # runs alongside the narration
	await d.wait(1.5)
	var hotbar = d.node_of_class("Hotbar")
	await d.spotlight(hotbar, 10.0)
	await d.sync()
	await d.spotlight_off()
	d.say("meaning")
	await d.sync()

	# --- the palette: what each meaning looks like -------------------------------
	d.say("palette")
	await d.click({"text": "← Home"})
	await d.click({"tab": "Palettes"})
	await d.click({"text": "Conduit Pillar"})
	await d.wait(0.5)
	await d.click({"text": "Edit", "class": "Button"})
	await d.wait(0.6)
	await d.click({"tooltip": "Channel Glow"})
	await d.wait(0.8)
	await d.sync()
	await d.click({"text": "← Back"})
	await d.click({"tab": "Projects"})
	await d.click({"text": "Conduit Pillar"})
	await d.click({"text": "Open", "class": "Button"})
	await d.wait(1.0)
	d.hide_pointer()
	view = d.view3d()
	view.call("set_camera_pose", Vector3(17.0, 11.0, 17.0), PILLAR)

	# --- edit an entry: every voxel using it updates ------------------------------
	d.orbit(PILLAR, 23.0, 11.0, 45.0, 120.0, 14.0)
	d.say("edit")
	await d.wait(1.0)
	await _edit_entry(d, "Channel Glow")
	await d.sync()
	d.say("edit_done")
	await d.sync()
	await d.wait(1.0)

	# --- the swap -----------------------------------------------------------------
	d.say("swap")
	await _add_palette(d, "Warm Sandstone")
	await d.sync()
	d.say("swap_result")
	await d.orbit(PILLAR, 23.0, 11.0, 45.0, 100.0, 4.5)
	await d.sync()
	d.say("swap2")
	await _add_palette(d, "Oxidized Copper")
	await d.orbit(PILLAR, 23.0, 11.0, 100.0, 150.0, 4.0)
	await d.sync()
	d.say("principle")
	await d.orbit(PILLAR, 23.0, 11.0, 150.0, 200.0, 4.5)
	await d.sync()
	await d.fade_out(0.9)
