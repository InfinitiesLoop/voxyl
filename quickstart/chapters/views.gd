extends RefCounted
# quickstart: library=real seed=demo

# Chapter: views and navigation, on the demo Conduit Pillar. A 3D view and a 2D slice side by side, an edit
# made in one showing up in the other, then the fly controls.

const PILLAR := Vector3(0.0, 9.0, 0.0)

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.agent("selection_clear")
	await d.settle(30)
	var view = d.view3d()
	view.call("set_camera_pose", Vector3(17.0, 12.0, 17.0), PILLAR)
	await d.settle(20)
	d.mark("start")
	d.card("Views & flying")
	await d.fade_in(0.7)

	# --- two views, side by side --------------------------------------------------
	d.say("intro")
	await d.orbit(PILLAR, 24.0, 11.0, 10.0, 38.0, 3.0)
	await d.click({"text": "Cols", "class": "Button"})
	await d.wait(0.8)
	await d.sync()

	# --- Tab: slice ---------------------------------------------------------------
	d.say("slice")
	var v: Control = d.view3d()
	await d.click(v.get_global_rect().get_center())
	d.hide_pointer()
	await d.wait(0.4)
	await d.aim_at_cell(Vector3i(0, 6, 2), 0.9)
	await d.press(KEY_TAB)
	d.hint("LEFT-HANDED", "Arrow keys and Enter work too", 5.0)
	await d.wait(1.0)
	for i in 3:                       # Tab cycles x, y, z: back to where it started
		await d.press(KEY_TAB)
		await d.wait(0.7)
	await d.press(KEY_W)
	await d.wait(0.6)
	await d.press(KEY_S)
	await d.wait(0.6)
	await d.press(KEY_ENTER)
	await d.wait(1.0)
	await d.sync()

	# --- paint in the slice -------------------------------------------------------
	d.say("edit")
	var slice: Control = d.slice_view()
	if slice != null:
		d.get_node("/root/VoxelWorld").select_slot(5)          # Collar: a whole block (the glow channels are shaped parts)
		var slice_axis: int = slice.get("axis")
		var slice_at: Vector3i = slice.get("_center")
		slice_at[slice_axis] = int(slice.get("slice_pos"))
		for k in [3, 4, 5]:
			var cell := Vector3i(k, 8, slice_at.z) if slice_axis == 2 else Vector3i(slice_at.x, 8, k)
			await d.click(d.slice_cell_screen(slice, cell))
			await d.wait(0.25)
	await d.sync()

	# --- layers -------------------------------------------------------------------
	d.say("layers")
	if slice != null:
		var up: Control = d.ctl(func(c): return c is Button and (c as Button).text == "▲" and slice.is_ancestor_of(c))
		if up != null:
			for i in 3:
				await d.click(up)
				await d.wait(0.3)
		var turn: Control = d.ctl(func(c): return c is Button and (c as Button).text == "↻" and slice.is_ancestor_of(c))
		if turn != null:
			await d.click(turn)
			await d.wait(0.6)
	await d.sync()

	# --- fly ----------------------------------------------------------------------
	d.say("fly")
	await d.click(d.view3d().get_global_rect().get_center())
	d.hide_pointer()
	d.keys_hud(true)
	await d.wait(0.6)
	await d.hold_keys([KEY_W], 0.8)
	await d.hold_keys([KEY_D], 0.8)
	await d.hold_keys([KEY_SPACE], 0.5)
	await d.hold_keys([KEY_SHIFT], 0.4)
	await d.press(KEY_ESCAPE)
	await d.sync()
	d.keys_hud(false)
	# --- more views: a second 3D from another angle, a second slice --------------
	d.say("more")
	d.caption_top(true)
	await d.click({"text": "2×2", "class": "Button"})
	await d.wait(0.9)
	await d.click({"text": "+ 3D", "class": "Button"})
	await d.wait(0.7)
	var threes: Array = d.views3d()
	var first3 = threes[0]
	var second3 = threes[1]
	second3.call("set_camera_pose", Vector3(-17.0, 12.0, -17.0), PILLAR)
	await d.wait(1.2)
	# a second slice, from the first 3D view, on another axis
	await d.click(first3.get_global_rect().get_center())
	await d.click(first3.get_global_rect().get_center())
	d.hide_pointer()
	await d.aim_at_cell(Vector3i(0, 6, 2), 0.7)
	await d.press(KEY_TAB)
	await d.press(KEY_TAB)
	await d.wait(0.5)
	await d.press(KEY_ENTER)
	await d.wait(1.0)
	await d.sync()

	# --- render modes -------------------------------------------------------------
	d.say("clay")
	var render_pick: OptionButton = d.ctl(func(c): return c is OptionButton and second3.is_ancestor_of(c) and c.get_item_text(0).begins_with("Render"))
	await d.pick_option(render_pick, 2)                 # Clay
	await d.wait(1.6)
	await d.pick_option(render_pick, 1)                 # Intent
	await d.wait(1.1)
	await d.pick_option(render_pick, 4)                 # X-ray
	await d.wait(1.1)
	await d.pick_option(render_pick, 2)                 # back to Clay
	await d.sync()

	# --- orbit --------------------------------------------------------------------
	d.say("orbit")
	var cam_menu: MenuButton = d.ctl(func(c): return c is MenuButton and second3.is_ancestor_of(c) and (c as MenuButton).text.begins_with("Camera"))
	await d.pick_menu(cam_menu, ViewToolbar.ORBIT_BASE + 2)       # Orbit medium
	d.hide_pointer()
	await d.wait(1.0)
	var slice2: Control = d.slice_views()[1]                       # the second slice, through the pillar
	d.get_node("/root/VoxelWorld").select_slot(5)                  # Collar
	var slice_axis: int = slice2.get("axis")
	var slice_at: Vector3i = slice2.get("_center")
	slice_at[slice_axis] = int(slice2.get("slice_pos"))
	print("ORBIT speed=", second3.get("orbit_speed"), " slice axis=", slice_axis, " at=", slice_at)
	for off in [Vector2i(3, 6), Vector2i(4, 6), Vector2i(5, 6), Vector2i(5, 7), Vector2i(5, 8)]:
		var cell := Vector3i(off.x, off.y, slice_at.z) if slice_axis == 2 else Vector3i(slice_at.x, off.y, off.x)
		await d.click(d.slice_cell_screen(slice2, cell))
		await d.wait(0.35)
	d.hide_pointer()
	await d.sync()
	await d.wait(2.0)
	d.say("end")
	await d.sync()
	await d.fade_out(0.9)
