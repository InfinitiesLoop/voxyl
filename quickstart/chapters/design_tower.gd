extends RefCounted
# quickstart: library=real seed=

# Not part of the film: builds chapters/watchtower.build.json live and captures it, so the build can be
# judged (and refined in design/watchtower.py) before the agent chapter replays it on camera.
# Run:  make.py design design_tower   -> out/design_tower/sandbox/captures/*.png

const BUILD := "res://quickstart/chapters/watchtower.build.json"

func _err(r) -> String:
	return str(r["__error"]) if r is Dictionary and r.has("__error") else ""

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(BUILD))
	var pal: Dictionary = data["palette"]
	var r = await d.agent("palette_create", {"name": pal["name"], "libraries": pal["libraries"], "entries": pal["entries"]})
	print("DESIGN palette: ", _err(r), " ", str(r).substr(0, 200))
	await d.agent("project_create", {"name": "Watchtower", "palettes": [pal["name"]]})
	await d.settle(20)
	for step in data["steps"]:
		for step_call in step["calls"]:
			var args: Dictionary = (step_call["args"] as Dictionary).duplicate(true)
			args["animate"] = false
			var res = await d.agent(step_call["tool"], args)
			var rej = res.get("rejected", []) if res is Dictionary else []
			print("DESIGN ", step["label"], ": placed=", res.get("placed", "?") if res is Dictionary else "?", " rejected=", rej.size() if rej is Array else rej, " ", _err(res))
	for step in data.get("iteration", []):
		for step_call in step["calls"]:
			var args2: Dictionary = (step_call["args"] as Dictionary).duplicate(true)
			if step_call["tool"] != "region_copy":
				args2["animate"] = false
			var res2 = await d.agent(step_call["tool"], args2)
			print("DESIGN iterate ", step["label"], ": ", str(res2).substr(0, 140))
	await d.settle(40)
	var shots := [
		["hero",   {"frame": {"all": true}, "from": "se", "elevation": 22}],
		["front",  {"frame": {"all": true}, "from": "s", "elevation": 8}],
		["east",   {"frame": {"all": true}, "from": "e", "elevation": 12}],
		["high",   {"frame": {"all": true}, "from": "sw", "elevation": 40}],
		["roof",   {"frame": {"min": [-8, 20, -8], "max": [8, 48, 8]}, "from": "se", "elevation": 18}],
		["hut",    {"frame": {"min": [16, 10, -4], "max": [28, 24, 4]}, "from": "se", "elevation": 22}],
		["pond",   {"frame": {"min": [-4, 0, 4], "max": [14, 12, 16]}, "from": "s", "elevation": 28}],
	]
	for s in shots:
		var args: Dictionary = (s[1] as Dictionary).duplicate(true)
		args["size"] = [1280, 720]
		var cap = await d.agent("capture", args)
		print("DESIGN capture ", s[0], " ", _err(cap))
	d.mark("start")
