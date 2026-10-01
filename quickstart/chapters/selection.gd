extends RefCounted

# Chapter: the selection tool. Written as a storyboard — each beat names what the viewer
# should see (ctl("Select"), spotlight, arrow, zoom) and `say`s a line over it.

# A small hall to select from: a floor, four walls, corner pillars, windows and a roof.
func _build(d) -> void:
	var fills := [
		[[0, 0, 0], [19, 0, 13], "Floor1", "solid"],
		[[2, 1, 2], [17, 6, 11], "Wall", "walls"],
		[[2, 1, 2], [2, 6, 2], "Trim", "solid"],
		[[17, 1, 2], [17, 6, 2], "Trim", "solid"],
		[[2, 1, 11], [2, 6, 11], "Trim", "solid"],
		[[17, 1, 11], [17, 6, 11], "Trim", "solid"],
		[[1, 7, 1], [18, 7, 12], "Roof", "solid"],
		[[4, 3, 11], [6, 4, 11], "Window", "solid"],
		[[9, 3, 11], [10, 4, 11], "Window", "solid"],
		[[13, 3, 11], [15, 4, 11], "Window", "solid"],
	]
	for f in fills:
		await d.agent("region_fill", {"region": {"min": f[0], "max": f[1]}, "semantic": f[2], "style": f[3], "animate": false})

func run(d) -> void:
	# --- set-up, off camera -------------------------------------------------------
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "My First Build"})
	await d.settle(10)
	await _build(d)
	await d.settle(30)
	var view = d.view3d()
	view.call("set_camera_pose", Vector3(9.5, 5.5, 40.0), Vector3(9.5, 3.5, 11.0))
	await d.settle(10)
	d.mark("start")
	d.card("Selecting")
	await d.fade_in(0.7)

	# --- 1. take off --------------------------------------------------------------
	d.say("intro")
	await d.sync()
	d.say("fly")
	var v: Control = d.view3d()
	await d.click(v.get_global_rect().get_center())
	d.hide_pointer()
	d.keys_hud(true)
	await d.wait(0.5)
	await d.hold_keys([KEY_W], 0.9)
	await d.hold_keys([KEY_SPACE], 0.25)
	await d.hold_keys([KEY_SHIFT], 0.15)
	await d.sync()
	d.keys_hud(false)

	# --- 2. pick the tool ---------------------------------------------------------
	d.say("tool")
	d.caption_top(true)       # the inventory's tool strip sits where captions normally go
	await d.press(KEY_E)
	await d.wait(0.5)
	var select_btn: Control = d.ctl({"text": "Select", "class": "Button"})
	await d.spotlight(select_btn, 14.0)
	d.arrow(select_btn, "Select tool", "above")
	await d.click(select_btn)
	await d.sync()
	await d.arrows_off()
	await d.spotlight_off()
	await d.press(KEY_E)
	d.hide_pointer()
	d.caption_top(false)
	await d.wait(0.4)

	# --- 3. two corners -----------------------------------------------------------
	d.say("corners")
	await d.aim_at_cell(Vector3i(2, 1, 11))
	await d.wait(0.2)
	await d.click_crosshair(MOUSE_BUTTON_RIGHT)
	await d.aim_at_cell(Vector3i(17, 6, 11), 1.3)
	await d.wait(0.2)
	await d.click_crosshair(MOUSE_BUTTON_RIGHT)
	await d.sync()

	# --- 4. what's inside ---------------------------------------------------------
	d.say("panel")
	await d.click_crosshair(MOUSE_BUTTON_MIDDLE)
	d.pointer_to_center()
	await d.wait(0.6)
	var legend: Control = d.ctl({"text": "Blocks", "class": "Button"})
	await d.sync()
	d.say("blocks")
	if legend != null:
		await d.zoom_to(legend.get_parent().get_parent(), 2.0)
		await d.click(legend)
	await d.sync()
	await d.zoom_out()

	d.say("outro")
	await d.sync()
	await d.wait(0.6)
	await d.fade_out(0.8)
