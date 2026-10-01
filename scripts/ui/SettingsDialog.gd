class_name SettingsDialog
extends AcceptDialog

# App settings (AppSettings), reachable from the Home screen and the editor bar. Today: the
# "Agent connections" section — lets an AI agent such as Claude Code connect to this
# running Voxyl over MCP (see McpServer). Off by default. The server's own settings come first,
# then a tab per agent saying how to register Voxyl with it (AgentSetup).

var _enabled: CheckBox
var _port: SpinBox
var _require_token: CheckBox
var _token: LineEdit
var _status: Label
var _snippets: Array[TextEdit] = []   # one per AgentSetup guide, in tab order
var _status_timer: Timer

func _ready() -> void:
	title = "Settings"
	ok_button_text = "Close"
	min_size = Vector2i(620, 0)
	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 10)
	add_child(vbox)

	var heading := Label.new()
	heading.text = "Agent connections"
	heading.add_theme_font_size_override("font_size", 17)
	vbox.add_child(heading)

	var blurb := Label.new()
	blurb.text = "Let an AI agent (like Claude Code or Codex) build in this window over MCP. Its edits show up live and each one is an undo step. Only programs on this computer can connect."
	blurb.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	blurb.custom_minimum_size = Vector2(580, 0)
	blurb.add_theme_color_override("font_color", Color(0.7, 0.7, 0.72))
	vbox.add_child(blurb)

	_enabled = CheckBox.new()
	_enabled.text = "Allow agent connections"
	_enabled.button_pressed = AppSettings.agent_enabled()
	_enabled.toggled.connect(func(on: bool):
		AppSettings.set_value(AppSettings.SECTION_AGENT, "enabled", on)
		_apply())
	vbox.add_child(_enabled)

	var port_row := HBoxContainer.new()
	var port_lbl := Label.new()
	port_lbl.text = "Port"
	port_lbl.custom_minimum_size = Vector2(120, 0)
	port_row.add_child(port_lbl)
	_port = SpinBox.new()
	_port.min_value = 1024
	_port.max_value = 65535
	_port.value = AppSettings.agent_port()
	_port.custom_minimum_size = Vector2(120, 0)
	port_row.add_child(_port)
	var apply_port := Button.new()
	apply_port.text = "Apply"
	apply_port.pressed.connect(func():
		AppSettings.set_value(AppSettings.SECTION_AGENT, "port", int(_port.value))
		_apply())
	port_row.add_child(apply_port)
	var default_port := Button.new()
	default_port.text = "Default (%d)" % AppSettings.DEFAULT_PORT
	default_port.pressed.connect(func():
		_port.value = AppSettings.DEFAULT_PORT
		AppSettings.set_value(AppSettings.SECTION_AGENT, "port", AppSettings.DEFAULT_PORT)
		_apply())
	port_row.add_child(default_port)
	vbox.add_child(port_row)

	_require_token = CheckBox.new()
	_require_token.text = "Require access token"
	_require_token.button_pressed = AppSettings.agent_require_token()
	_require_token.toggled.connect(func(on: bool):
		AppSettings.set_value(AppSettings.SECTION_AGENT, "require_token", on)
		_apply())
	vbox.add_child(_require_token)

	var token_row := HBoxContainer.new()
	var token_lbl := Label.new()
	token_lbl.text = "Access token"
	token_lbl.custom_minimum_size = Vector2(120, 0)
	token_row.add_child(token_lbl)
	_token = LineEdit.new()
	_token.editable = false
	_token.secret = true
	_token.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	token_row.add_child(_token)
	var show_btn := Button.new()
	show_btn.text = "Show"
	show_btn.toggle_mode = true
	show_btn.toggled.connect(func(on: bool): _token.secret = not on)
	token_row.add_child(show_btn)
	var regen := Button.new()
	regen.text = "Regenerate"
	regen.tooltip_text = "Issue a new token. Agents set up with the old one stop working until you give them the new setup command."
	regen.pressed.connect(func():
		AppSettings.regenerate_token()
		_apply())
	token_row.add_child(regen)
	vbox.add_child(token_row)

	# One tab per agent (AgentSetup): how to register Voxyl with it.
	var tabs := TabContainer.new()
	tabs.use_hidden_tabs_for_min_size = true   # the dialog keeps one height whichever tab is open
	for guide in AgentSetup.guides():
		tabs.add_child(_build_guide_tab(guide))
	vbox.add_child(tabs)

	_status = Label.new()
	_status.add_theme_color_override("font_color", Color(0.55, 0.85, 0.65))
	vbox.add_child(_status)

	McpServer.status_changed.connect(_refresh)
	_status_timer = Timer.new()
	_status_timer.wait_time = 1.0
	_status_timer.timeout.connect(_refresh)
	add_child(_status_timer)
	_status_timer.start()
	_refresh()

func _build_guide_tab(guide: Dictionary) -> Control:
	var margin := MarginContainer.new()
	margin.name = guide["title"]   # TabContainer takes the tab's title from the child's name
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 10)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	margin.add_child(box)

	box.add_child(_wrapped_label(guide["intro"], Color(0.7, 0.7, 0.72)))
	box.add_child(_wrapped_label(guide["label"]))
	var snippet := TextEdit.new()
	snippet.editable = false
	snippet.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	snippet.scroll_fit_content_height = true   # show the whole command, token included
	snippet.custom_minimum_size = Vector2(560, 48)
	box.add_child(snippet)
	_snippets.append(snippet)
	var copy := Button.new()
	copy.text = guide["copy"]
	copy.pressed.connect(func(): DisplayServer.clipboard_set(snippet.text))
	box.add_child(copy)
	box.add_child(_wrapped_label(guide["after"], Color(0.6, 0.6, 0.62), 12))
	return margin

func _wrapped_label(text: String, color := Color.TRANSPARENT, font_size := 0) -> Label:
	var lbl := Label.new()
	lbl.text = text
	lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lbl.custom_minimum_size = Vector2(560, 0)
	if color.a > 0.0:
		lbl.add_theme_color_override("font_color", color)
	if font_size > 0:
		lbl.add_theme_font_size_override("font_size", font_size)
	return lbl

func _apply() -> void:
	McpServer.restart()
	_refresh()

func _refresh() -> void:
	if not is_instance_valid(_status):
		return
	var on := AppSettings.agent_enabled()
	_port.editable = on
	_require_token.disabled = not on
	_token.text = AppSettings.agent_token()
	# Set only on a change, so a selection the user is making isn't cleared by the 1s tick.
	var guides := AgentSetup.guides()
	for i in guides.size():
		if _snippets[i].text != guides[i]["snippet"]:
			_snippets[i].text = guides[i]["snippet"]
	_status.text = McpServer.status_text()

# Show the dialog (one per call site; frees itself when closed).
static func open(parent: Node) -> void:
	var d := SettingsDialog.new()
	d.close_requested.connect(d.queue_free)
	d.confirmed.connect(d.queue_free)
	parent.get_tree().root.add_child(d)
	d.popup_centered()
