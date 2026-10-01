extends RefCounted
# quickstart: library=real seed=demo

# Chapter: the selection tool, on the demo Conduit Pillar (needs the GTNH library locally).
# Written as a storyboard: each beat says what the viewer sees, and `say`s a line over it.

const PILLAR := Vector3(0.0, 9.0, 0.0)

# The X / Y / Z row of the selection panel: [min -, min +, max -, max +].
func _row(d, axis: String) -> Array:
	var label: Control = d.ctl({"text": axis + ":", "class": "Label"})
	var out := []
	if label != null:
		for c in label.get_parent().get_children():
			if c is Button:
				out.append(c)
	return out

# Press one of those buttons, optionally with Shift held (the app moves the face 5 cells then).
func _nudge(d, axis: String, button: int, shift := false) -> void:
	var row := _row(d, axis)
	if row.size() < 4:
		push_error("selection panel row %s not found" % axis)
		return
	if shift:
		d.key_down(KEY_SHIFT)
	await d.click(row[button])
	if shift:
		d.key_up(KEY_SHIFT)
	await d.wait(0.25)   # the panel rebuilds itself after a nudge

# The paste panel's "+" button for an axis (its row is "-", value, "+": two buttons, unlike the selection panel's four).
func _paste_plus(d, axis: String) -> Control:
	for label in d.ctl_all({"text": axis + ":", "class": "Label"}):
		var buttons := []
		for c in label.get_parent().get_children():
			if c is Button:
				buttons.append(c)
		if buttons.size() == 2:
			return buttons[1]
	return null

# How many cells the selection covers right now (read from the app, so the agent's reply is true).
func _selected(d) -> int:
	return d.get_node("/root/VoxelWorld").selection_positions().size()

func run(d) -> void:
	# --- set-up, off camera -------------------------------------------------------
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.agent("selection_clear")      # the saved project remembers its last selection
	await d.settle(30)
	var view = d.view3d()
	view.call("set_camera_pose", Vector3(22.0, 11.0, 22.0), PILLAR)
	await d.settle(20)
	d.mark("start")
	await d.fade_in(0.7)

	# --- 1. take off --------------------------------------------------------------
	d.say("intro")
	await d.sync()
	d.say("fly")
	var v: Control = d.view3d()
	await d.click(v.get_global_rect().get_center())
	d.hide_pointer()
	await d.wait(0.5)
	await d.hold_keys([KEY_W], 0.8)
	await d.hold_keys([KEY_SPACE], 0.6)           # up to about 20 cells: a high angle for the rest of the chapter
	await d.aim_at_point(Vector3(0.0, 8.0, 0.0), 0.9)
	await d.sync()

	# --- 2. pick the tool ---------------------------------------------------------
	d.say("tool")
	d.caption_top(true)       # the inventory's tool strip sits where captions normally go
	await d.press(KEY_E)
	d.hint("LEFT-HANDED", "Delete opens the inventory too", 4.0)
	await d.wait(0.5)
	var select_btn: Control = d.ctl({"text": "Select", "class": "Button"})
	# the build tools sit in one strip: vignette the whole strip while they're mentioned, then close in on Select
	var strip: Rect2 = d.rect_of(select_btn)
	for tool_name in ["Pencil", "Build to me", "Wand", "Exchange"]:
		var tb: Control = d.ctl({"text": tool_name, "class": "Button"})
		if tb != null:
			strip = strip.merge(d.rect_of(tb))
	await d.wait_for("tool", "Press E for your inventory.", 0.3)
	await d.spotlight(strip, 16.0)
	await d.wait_for("tool", "build tools.")
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

	# --- 3. two corners on the ground ---------------------------------------------
	d.say("corners")
	await d.aim_at_point(Vector3(8.5, 0.0, -7.5), 1.0)
	await d.wait(0.25)
	await d.click_crosshair(MOUSE_BUTTON_RIGHT)
	await d.aim_at_point(Vector3(-7.5, 0.0, 8.5), 1.4)
	await d.wait(0.25)
	await d.click_crosshair(MOUSE_BUTTON_RIGHT)
	await d.sync()

	# --- 4. the panel, and the tape measure ---------------------------------------
	await d.dolly(-16.0, 1.0)                   # step back and put the pillar on the left,
	await d.pan_to(PILLAR, 0.25, 0.5, 0.9)      # so the panel doesn't cover it
	d.caption_at("right")                       # ...and the caption stays off the panel
	d.say("panel")
	await d.click_crosshair(MOUSE_BUTTON_MIDDLE)
	d.pointer_to_center()
	await d.wait(0.7)
	var dims: Control = d.ctl({"text": "cells", "class": "Label"})
	if dims != null:
		await d.spotlight(dims, 12.0)
	await d.sync()
	await d.spotlight_off()

	# --- 5. nudge the top up to the full height -----------------------------------
	d.say("nudge")
	var hint_row: Control = d.ctl({"text": "Move each face"})
	if hint_row != null:
		await d.spotlight(hint_row, 10.0)
		await d.wait(0.5)
		await d.spotlight_off()
	for i in 3:
		await _nudge(d, "Y", 3, true)    # max +  (Shift: 5 cells)
	for i in 2:
		await _nudge(d, "Y", 3)          # max +  (1 cell)
	if dims != null:
		dims = d.ctl({"text": "cells", "class": "Label"})
		await d.spotlight(dims, 12.0)
	await d.sync()
	await d.spotlight_off()

	# --- 6. what's inside: semantics, then blocks ---------------------------------
	var panel: Control = d.ancestor_of(d.ctl({"text": "Semantics", "class": "Button"}), "ToolOverlayPanel")
	d.say("semantics")
	if panel != null:
		await d.zoom_to(panel, 2.0, 0.9)
	await d.sync()
	d.say("blocks")
	await d.click({"text": "Blocks", "class": "Button"})
	var copy_btn: Control = d.ctl({"text": "Copy list", "class": "Button"})
	if copy_btn != null:
		d.arrow(copy_btn, "Copy list", "right")
	await d.sync()
	await d.arrows_off()
	await d.zoom_out()

	# --- 7. copy, paste, delete, undo ---------------------------------------------
	d.caption_at("bottom")
	var box := v.get_global_rect()
	await d.click(Vector2(box.position.x + box.size.x * 0.86, box.position.y + box.size.y * 0.5))   # back into the view (clear of the panel): it puts itself away
	d.hide_pointer()
	# From the north: a paste lands its min corner (x, z) on the crosshair, so that corner has to be near the camera
	# (the crosshair only reaches 32 cells). Locking it (below) lets the camera pull back to show the whole thing.
	await d.glide_camera(Vector3(40.0, 22.0, -2.0), Vector3(10.0, 6.0, 0.0), 0.9)
	await d.glide_camera(Vector3(10.0, 20.0, -28.0), Vector3(10.0, 6.0, 0.0), 1.0)
	d.say("copy")
	await d.wait_for("copy", "Control C")
	await d.press(KEY_C, ["ctrl"])
	await d.wait_for("copy", "Control V")
	await d.press(KEY_V, ["ctrl"])                # paste mode: the copy follows the crosshair
	await d.aim_at_point(Vector3(20.5, 0.0, -10.5), 0.5)
	await d.aim_at_point(Vector3(10.5, 0.0, -7.5), 1.4)
	await d.wait_for("copy", "locks it in place,")
	await d.click_crosshair(MOUSE_BUTTON_LEFT)    # lock it where it is...
	await d.glide_camera(Vector3(10.0, 21.0, -33.0), Vector3(10.0, 7.0, 0.0), 1.2)     # ...so the camera can pull back and look at both
	await d.wait_for("copy", "and then middle-click", 0.8)
	await d.click_crosshair(MOUSE_BUTTON_MIDDLE)  # the fine-tune panel
	d.pointer_to_center()
	await d.wait(0.6)
	var plus_x := _paste_plus(d, "X")
	if plus_x != null:
		for i in 3:
			await d.click(plus_x)
			await d.wait(0.2)
	await d.wait_for("copy", "turn it with R.")
	await d.wait_for("copy", "Right-click", 0.6)
	await d.click(v.get_global_rect().get_center())        # back to aiming: it's still locked, nudged over
	d.hide_pointer()
	await d.wait(0.4)
	await d.click_crosshair(MOUSE_BUTTON_RIGHT)   # drop it
	await d.settle(5)
	await d.sync()
	await d.wait(0.5)
	d.say("delete")
	await d.press(KEY_BACKSPACE)
	await d.sync()
	await d.wait(0.6)
	d.say("undo")
	await d.press(KEY_Z, ["ctrl"])                # the original comes back
	await d.wait(1.2)
	await d.press(KEY_Z, ["ctrl"])                # and the copy goes
	await d.sync()
	await d.wait(0.5)

	# --- 8. the agent: semantic selection -----------------------------------------
	d.say("agent_intro")
	d.hide_pointer()
	await d.sync()
	d.chat_clear()
	d.say("agent1")
	await d.chat_user("Hi, let's select only the glowing channels.")
	await d.chat_tool("selection_filter", "whitelist: [Channel Glow]", func():
		await d.agent("selection_filter", {"whitelist": ["Channel Glow"]}))
	await d.chat_agent("Done: %d cells of Channel Glow." % _selected(d))
	await d.sync()
	await d.wait(1.0)
	d.chat_clear()
	d.say("agent2")
	await d.chat_user("Now everything except the glow and the plinth.")
	await d.chat_tool("selection_filter", "blacklist: [Channel Glow, Plinth…]", func():
		await d.agent("selection_filter", {"clear": true})
		await d.agent("selection_filter", {"blacklist": ["Channel Glow", "Plinth Chamfer", "Plinth Corner"]}))
	await d.chat_agent("Done: %d cells, everything but the glow and the plinth." % _selected(d))
	await d.sync()
	d.say("agent_outro")
	await d.sync()
	d.chat_hide()

	# --- 9. what else a selection is for -------------------------------------------
	d.caption_at("right")
	d.say("ops")
	await d.click_crosshair(MOUSE_BUTTON_MIDDLE)    # the panel again
	d.pointer_to_center()
	await d.wait(0.6)
	var cut_btn: Control = d.ctl({"text": "Cut away this region", "class": "Button"})
	var export_btn: Control = d.ctl({"text": "Export to Schematica", "class": "Button"})
	if cut_btn != null and export_btn != null:
		var span := cut_btn.get_global_rect().merge(export_btn.get_global_rect())
		await d.spotlight(span, 12.0)
	await d.sync()
	await d.wait(0.8)
	await d.spotlight_off()
	await d.fade_out(0.9)
