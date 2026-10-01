extends RefCounted
# quickstart: library=real seed=

# Chapter: connecting an agent, then a staged build from a reference photo, then an iteration on it. The
# terminal is a card drawn over the app (the real one is an OS window the recording can't see). The build
# itself is real: the calls in watchtower.build.json (made by design/watchtower.py, the way an agent would
# write them from assets/watchtower-reference.webp) go through the same tool registry the MCP server serves,
# so the tower rises in the app exactly as it would for a connected agent.

const BUILD := "res://quickstart/chapters/watchtower.build.json"
# Where the camera looks: east of the tower, so the tower sits left of centre, clear of the chat card.
const TOWER := Vector3(11.0, 22.0, 0.0)
const RADIUS := 36.0
const HEIGHT := 14.0

func _masked(command: String) -> String:
	var re := RegEx.new()
	re.compile("Bearer ([0-9a-fA-F]{6})[0-9a-fA-F]+([0-9a-fA-F]{4})")
	var m := re.search(command)
	if m == null:
		return command
	return command.replace(m.get_string(0), "Bearer %s…%s" % [m.get_string(1), m.get_string(2)])

func _cam(deg: float) -> Vector3:
	return TOWER + Vector3(sin(deg_to_rad(deg)) * RADIUS, HEIGHT, cos(deg_to_rad(deg)) * RADIUS)

# One chat line per step: the tool's name and what it's doing, with the real calls running under it.
func _run_steps(d, steps: Array) -> void:
	for step in steps:
		var calls: Array = step["calls"]
		var label := "%s · %d cells" % [step["label"], int(step["cells"])] if step.has("cells") 			else "%s · %s" % [step["label"], step.get("detail", "")]
		await d.chat_tool(str(calls[0]["tool"]), label, func():
			for c in calls:
				await d.agent(str(c["tool"]), c["args"])
			await d.wait(1.0))

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(20)
	var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(BUILD))
	d.mark("start")
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
	await d.terminal_paste(command)
	await d.terminal_print("Added HTTP MCP server voxyl to user config")
	await d.sync()
	await d.terminal_close()
	await d.click({"text": "Close", "class": "Button"})
	await d.wait(0.4)

	# --- open a project -----------------------------------------------------------
	await d.click({"text": "My First Build"})
	await d.click({"text": "Open", "class": "Button"})
	d.hide_pointer()
	await d.wait(0.8)
	var view = d.view3d()
	view.call("set_camera_pose", _cam(20.0), TOWER)
	await d.wait(0.5)

	# --- ask, with a reference image ----------------------------------------------
	d.caption_at("left")
	d.say("ask")
	d.chat_clear()
	await d.chat_image("watchtower-reference.webp")
	await d.chat_user("Build me this watchtower.")
	await d.sync()
	d.say("build")
	await d.chat_agent("A round stone tower with a machicolated deck and slate cone roof, a curtain wall, a timber hut.", 70.0)
	var pal: Dictionary = data["palette"]
	await d.chat_tool("palette_create", "Castle · from your minecraft library", func():
		await d.agent("palette_create", {"name": pal["name"], "libraries": pal["libraries"], "entries": pal["entries"]})
		await d.agent("project_palettes_set", {"palettes": [pal["name"]]})
		await d.agent("hotbar_set", {"slots": ["Tower Stone", "Tower Stone Light", "Corbel", "Merlon", "Paving", "Roof Slate",
			"Timber", "Plaster", "Window", "Slit", "Railing", "Rock"], "active": 0}))
	d.orbit(TOWER, RADIUS, HEIGHT, 20.0, 92.0, 62.0)
	await _run_steps(d, data["steps"])
	await d.chat_agent("Done: a watchtower, 45 × 48 × 33.")
	await d.sync()
	await d.wait(1.0)

	# --- iterate: change what's there, don't start over ----------------------------
	d.say("iterate")
	d.chat_clear()
	await d.chat_user("Add a pond near the entrance, and make the tower a bit taller.")
	await _run_steps(d, data["iteration"])
	await d.chat_agent("Done: a pond by the door, and the tower is three taller.")
	await d.sync()
	await d.wait(2.5)

	# --- you stay in control ------------------------------------------------------
	d.say("undo")
	d.chat_hide()
	var pause: Control = d.ctl({"text": "Pause agent", "class": "Button"})
	var undo: Control = d.ctl({"text": "Undo", "class": "Button"})
	if pause != null and undo != null:
		await d.spotlight(pause.get_global_rect().merge(undo.get_global_rect()).grow(4.0), 10.0)
	await d.sync()
	await d.spotlight_off()
	d.say("end")
	await d.sync()
	await d.wait(1.5)
	await d.fade_out(0.9)
