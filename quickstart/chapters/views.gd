extends RefCounted
# quickstart: library=real seed=demo

# Chapter: views and navigation, on the demo Conduit Pillar. A 3D view and a 2D slice side by side, an edit
# made in one showing up in the other, then the fly controls.

const PILLAR := Vector3(0.0, 9.0, 0.0)

# The world cell at (h across, v down-or-depth) of a slice plane through `slice_at`, for either slice axis.
func _slice_cell(slice_axis: int, slice_at: Vector3i, h: int, v: int) -> Vector3i:
	match slice_axis:
		0: return Vector3i(slice_at.x, v, h)      # an X slice: depth across, height up
		1: return Vector3i(h, slice_at.y, v)      # a Y slice (from above): x across, z down
		_: return Vector3i(h, v, slice_at.z)      # a Z slice: x across, height up

# Five empty cells in a row, running out from the pillar's side and all on screen in this slice view: somewhere
# an edit will really change something (a click on a block that's already there does nothing, and the pane
# only shows a few rows around the slice's centre).
func _free_run(d, slice: Control, slice_axis: int, slice_at: Vector3i) -> Array:
	var data = d.get_node("/root/VoxelWorld").active_project.data
	var pane: Rect2 = d.rect_of(slice).grow_individual(-30.0, -60.0, -30.0, -40.0)
	var rows: Array = [2, 3, 1, 4, 0, 5, -1] if slice_axis == 1 else [8, 7, 9, 6, 10, 5, 11]
	for v in rows:
		for start in range(3, 10):
			var cells := []
			for k in 5:
				var cell := _slice_cell(slice_axis, slice_at, start + k, v)
				if not data.get_block(cell).is_empty() or not pane.has_point(d.slice_cell_screen(slice, cell)):
					break
				cells.append(cell)
			if cells.size() == 5:
				return cells
	return []

# Slide a view's own camera to `to`, ending up looking at `look`: a real close-up in the 3D view (its pixels stay
# sharp), not a magnified video frame.
func _camera_to(d, view: Control, to: Vector3, look: Vector3, secs: float, from_look := PILLAR) -> void:
	var from: Vector3 = view.get("_camera_pos")
	var t0: float = d.t
	while d.t < t0 + secs:
		var u := clampf((d.t - t0) / secs, 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)
		view.call("set_camera_pose", from.lerp(to, u), from_look.lerp(look, u))
		await d.get_tree().process_frame
	view.call("set_camera_pose", to, look)

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.agent("selection_clear")
	await d.settle(30)
	d.orbit_pose(PILLAR, 24.0, 11.0, 10.0)            # exactly where the orbit below begins: no jump as the scene fades in
	await d.settle(20)
	d.mark("start")
	await d.fade_in(0.7)

	# --- many views, side by side -------------------------------------------------
	d.say("intro")
	await d.orbit(PILLAR, 24.0, 11.0, 10.0, 44.0, 3.6)
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
	await d.wait_for("slice", "press Tab")
	await d.press(KEY_TAB)
	d.hint("LEFT-HANDED", "Arrow keys and Enter work too", 5.0)
	await d.wait_for("slice", "selecting a slice.")
	for i in 3:                       # Tab cycles x, y, z: back to where it started
		await d.press(KEY_TAB)
		await d.wait(0.7)
	await d.wait_for("slice", "slide the plane,", 1.3)
	await d.press(KEY_W)
	await d.wait(0.6)
	await d.press(KEY_S)
	await d.wait(0.6)
	await d.wait_for("slice", "and Enter", 0.3)
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
		var painted: Array = []
		for k in [3, 4, 5]:
			painted.append(Vector3i(k, 8, slice_at.z) if slice_axis == 2 else Vector3i(slice_at.x, 8, k))
		# where those blocks show up in the 3D view, so the eye can follow them there
		var where: Rect2 = d.cell_rect(painted[0], 14.0)
		for cell in painted:
			where = where.merge(d.cell_rect(cell, 14.0))
		for i in painted.size():
			await d.click(d.slice_cell_screen(slice, painted[i]))
			if i == 0:
				d.arrow(where, "Appearing in 3D", "auto")
			await d.wait(0.25)
		d.hide_pointer()
		await d.wait(0.8)
		await d.spotlight(where, 28.0, 0.5)                     # a closer look at what just appeared
		await d.wait(1.4)
		await d.spotlight_off()
		await d.arrows_off()
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
	await d.wait_for("fly", "Shift to sink.")
	# Sprint: keep a direction held, and tap Control. (Backwards, so the build stays in view while it speeds off.)
	d.key_down(KEY_S)
	await d.wait(0.45)
	d.key_down(KEY_CTRL)
	await d.wait(0.14)
	d.key_up(KEY_CTRL)
	await d.wait(0.6)
	d.key_up(KEY_S)
	await d.wait_for("fly", "Hit Escape")
	await d.press(KEY_ESCAPE)
	await d.sync()
	d.keys_hud(false)
	await d.glide_camera(PILLAR + Vector3(sin(deg_to_rad(44.0)) * 24.0, 11.0, cos(deg_to_rad(44.0)) * 24.0), PILLAR, 0.9)

	# --- more views: a second 3D from another angle, a second slice ---------------
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

	# --- render modes: close in on that view, and step through every one --------------
	d.say("clay")
	_camera_to(d, second3, Vector3(-6.0, 12.5, -6.0), Vector3(0.0, 12.0, 0.0), 1.4)     # in close, on the top of the shaft
	var render_pick: OptionButton = d.ctl(func(c): return c is OptionButton and second3.is_ancestor_of(c) and c.get_item_text(0).begins_with("Render"))
	await d.pick_option(render_pick, 2)                 # Clay
	await d.wait(0.9)
	for mode in [1, 4, 3, 5]:                           # Intent, X-ray, Outline, Wire: the order they're named
		await d.pick_option(render_pick, mode)
		await d.wait(0.8)
	await d.pick_option(render_pick, 0)                 # and back to Textured
	await d.wait(0.6)
	await d.sync()
	await _camera_to(d, second3, Vector3(-17.0, 12.0, -17.0), PILLAR, 1.1, Vector3(0.0, 12.0, 0.0))     # and back out

	# --- orbit --------------------------------------------------------------------
	d.say("orbit")
	var cam_menu: MenuButton = d.ctl(func(c): return c is MenuButton and second3.is_ancestor_of(c) and (c as MenuButton).text.begins_with("Camera"))
	await d.pick_menu(cam_menu, ViewToolbar.ORBIT_BASE + 2)       # Orbit medium
	d.hide_pointer()
	await d.wait(1.0)
	var slice2: Control = d.slice_views()[1]                       # the second slice, through the pillar
	d.get_node("/root/VoxelWorld").select_slot(5)                  # Collar
	var slice_axis2: int = slice2.get("axis")
	var slice_at2: Vector3i = slice2.get("_center")
	slice_at2[slice_axis2] = int(slice2.get("slice_pos"))
	var run_cells := _free_run(d, slice2, slice_axis2, slice_at2)
	print("ORBIT speed=", second3.get("orbit_speed"), " slice axis=", slice_axis2, " at=", slice_at2, " free run=", run_cells)
	print("ORBIT slice rect=", d.rect_of(slice2), " cell_px=", slice2.get("_cell_px"), " origin=", slice2.call("_draw_origin"))
	for cell in run_cells:
		print("ORBIT paint ", cell, " -> ", d.slice_cell_screen(slice2, cell))
		await d.click(d.slice_cell_screen(slice2, cell))
		await d.wait(0.35)
	d.hide_pointer()
	await d.sync()
	await d.wait(2.0)
	d.say("end")
	await d.sync()
	await d.fade_out(0.9)
