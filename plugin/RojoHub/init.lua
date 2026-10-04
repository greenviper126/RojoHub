--[[
	Rojo-Hub's part of the plugin (spec 007). MIT licensed, like the rest of
	Rojo-Hub; the files around this folder are Rojo's (MPL-2.0).

	Keeps a WebSocket to the Rojo-Hub service, tells it which place this is, and
	connects Rojo to the project the service says serves this place: when the
	place opens, when that project starts, and again after its rojo restarts
	with a new session. The service decides which project; this only connects.

	It never takes over a session the user started, never reconnects a session
	the user disconnected from or declined to sync, and does nothing outside edit
	mode.

	When the project's rojo restarts (a crash, a port move, an agent's stop and
	start), the session it was synced to ends. That loss is held for a moment:
	the panel stays on Connected, Rojo's notifications (and their sound) are
	not shown, and the new session is connected to quietly (spec 010). Only if
	no new session comes is the disconnect shown as Rojo would have.
]]

local HttpService = game:GetService("HttpService")
local MarketplaceService = game:GetService("MarketplaceService")
local RunService = game:GetService("RunService")

local Rojo = script:FindFirstAncestor("Rojo")
local Plugin = Rojo.Plugin
local Packages = Rojo.Packages

local Log = require(Packages.Log)

local Assets = require(Plugin.Assets)
local Settings = require(Plugin.Settings)
local ServeSession = require(Plugin.ServeSession)
local ignorePlaceIds = require(Plugin.ignorePlaceIds)
local HubVersion = require(script.Version)

local SERVICE_URL = "ws://127.0.0.1:34870/studio"
-- Must match STUDIO_PROTOCOL in Rojo-Hub's src/common/api.ts.
local PROTOCOL = 2
-- Seconds between tries to reach the service after it went away; the last one repeats.
local RETRY_SECONDS = { 1, 2, 5, 10 }
-- How often the connect decision is looked at again (sessions end, pages change).
local TICK_SECONDS = 1
-- A failed auto-connect to one session is not tried again sooner than this,
-- nor more than SESSION_TRIES times.
local SESSION_RETRY_SECONDS = 10
local SESSION_TRIES = 3
-- If the service has not answered by then, Rojo's own Auto Reconnect runs instead.
local FALLBACK_SECONDS = 3
-- A lost session is held this long for a new one (an agent's stop and start), and up to
-- RESUME_MAX_SECONDS while the service says the project is restarting by itself.
local RESUME_GRACE_SECONDS = 5
local RESUME_MAX_SECONDS = 60
-- Changes the plugin could not apply are reported with at most this many examples.
local UNAPPLIED_ITEMS = 8

local Hub = {}
Hub.__index = Hub

function Hub.new(app)
	return setmetatable({
		app = app,
		client = nil,
		-- The service greeted this socket.
		active = false,
		-- The service's last answer for this place (StudioMatch in api.ts).
		match = nil,
		failures = 0,
		nextAttempt = 0,
		-- A session the user ended or declined; not connected to again by itself.
		declined = nil,
		-- The last auto-connect: { sessionId, at, tries }.
		attempt = nil,
		-- What was last reported to the service as synced, to send only changes.
		reported = nil,
		reportedSession = nil,
		-- Where the reported session was: { port, slotId }.
		reportedWhere = nil,
		-- A lost session being held: { since, sessionId, port, slotId, details }.
		resuming = nil,
		-- No auto-connect before this (os.clock()), after the user disconnected during a resume.
		holdOffUntil = 0,
		-- The session whose patches are watched for changes that could not be applied.
		hookedSession = nil,
		-- The place's name on Roblox; Studio names every DataModel "Place1".
		placeName = nil,
		stopped = false,
		connections = {},
	}, Hub)
end

function Hub:isActive()
	return self.active
end

-- A lost session is being held: App keeps its page and shows none of Rojo's connection notifications.
function Hub:isResuming()
	return self.resuming ~= nil
end

--[[
	Starts talking to the service. `fallback` runs once if the service does not
	answer within FALLBACK_SECONDS: without Rojo-Hub running, the plugin behaves
	like Rojo's own.
]]
function Hub:start(fallback)
	table.insert(
		self.connections,
		game:GetPropertyChangedSignal("PlaceId"):Connect(function()
			self:lookUpPlaceName()
			self:sendHello()
		end)
	)
	self:lookUpPlaceName()
	self.thread = task.spawn(function()
		while not self.stopped do
			if self.client == nil and os.clock() >= self.nextAttempt then
				self:open()
			end
			self:evaluate()
			task.wait(TICK_SECONDS)
		end
	end)
	task.delay(FALLBACK_SECONDS, function()
		if not self.active and not self.stopped then
			Log.trace("Rojo-Hub's service did not answer; using Rojo's own Auto Reconnect")
			fallback()
		end
	end)
end

function Hub:stop()
	self.stopped = true
	for _, connection in self.connections do
		connection:Disconnect()
	end
	if self.client then
		local client = self.client
		self.client = nil
		pcall(client.Close, client)
	end
end

function Hub:open()
	local ok, client =
		pcall(HttpService.CreateWebStreamClient, HttpService, Enum.WebStreamClientType.WebSocket, { Url = SERVICE_URL })
	if not ok then
		self:lost("could not open: " .. tostring(client))
		return
	end
	self.client = client

	local connections = {}
	local function finish(reason)
		for _, connection in connections do
			connection:Disconnect()
		end
		-- Error and Closed both fire for one failure; only the first counts.
		if self.client == client then
			self.client = nil
			self:lost(reason)
		end
	end
	table.insert(
		connections,
		client.MessageReceived:Connect(function(text)
			self:receive(text)
		end)
	)
	table.insert(
		connections,
		client.Error:Connect(function(code, message)
			finish(`error {code}: {message}`)
		end)
	)
	table.insert(
		connections,
		client.Closed:Connect(function()
			finish("closed")
		end)
	)
end

function Hub:lost(reason)
	if self.active then
		Log.info("Lost Rojo-Hub's service ({}); trying again", reason)
	else
		Log.trace("Rojo-Hub's service is not reachable ({})", reason)
	end
	self.active = false
	self.match = nil
	self.reported = nil
	self.failures += 1
	self.nextAttempt = os.clock() + RETRY_SECONDS[math.min(self.failures, #RETRY_SECONDS)]
	self:show(nil)
end

-- Draws the service's answer. A drawing error must never stop the connecting.
function Hub:show(match)
	local ok, err = pcall(self.app.setHubMatch, self.app, match)
	if not ok then
		Log.warn("Rojo-Hub could not show its status: {}", err)
	end
end

function Hub:send(message)
	if self.client == nil then
		return
	end
	local ok, err = pcall(function()
		self.client:Send(HttpService:JSONEncode(message))
	end)
	if not ok then
		Log.trace("Could not send to Rojo-Hub: {}", err)
	end
end

function Hub:receive(text)
	local ok, message = pcall(HttpService.JSONDecode, HttpService, text)
	if not ok or type(message) ~= "table" then
		return
	end
	if message.type == "welcome" then
		self.active = true
		self.failures = 0
		self.reported = nil
		Log.trace("Connected to Rojo-Hub {}", message.serviceVersion)
		self:sendHello()
	elseif message.type == "match" then
		local before = self.match and self.match.target
		local after = message.target
		if
			after
			and after.reason == "assigned"
			and not (before and before.reason == "assigned" and before.slotId == after.slotId)
		then
			-- Assigned in VS Code just now: that is asking for a sync, even to a session the user left.
			self.declined = nil
			self.attempt = nil
			self.holdOffUntil = 0
		end
		self.match = message
		self:show(message)
		self:evaluate()
	end
end

-- The published name, for the Rojo-Hub panel; looked up once per place ID, then hello is sent again.
function Hub:lookUpPlaceName()
	local placeId = game.PlaceId
	self.placeName = nil
	if ignorePlaceIds[tostring(placeId)] then
		return
	end
	task.spawn(function()
		local ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, placeId)
		if ok and type(info) == "table" and type(info.Name) == "string" and game.PlaceId == placeId then
			self.placeName = info.Name
			self:sendHello()
		end
	end)
end

function Hub:sendHello()
	if not self.active then
		return
	end
	local placeId = tostring(game.PlaceId)
	local prior = self.app:getPriorSyncInfo()
	self:send({
		type = "hello",
		protocol = PROTOCOL,
		pluginVersion = HubVersion,
		-- As strings: JSONEncode may round integers this large.
		placeId = placeId,
		gameId = tostring(game.GameId),
		placeName = self.placeName or game.Name,
		unsaved = ignorePlaceIds[placeId] == true,
		remembered = prior.projectName,
	})
end

--[[
	Whether this place has synced with the project before (the service keeps
	that per place and project), so Rojo's first-sync confirmation is not asked
	again. Asked by the confirm callback in App.
]]
function Hub:accepted(projectName)
	local target = self.match and self.match.target
	return target ~= nil and target.projectName == projectName and target.accepted == true
end

-- The session Rojo is synced to now, or nil.
function Hub:currentSession()
	local session = self.app.serveSession
	if session == nil or session:getStatus() ~= ServeSession.Status.Connected then
		return nil
	end
	local api = session.__apiContext
	return {
		port = tonumber(string.match(api.__baseUrl, ":(%d+)$")),
		projectName = self.app.state.projectName,
		sessionId = api.__sessionId,
	}
end

-- Tells the service what this place is synced to, when that changed.
function Hub:report()
	local connected = self:currentSession()
	local confirming = self.app.state.appStatus == "Confirming"
	local key = (if connected then `{connected.sessionId}@{connected.port}` else "") .. (if confirming then "?" else "")
	if key == self.reported then
		return
	end
	if connected then
		-- The user connected (or an auto-connect worked): nothing is declined any more.
		self.declined = nil
		if self.resuming then
			Log.info("Rojo-Hub: resumed {} on a new session", connected.projectName)
			self.resuming = nil
		end
		local target = self.match and self.match.target
		self.reportedWhere = {
			port = connected.port,
			slotId = if target and target.port == connected.port then target.slotId else nil,
		}
		self:watchUnapplied(connected.sessionId)
	elseif self.reportedSession then
		-- The session just ended. The service may still name it for a moment (its rojo
		-- is stopping), so it counts as tried: only a new session is connected at once.
		self.attempt = { sessionId = self.reportedSession, at = os.clock(), tries = 1 }
	end
	if confirming and self.resuming then
		-- The new session asks for confirmation: that page is shown, so the hold is over.
		self.resuming = nil
	end
	self.reported = key
	self.reportedSession = connected and connected.sessionId
	self:send({ type = "state", connected = connected, confirming = confirming })
end

--[[
	The one place that decides to connect. Called on every answer and every
	TICK_SECONDS, so it acts as soon as a session ends or a page is left.
]]
function Hub:evaluate()
	if not self.active then
		return
	end
	self:report()

	if self.resuming and not self:keepResuming() then
		self:giveUp()
	end

	local match = self.match
	if match == nil or match.status ~= "connect" or match.target == nil then
		return
	end
	if not Settings:get("hubAutoConnect") or not RunService:IsEdit() then
		return
	end
	if os.clock() < self.holdOffUntil then
		return
	end
	local app = self.app
	if app.serveSession ~= nil then
		-- Connecting, confirming or synced: never take over a session.
		return
	end
	local page = app.state.appStatus
	if page == "Settings" or page == "Confirming" then
		return
	end

	local target = match.target
	if self.declined == target.sessionId then
		return
	end
	if not app:isSyncLockAvailable() then
		-- Team Create: a teammate is syncing this place. Trying would only show an error each time.
		return
	end
	local attempt = self.attempt
	local tries = 0
	if attempt and attempt.sessionId == target.sessionId then
		if os.clock() - attempt.at < SESSION_RETRY_SECONDS or attempt.tries >= SESSION_TRIES then
			return
		end
		tries = attempt.tries
	end
	self.attempt = { sessionId = target.sessionId, at = os.clock(), tries = tries + 1 }

	self:connect(target)
end

-- Connects to the service's port, never through Rojo's address boxes: those are the user's (spec 007).
function Hub:connect(target)
	Log.info("Rojo-Hub: connecting to {} on port {}", target.projectName, target.port)
	self.app:startSession({ host = "localhost", port = tostring(target.port) })
end

--[[
	The Connect to <project> button: connecting by hand, so a session the user
	ended or declined is connected again.
]]
function Hub:connectNow()
	local match = self.match
	if match == nil or match.status ~= "connect" or match.target == nil or self.app.serveSession ~= nil then
		return
	end
	local target = match.target
	self.declined = nil
	self.holdOffUntil = 0
	self.attempt = { sessionId = target.sessionId, at = os.clock(), tries = SESSION_TRIES }
	self:connect(target)
end

--[[
	The user ended a session (Disconnect) or declined its first sync (Abort):
	that session is not connected again by itself. A new session (the project
	restarted) or connecting by hand lifts it.
]]
function Hub:decline(sessionId)
	self.declined = sessionId or (self.match and self.match.target and self.match.target.sessionId)
	self.resuming = nil
end

--[[
	Called by App when its session ends, before it shows the disconnect.
	Returns true to hold the loss (App then shows nothing): the session was
	the project's, the user did not end it, and the service may name a new
	one any moment. Errors while connecting to that new one are held too.
]]
function Hub:holdLoss(details)
	if self.resuming then
		self.resuming.details = details
		return true
	end
	local lost = self.reportedSession
	if not self.active or lost == nil or self.declined == lost then
		return false
	end
	if not Settings:get("hubAutoConnect") or not RunService:IsEdit() then
		return false
	end
	local where = self.reportedWhere or {}
	self.resuming =
		{ since = os.clock(), sessionId = lost, port = where.port, slotId = where.slotId, details = details }
	Log.info("Rojo-Hub: the session ended ({}); waiting for the project to come back", details or "closed")
	return true
end

-- Whether the held loss may still be resumed, from the service's latest answer.
function Hub:keepResuming()
	local resuming = self.resuming
	local elapsed = os.clock() - resuming.since
	if elapsed > RESUME_MAX_SECONDS then
		return false
	end
	local match = self.match
	if match == nil then
		return elapsed < RESUME_GRACE_SECONDS
	end
	if match.status == "connect" and match.target then
		-- Only the same project comes back quietly; another one is a real change.
		local target = match.target
		return target.port == resuming.port or (resuming.slotId ~= nil and target.slotId == resuming.slotId)
	end
	if match.status == "stopped" then
		return match.restarting == true or elapsed < RESUME_GRACE_SECONDS
	end
	return false
end

-- No new session came: shows the disconnect as Rojo would have.
function Hub:giveUp()
	local resuming = self.resuming
	self.resuming = nil
	Log.info("Rojo-Hub: the project did not come back; showing the disconnect")
	local app = self.app
	local ok, err = pcall(function()
		if app.serveSession ~= nil then
			-- A connect is under way: show it.
			app:setState({ appStatus = "Connecting" })
		elseif resuming.details ~= nil then
			app:setState({
				appStatus = "Error",
				errorMessage = tostring(resuming.details),
				toolbarIcon = Assets.Images.PluginButtonWarning,
			})
			app:addNotification({ text = tostring(resuming.details), timeout = 10 })
		else
			app:setState({ appStatus = "NotConnected", toolbarIcon = Assets.Images.PluginButton })
			app:addNotification({ text = "Disconnected from session.", timeout = 10 })
		end
	end)
	if not ok then
		Log.warn("Rojo-Hub could not show the disconnect: {}", err)
	end
end

--[[
	The user pressed Disconnect while a loss was held (the page still said
	Connected): stop waiting, and do not connect by itself for a while, since
	the session that comes back is a new one.
]]
function Hub:cancelResume()
	if self.resuming == nil then
		return
	end
	self.resuming = nil
	self.holdOffUntil = os.clock() + RESUME_MAX_SECONDS
	pcall(function()
		self.app:setState({ appStatus = "NotConnected", toolbarIcon = Assets.Images.PluginButton })
	end)
end

-- Studio's path of an instance in a patch, whether it exists yet or not.
local function pathOf(instanceMap, added, id, depth)
	local instance = instanceMap.fromIds[id]
	if instance ~= nil then
		local ok, name = pcall(instance.GetFullName, instance)
		return if ok then name else "?"
	end
	local virtual = added[id]
	if virtual ~= nil and depth < 50 then
		return pathOf(instanceMap, added, virtual.Parent, depth + 1) .. "." .. tostring(virtual.Name)
	end
	return "?"
end

--[[
	Describes what a patch left unapplied, briefly: the topmost instances that
	could not be added, the properties that could not be set, the instances that
	could not be removed. Returns total, items.
]]
function Hub.describeUnapplied(instanceMap, unapplied)
	local items = {}
	local total = 0
	local function item(text)
		total += 1
		if #items < UNAPPLIED_ITEMS then
			table.insert(items, text)
		end
	end
	local added = unapplied.added or {}
	for id, virtual in added do
		if added[virtual.Parent] == nil then
			item(`{pathOf(instanceMap, added, id, 0)} ({virtual.ClassName}, not added)`)
		else
			total += 1
		end
	end
	for _, update in unapplied.updated or {} do
		local names = {}
		for name in update.changedProperties or {} do
			table.insert(names, name)
		end
		table.sort(names)
		if #names > 0 then
			item(`{pathOf(instanceMap, added, update.id, 0)}: {table.concat(names, ", ")} not set`)
		elseif update.changedName or update.changedClassName then
			item(`{pathOf(instanceMap, added, update.id, 0)} (not renamed)`)
		end
	end
	for _, removed in unapplied.removed or {} do
		local name = if typeof(removed) == "Instance"
			then removed:GetFullName()
			else pathOf(instanceMap, added, removed, 0)
		item(`{name} (not removed)`)
	end
	return total, items
end

-- Reports to the service what each patch of this session could not apply (spec 010).
function Hub:watchUnapplied(sessionId)
	if self.hookedSession == sessionId then
		return
	end
	local session = self.app.serveSession
	if session == nil then
		return
	end
	self.hookedSession = sessionId
	session:hookPostcommit(function(_patch, instanceMap, unapplied)
		if unapplied == nil then
			return
		end
		local ok, total, items = pcall(Hub.describeUnapplied, instanceMap, unapplied)
		if ok and total > 0 then
			Log.info("Rojo-Hub: {} changes could not be applied: {}", total, table.concat(items, "; "))
			self:send({ type = "unapplied", sessionId = sessionId, total = total, items = items })
		end
	end)
end

return Hub
