extends RefCounted
# quickstart: library=real seed=demo

# Chapter: the opening. A hero shot of the demo build behind the title, then the three install steps.
# (The next chapter opens on the home screen itself.)

const PILLAR := Vector3(0.0, 9.0, 0.0)

func run(d) -> void:
	d.set_fade(1.0)
	await d.settle(10)
	await d.agent("project_open", {"name": "Conduit Pillar"})
	await d.agent("selection_clear")
	await d.settle(30)
	d.mark("start")
	d.orbit(PILLAR, 22.0, 10.0, -30.0, 70.0, 12.0)
	await d.fade_in(0.8)
	d.say("hook")
	await d.wait(0.8)
	await d.title_card("voxyl", "Build first. Decide later.", 4.4)
	await d.sync()
	await d.wait(0.6)
	await d.fade_out(0.7)
