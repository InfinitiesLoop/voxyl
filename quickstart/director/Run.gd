extends SceneTree

# Entry point for rendering a quickstart chapter. Run it through pipeline/make.py, or by hand:
#
#   godot --path . --windowed --resolution 1920x1080 --write-movie out.avi --fixed-fps 30 \
#         -s res://quickstart/director/Run.gd -- --chapter=selection --out=<dir> --sandbox=<dir>
#
# (Leave off --write-movie to watch it live.) It boots the real Main scene — in a --sandbox, so
# the app looks like a fresh install — adds the overlay stack and the director, and plays
# chapters/<chapter>.gd. Nothing here is loaded by the normal app: -s replaces the main scene,
# so a shipping build never sees any of this.
#
# User args: --chapter=NAME  --out=DIR  --logical=WxH (the canvas the UI lays out in, default
# 1600x900; the window is scaled up from it)  --no-captions  (skip burned-in captions; the SRT
# is still written)  --keep-mouse  (don't make the window click-through while recording)

const DIRECTOR := "res://quickstart/director/Director.gd"
const FX := "res://quickstart/director/Fx.gd"

func _initialize() -> void:
	_boot.call_deferred()

func _boot() -> void:
	var args := _parse_args()
	var chapter := str(args.get("chapter", "selection"))
	var out_dir := str(args.get("out", ProjectSettings.globalize_path("res://quickstart/out/%s" % chapter)))
	var logical := Vector2i(1600, 900)
	if args.has("logical"):
		var p := str(args["logical"]).split("x")
		logical = Vector2i(int(p[0]), int(p[1]))

	DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED)
	if not args.has("keep-mouse"):
		# Real mouse movement over the window mustn't leak into a take; synthetic events are unaffected.
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_MOUSE_PASSTHROUGH, true)
	root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
	root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_KEEP
	root.content_scale_size = logical

	var main := (load("res://scenes/Main.tscn") as PackedScene).instantiate() as Control
	root.add_child(main)
	await process_frame
	print("[quickstart] window=%s visible=%s content_scale=%s aspect=%d final=%s main=%s" % [
		root.size, root.get_visible_rect().size, root.content_scale_size, root.content_scale_aspect,
		root.get_final_transform(), main.size])

	var fx: Node = (load(FX) as GDScript).new()
	fx.build(root, Vector2(logical))
	var director: Node = (load(DIRECTOR) as GDScript).new()
	director.name = "QuickstartDirector"
	root.add_child(director)
	director.setup(main, fx, out_dir, chapter, not args.has("no-captions"))

	var script := load("res://quickstart/chapters/%s.gd" % chapter) as GDScript
	if script == null:
		push_error("quickstart: no chapter script for '%s'" % chapter)
		quit(1)
		return
	_play.call_deferred(director, script.new())

func _play(director: Node, chapter: RefCounted) -> void:
	await chapter.run(director)
	director.finish()
	await create_timer(0.3).timeout
	quit()

func _parse_args() -> Dictionary:
	var out := {}
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--"):
			var kv := a.substr(2).split("=", true, 1)
			if kv.size() > 1:
				out[kv[0]] = kv[1]
			else:
				out[kv[0]] = true
	return out
