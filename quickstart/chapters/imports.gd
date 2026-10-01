extends RefCounted
# quickstart: library=empty seed=

# Chapter: the home screen, then importing blocks: vanilla Minecraft (a jar) and GTNH (NEI dumps).
# The OS file pickers can't be recorded, so those clicks are shown (show_click) and the chapter
# hands the panel the same path a pick would have.
# Paths: this machine's, overridable with QUICKSTART_VANILLA_JAR and QUICKSTART_GTNH_DIR.

const VANILLA_JAR := "C:/Users/Infinity/AppData/Roaming/.minecraft/versions/1.21/1.21.jar"
const GTNH_DIR := "C:/Users/Infinity/AppData/Roaming/PrismLauncher/instances/GTNH 2.9 Beta 2/.minecraft"

func _env(name: String, fallback: String) -> String:
	var v := OS.get_environment(name)
	return v if not v.is_empty() else fallback

# The search box inside the Add Blocks window (the Libraries tab has one of its own).
func _panel_search(d) -> Control:
	return d.ctl(func(c): return c is LineEdit and (c as LineEdit).placeholder_text == "Search blocks…" \
		and c.get_window() != d.get_tree().root)

func _panel_prefix(d) -> Control:
	return d.ctl(func(c): return c is LineEdit and str((c as LineEdit).placeholder_text).begins_with("Optional prefix"))

# Wait for the import dialog to finish, then dismiss it (with a shown click).
func _finish_import(d) -> void:
	for i in 400:
		var close_btn: Control = d.ctl({"text": "Close", "class": "Button"})
		if close_btn != null and not (close_btn as Button).disabled:
			break
		await d.wait(0.25)
	await d.wait(1.2)
	await d.click({"text": "Close", "class": "Button"})
	await d.wait(0.6)

# The first block tile of the library grid (or the first whose tooltip contains `want`): selecting one puts its
# turning 3D preview in the panel on the right.
func _tile(d, want := "") -> Control:
	var found: Control = d.ctl(func(c):
		return c.tooltip_text != "" and d.ancestor_of(c, "BlockGrid") != null and c.size.x >= 40.0 and c.size.y >= 40.0 			and (want.is_empty() or c.tooltip_text.to_lower().contains(want.to_lower())))
	return found

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(20)
	d.mark("start")
	await d.fade_in(0.7)

	# --- the home screen ----------------------------------------------------------
	d.say("home")
	await d.wait(1.3)                                  # "This is the main screen:"
	var tabs: Rect2 = d.rect_of({"tab": "Projects"})
	for tab in ["Palettes", "Prefabs", "Libraries"]:
		tabs = tabs.merge(d.rect_of({"tab": tab}))
	await d.spotlight(tabs, 14.0)                      # a vignette on the tabs while they're named
	for tab in ["Palettes", "Prefabs", "Libraries"]:
		await d.click({"tab": tab})
		await d.wait(0.2)
	await d.spotlight_off()
	await d.sync()

	# --- Add blocks ---------------------------------------------------------------
	d.say("empty")
	var add_btn: Control = d.ctl({"text": "Add blocks", "class": "Button"})
	d.arrow(add_btn, "Add blocks", "below")
	await d.wait(1.2)
	await d.click(add_btn)
	await d.arrows_off()
	await d.sync()

	# --- vanilla: a jar -----------------------------------------------------------
	var panel = d.node_of_class("ImportPanel")
	d.caption_top(true)         # the window owns the middle and bottom while it's open
	d.say("vanilla")
	await d.show_click({"text": "Choose .zip", "class": "Button"})
	panel.call("_set_source", _env("QUICKSTART_VANILLA_JAR", VANILLA_JAR))
	await d.settle(10)
	var path_label: Control = d.ctl(func(c): return c is Label and str((c as Label).text).ends_with(".jar"))
	if path_label != null:
		await d.spotlight(path_label, 10.0)
	await d.sync()
	await d.spotlight_off()
	d.say("search")
	await d.click(_panel_search(d))
	await d.type_text("stone_bricks", 11.0)
	await d.wait(0.5)
	await d.click({"text": "Import selected", "class": "Button"})
	await _finish_import(d)
	d.caption_top(false)
	d.say("vanilla_done")
	var tile := _tile(d)
	if tile != null:
		await d.click(tile)          # the right-hand panel shows it, turning
	d.hide_pointer()
	await d.sync()
	await d.wait(0.6)

	# --- GTNH: NEI dumps ----------------------------------------------------------
	await d.click({"text": "Add blocks", "class": "Button"})
	await d.wait(0.7)
	panel = d.node_of_class("ImportPanel")
	d.caption_top(true)
	d.say("gtnh")
	await d.pick_option(d.ctl({"class": "OptionButton", "under": panel}), 1)
	await d.sync()
	d.say("nei")
	# The three Dump buttons the NEI roster needs, ringed one after another as they're named.
	var line: Dictionary = d.line_timing("nei")
	var span: float = float(line["end"]) - d.t
	await d.flash_image("nei-data-dumps.png", 690.0, maxf(span, 5.0), [
		{"rect": Rect2(928, 102, 208, 86), "at": span * 0.30},    # Items
		{"rect": Rect2(928, 198, 208, 86), "at": span * 0.50},    # Blocks
		{"rect": Rect2(928, 583, 208, 86), "at": span * 0.78},    # Item Panel
	])
	await d.sync()
	d.say("gtnh_pick")
	await d.show_click({"text": "Choose folder", "class": "Button"})
	panel.call("_set_source", _env("QUICKSTART_GTNH_DIR", GTNH_DIR))
	await d.settle(10)
	await d.sync()
	d.say("gtnh_import")
	await d.click(_panel_prefix(d))
	await d.type_text("gtnh", 10.0)
	await d.click(_panel_search(d))
	await d.type_text("brick", 10.0)       # matches blocks from a couple of dozen mods: one library each
	await d.wait(0.5)
	await d.click({"text": "Import selected", "class": "Button"})
	await _finish_import(d)

	# --- a GTNH machine ---------------------------------------------------------------
	# (GregTech's machines are rebuilt as a family when any of its blocks is imported, so they came in with the
	# bricks above: no second import, just a look at one.)
	d.caption_top(false)
	d.say("machine")
	await d.wait(0.8)
	var gt: Control = d.ctl({"text": "gtnh.gregtech"})
	if gt != null:
		await d.click(gt)
		await d.wait(0.6)
	# the machines fill the library, so search it for the one we want, and look at that
	var lib_search: Control = d.ctl(func(c): return c is LineEdit and (c as LineEdit).placeholder_text == "Search blocks…" 		and c.get_window() == d.get_tree().root)
	if lib_search != null:
		await d.click(lib_search)
		await d.type_text("bender (lv)", 12.0)
		await d.wait(0.8)
	var machine := _tile(d)
	if machine != null:
		await d.click(machine)
		d.hide_pointer()
	await d.wait(3.2)
	if lib_search != null:                      # (a search also trims the library rail: put it back for the next shot)
		(lib_search as LineEdit).text = ""
		(lib_search as LineEdit).text_changed.emit("")
		await d.wait(0.5)

	# --- the result ---------------------------------------------------------------
	d.say("done")
	var rail: Control = d.ctl({"text": "All blocks"})
	if rail != null:
		d.arrow(rail.get_parent().get_global_rect().grow(-30.0), "One library per mod", "right")
	await d.sync()
	await d.wait(0.8)
	await d.arrows_off()
	await d.fade_out(0.9)
