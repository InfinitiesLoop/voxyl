extends RefCounted
# quickstart: library=real seed=demo

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.settle(20)
	for y in [17, 16, 15, 13, 12, 1]:
		var r = await d.agent("region_text", {"region": {"min": [-8, y, -8], "max": [8, y, 8]}})
		print("TEXT y=%d %s" % [y, JSON.stringify(r).substr(0, 1800)])
	d.mark("start")
