extends RefCounted

# Finding things on screen. The storyboards name controls by what a viewer would call them
# ("Select", "Libraries"), never by node path, so a re-render survives UI refactors.
#
# A query is one of:
#   "Select"                       a visible control whose text / tooltip / name matches (exact
#                                  match wins over "contains")
#   {text, tooltip, name, class}   every given key must match; add `under: <Node>` to scope it
#   Callable(Control) -> bool      anything else
# Subtrees named QuickstartFx and SubViewports (the 3D scene: tens of thousands of nodes) are skipped.

static func find(root: Node, query: Variant) -> Control:
	var all := find_all(root, query)
	return all[0] if not all.is_empty() else null

static func find_all(root: Node, query: Variant) -> Array:
	var scope := root
	if query is Dictionary and (query as Dictionary).has("under"):
		scope = (query as Dictionary)["under"]
	var exact: Array = []
	var loose: Array = []
	_walk(scope, query, exact, loose)
	return exact if not exact.is_empty() else loose

static func _walk(n: Node, query: Variant, exact: Array, loose: Array) -> void:
	if n.name == &"QuickstartFx" or n is SubViewport:
		return
	if n is Control:
		var c := n as Control
		if c.is_visible_in_tree() and c.size.x > 0.0 and c.size.y > 0.0:
			match _score(c, query):
				2: exact.append(c)
				1: loose.append(c)
	for ch in n.get_children(true):      # internal ones too: a dialog's OK / Cancel buttons
		_walk(ch, query, exact, loose)

# 2 = exact match, 1 = partial, 0 = none.
static func _score(c: Control, query: Variant) -> int:
	if query is Callable:
		return 2 if (query as Callable).call(c) else 0
	if query is String:
		return _score_text(c, str(query))
	if query is Dictionary:
		var d: Dictionary = query
		var best := 2
		if d.has("class") and not c.is_class(str(d["class"])):
			return 0
		if d.has("name"):
			if str(c.name).to_lower() != str(d["name"]).to_lower():
				return 0
		if d.has("tooltip"):
			if not _norm(c.tooltip_text).contains(_norm(str(d["tooltip"]))):
				return 0
		if d.has("text"):
			var s := _score_text(c, str(d["text"]), false)
			if s == 0:
				return 0
			best = mini(best, s)
		return best
	return 0

static func _score_text(c: Control, want: String, with_meta := true) -> int:
	var w := _norm(want)
	var texts: Array[String] = []
	if "text" in c:
		texts.append(_norm(str(c.get("text"))))
	if c is LineEdit:
		texts.append(_norm((c as LineEdit).placeholder_text))
	if with_meta:
		texts.append(_norm(c.tooltip_text))
		texts.append(_norm(str(c.name)))
	var best := 0
	for t in texts:
		if t.is_empty():
			continue
		if t == w or _strip_glyph(t) == w:
			return 2
		if t.contains(w):
			best = 1
	return best

static func _norm(s: String) -> String:
	return s.replace("\n", " ").strip_edges().to_lower()

# "⬚ select" -> "select": tool buttons lead with an icon glyph.
static func _strip_glyph(s: String) -> String:
	var parts := s.split(" ", false)
	if parts.size() >= 2 and parts[0].length() == 1:
		return " ".join(parts.slice(1))
	return s

# The rect of a tab in any TabContainer / TabBar on screen, by title: {"tab": "Libraries"}.
static func find_tab(root: Node, title: String) -> Rect2:
	var want := _norm(title)
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n.name == &"QuickstartFx" or n is SubViewport:
			continue
		var bar: TabBar = null
		if n is TabContainer:
			bar = (n as TabContainer).get_tab_bar()
		elif n is TabBar:
			bar = n as TabBar
		if bar != null and bar.is_visible_in_tree():
			for i in bar.tab_count:
				if _norm(bar.get_tab_title(i)) == want:
					var r := bar.get_tab_rect(i)
					return Rect2(bar.get_global_rect().position + r.position, r.size)
		stack.append_array(n.get_children(true))
	return Rect2()

# A control's rect in the main canvas, also for controls inside an embedded window (whose own
# coordinates start at the window's client area).
static func global_rect(c: Control) -> Rect2:
	var r := c.get_global_rect()
	var w := c.get_window()
	if w != null and w != c.get_tree().root and w.is_embedded():
		r.position += Vector2(w.position)
	return r

# Logical-px rect for a Control, Rect2, Vector2 (a point), or query.
static func rect_of(root: Node, target: Variant) -> Rect2:
	if target is Rect2:
		return target
	if target is Dictionary and (target as Dictionary).has("tab"):
		var tab_rect := find_tab(root, str((target as Dictionary)["tab"]))
		if tab_rect.size == Vector2.ZERO:
			push_error("quickstart: no tab titled %s" % str(target["tab"]))
		return tab_rect
	if target is Vector2:
		return Rect2(target, Vector2.ZERO)
	var c: Control = target as Control if target is Control else find(root, target)
	if c == null:
		push_error("quickstart: nothing on screen matches %s" % str(target))
		return Rect2()
	return global_rect(c)

static func center_of(root: Node, target: Variant) -> Vector2:
	var r := rect_of(root, target)
	return r.position + r.size * 0.5

# Logical canvas px -> window px (what OS input events carry), through the stretch transform.
static func to_window(window: Window, logical: Vector2) -> Vector2:
	return window.get_final_transform() * logical
