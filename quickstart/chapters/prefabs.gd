extends RefCounted
# quickstart: library=real seed=demo

# Chapter: prefabs. Save a selection of the demo Conduit Pillar, look at the prefab library, then place
# pillars into a fresh "Factory Floor" project.

const PILLAR := Vector3(0.0, 9.0, 0.0)

# The fine-tune panel's X/Y/Z rows: the "+" button of the row ("-", value, "+").
func _axis_button(d, axis: String, _idx: int) -> Control:
	var label: Control = d.ctl({"text": axis + ":", "class": "Label"})
	if label == null:
		return null
	var buttons := []
	for c in label.get_parent().get_children():
		if c is Button:
			buttons.append(c)
	return buttons[1] if buttons.size() >= 2 else null

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.settle(30)
	var view = d.view3d()
	view.call("set_camera_pose", Vector3(17.0, 12.0, 17.0), PILLAR)
	await d.agent("selection_set", {"region": {"min": [-8, 13, -8], "max": [8, 17, 8]}})
	await d.settle(20)
	d.mark("start")
	d.card("Prefabs")
	await d.fade_in(0.7)

	# --- save a selection as a prefab ---------------------------------------------
	d.say("intro")
	await d.wait(1.0)
	await d.sync()
	d.say("save")
	await d.press(KEY_P, ["ctrl"])
	d.caption_at("top")
	await d.wait(1.2)
	var name_edit: Control = d.ctl(func(c): return c is LineEdit and str((c as LineEdit).text).begins_with("Prefab"))
	await d.click(name_edit)
	await d.press(KEY_A, ["ctrl"])
	await d.type_text("Conduit Crown", 14.0)
	var tags: Control = d.ctl(func(c): return c is LineEdit and (c as LineEdit).placeholder_text.begins_with("pillar"))
	await d.click(tags)
	await d.type_text("conduit, crown", 14.0)
	await d.wait(0.4)
	var flange: Control = d.ctl({"text": "Beam Flange", "class": "CheckBox"})
	if flange != null:
		await d.click(flange)
		await d.wait(1.0)
		await d.click(flange)
	await d.sync()
	await d.click({"text": "Save", "class": "Button"})
	await d.wait(0.8)

	# --- the prefab library -------------------------------------------------------
	d.caption_at("bottom")
	d.say("home")
	await d.click({"text": "← Home"})
	await d.click({"tab": "Prefabs"})
	await d.wait(0.6)
	await d.click({"tooltip": "Conduit Pillar"})
	await d.wait(2.0)
	await d.click({"tooltip": "Conduit Crown"})
	await d.wait(1.0)
	await d.sync()

	# --- turn a prefab around -----------------------------------------------------
	d.say("rotate")
	await d.click({"tooltip": "Conduit Pillar"})
	await d.wait(0.8)
	var preview = d.node_of_class("PrefabPreview")
	if preview != null:
		var box: Rect2 = d.rect_of(preview)
		var mid := box.get_center()
		await d.drag_path([mid + Vector2(-170.0, 10.0), mid + Vector2(150.0, -30.0), mid + Vector2(-60.0, 40.0)], 1.8)
		await d.scroll(mid, 3)
		await d.wait(0.4)
		await d.scroll(mid, -3)
	await d.sync()

	# --- place pillars into a new project -----------------------------------------
	await d.agent("project_create", {"name": "Factory Floor", "palettes": ["Conduit Pillar"]})
	await d.settle(30)
	view = d.view3d()
	view.call("set_camera_pose", Vector3(-14.0, 11.0, 18.0), Vector3(-14.0, 0.0, -2.0))
	await d.settle(10)
	d.say("place")
	var v: Control = d.view3d()
	await d.click(v.get_global_rect().get_center())
	d.hide_pointer()
	await d.wait(0.4)
	await d.press(KEY_E)
	await d.wait(0.5)
	await d.click({"text": "Prefabs", "class": "Button"})
	await d.wait(0.5)
	await d.click({"tooltip": "Conduit Pillar"})
	d.hide_pointer()
	await d.wait(0.7)
	await d.aim_at_point(Vector3(-17.5, 0.0, -4.5), 0.9)
	await d.press(KEY_R)
	await d.wait(0.5)
	await d.click_crosshair(MOUSE_BUTTON_LEFT)               # lock it where it is
	await d.wait(0.5)
	await d.click_crosshair(MOUSE_BUTTON_MIDDLE)             # fine-tune panel
	d.pointer_to_center()
	await d.wait(0.5)
	var plus_x: Control = _axis_button(d, "X", 3)
	if plus_x != null:
		await d.click(plus_x)
		await d.click(plus_x)
	await d.wait(0.3)
	await d.sync()
	d.say("repeat")
	await d.click(v.get_global_rect().get_center())          # back to aiming: it's still locked, nudged over
	d.hide_pointer()
	await d.wait(0.5)
	await d.click_crosshair(MOUSE_BUTTON_RIGHT)              # drop it
	await d.wait(0.7)
	for spot in [Vector3(8.5, 0.0, -4.5), Vector3(32.5, 0.0, -4.5)]:
		await d.hold_keys([KEY_D], 1.1)
		await d.aim_at_point(spot, 0.8)
		await d.wait(0.4)
		await d.click_crosshair(MOUSE_BUTTON_RIGHT)
		await d.wait(0.6)
	await d.press(KEY_ESCAPE)
	await d.sync()
	await d.glide_camera(Vector3(7.0, 15.0, 38.0), Vector3(7.0, 7.0, 0.0), 2.4)
	await d.wait(1.0)
	await d.fade_out(0.9)
