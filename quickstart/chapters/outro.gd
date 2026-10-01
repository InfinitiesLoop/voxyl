extends RefCounted
# quickstart: library=real seed=demo

# Chapter: the closing card over the demo build.

const PILLAR := Vector3(0.0, 9.0, 0.0)

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.agent("selection_clear")
	await d.settle(30)
	d.mark("start")
	d.orbit(PILLAR, 22.0, 10.0, 70.0, 150.0, 9.0)
	await d.fade_in(0.8)
	d.say("bye")
	await d.wait(1.2)
	await d.title_card("voxyl", "Go make something.", 4.0)
	await d.sync()
	await d.fade_out(1.0)
