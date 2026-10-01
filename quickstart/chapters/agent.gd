extends RefCounted
# quickstart: library=empty seed=

# Chapter: connecting an agent, then a staged build. The terminal is a card drawn over the app (the
# real one is an OS window the recording can't see); the build itself is real: the same tools an agent
# calls, animating into the open project.

const TOWER := Vector3(4.0, 5.0, 4.0)

func _masked(command: String) -> String:
	var re := RegEx.new()
	re.compile("Bearer ([0-9a-fA-F]{6})[0-9a-fA-F]+([0-9a-fA-F]{4})")
	var m := re.search(command)
	if m == null:
		return command
	return command.replace(m.get_string(0), "Bearer %s…%s" % [m.get_string(1), m.get_string(2)])

func _fill(d, mn: Array, mx: Array, sem: String, style := "solid", sym := {}) -> void:
	var args := {"region": {"min": mn, "max": mx}, "semantic": sem, "style": style}
	if not sym.is_empty():
		args["symmetry"] = sym
	await d.agent("region_fill", args)

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(20)
	d.mark("start")
	d.card("Agent setup")
	await d.fade_in(0.7)

	# --- settings -----------------------------------------------------------------
	d.say("intro")
	await d.sync()
	d.say("settings")
	await d.click({"text": "Settings", "class": "Button"})
	await d.wait(0.8)
	await d.click({"text": "Allow agent connections", "class": "CheckBox"})
	await d.wait(1.0)
	var snippet: Control = d.ctl(func(c): return c is TextEdit and str((c as TextEdit).text).begins_with("claude mcp add"))
	if snippet != null:
		await d.spotlight(snippet, 12.0)
	await d.sync()
	await d.spotlight_off()

	# --- the terminal -------------------------------------------------------------
	d.say("copy")
	var command := _masked(str((snippet as TextEdit).text)) if snippet != null else "claude mcp add voxyl …"
	await d.show_click({"text": "Copy setup command", "class": "Button"})
	await d.wait(0.3)
	await d.terminal_open("Terminal")
	await d.terminal_type(command)
	await d.terminal_print("Added HTTP MCP server voxyl to user config")
	await d.sync()
	await d.terminal_close()
	await d.click({"text": "Close", "class": "Button"})
	await d.wait(0.4)

	# --- open a project, see the badge --------------------------------------------
	d.say("badge")
	await d.click({"text": "My First Build"})
	await d.click({"text": "Open", "class": "Button"})
	await d.wait(0.8)
	var view = d.view3d()
	view.call("set_camera_pose", Vector3(15.0, 10.0, 15.0), TOWER)
	await d.wait(0.6)
	var badge: Control = d.ctl(func(c): return c is Label and str((c as Label).text).begins_with("●"))
	if badge != null:
		await d.spotlight(badge, 10.0)
	await d.sync()
	await d.spotlight_off()

	# --- ask, and watch it build --------------------------------------------------
	d.caption_at("left")
	d.say("ask")
	await d.chat_user("Build me a little watchtower.")
	var sym := {"rotate4": {"center": [4, 4]}}
	d.orbit(TOWER, 15.0, 8.0, 45.0, 120.0, 12.0)
	await d.chat_tool("region_fill", "Floor1 · floor", func():
		await _fill(d, [0, 0, 0], [8, 0, 8], "Floor1"))
	await d.chat_tool("region_fill", "Wall · walls", func():
		await _fill(d, [0, 1, 0], [8, 10, 8], "Wall", "walls"))
	await d.chat_tool("region_fill", "Trim · corners ×4", func():
		await _fill(d, [0, 1, 0], [0, 10, 0], "Trim", "solid", sym))
	await d.chat_tool("region_fill", "Window · ×4", func():
		await _fill(d, [3, 4, 0], [5, 7, 0], "Window", "solid", sym))
	await d.chat_tool("region_fill", "Accent · battlements", func():
		await _fill(d, [0, 11, 0], [8, 11, 8], "Accent", "walls"))
	await d.chat_tool("region_fill", "Roof", func():
		await _fill(d, [1, 10, 1], [7, 10, 7], "Roof"))
	await d.chat_agent("Done: a 9×12×9 watchtower.")
	await d.sync()

	# --- you stay in control ------------------------------------------------------
	d.say("undo")
	var pause: Control = d.ctl({"text": "Pause agent", "class": "Button"})
	var undo: Control = d.ctl({"text": "Undo", "class": "Button"})
	d.orbit(TOWER, 15.0, 8.0, 120.0, 190.0, 6.0)
	if pause != null and undo != null:
		await d.spotlight(pause.get_global_rect().merge(undo.get_global_rect()).grow(4.0), 10.0)
	await d.sync()
	await d.spotlight_off()
	d.chat_hide()
	d.say("end")
	await d.sync()
	await d.wait(0.6)
	await d.fade_out(0.9)
