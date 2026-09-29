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
]]

local HttpService = game:GetService("HttpService")
local MarketplaceService = game:GetService("MarketplaceService")
local RunService = game:GetService("RunService")

local Rojo = script:FindFirstAncestor("Rojo")
local Plugin = Rojo.Plugin
local Packages = Rojo.Packages

local Log = require(Packages.Log)

local Settings = require(Plugin.Settings)
local ServeSession = require(Plugin.ServeSession)
local ignorePlaceIds = require(Plugin.ignorePlaceIds)
local HubVersion = require(script.Version)

local SERVICE_URL = "ws://127.0.0.1:34870/studio"
-- Must match STUDIO_PROTOCOL in Rojo-Hub's src/common/api.ts.
local PROTOCOL = 1
-- Seconds between tries to reach the service after it went away; the last one repeats.
local RETRY_SECONDS = { 1, 2, 5, 10 }
-- How often the connect decision is looked at again (sessions end, pages change).
local TICK_SECONDS = 1
-- A failed auto-connect to one session is not tried again sooner than this.
local SESSION_RETRY_SECONDS = 10
-- If the service has not answered by then, Rojo's own Auto Reconnect runs instead.
local FALLBACK_SECONDS = 3

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
		-- The last auto-connect: { sessionId, at }.
		attempt = nil,
		-- What was last reported to the service as synced, to send only changes.
		reported = nil,
		reportedSession = nil,
		-- The place's name on Roblox; Studio names every DataModel "Place1".
		placeName = nil,
		stopped = false,
		connections = {},
	}, Hub)
end

function Hub:isActive()
	return self.active
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
	self.app:setHubMatch(nil)
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
		self.match = message
		self.app:setHubMatch(message)
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
	local key = if connected then `{connected.sessionId}@{connected.port}` else ""
	if key == self.reported then
		return
	end
	if connected then
		-- The user connected (or an auto-connect worked): nothing is declined any more.
		self.declined = nil
	elseif self.reportedSession then
		-- The session just ended. The service may still name it for a moment (its rojo
		-- is stopping), so it counts as tried: only a new session is connected at once.
		self.attempt = { sessionId = self.reportedSession, at = os.clock() }
	end
	self.reported = key
	self.reportedSession = connected and connected.sessionId
	self:send({ type = "state", connected = connected })
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

	local match = self.match
	if match == nil or match.status ~= "connect" or match.target == nil then
		return
	end
	if not Settings:get("hubAutoConnect") or not RunService:IsEdit() then
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
	local attempt = self.attempt
	if attempt and attempt.sessionId == target.sessionId and os.clock() - attempt.at < SESSION_RETRY_SECONDS then
		return
	end
	self.attempt = { sessionId = target.sessionId, at = os.clock() }

	Log.info("Rojo-Hub: connecting to {} on port {}", target.projectName, target.port)
	app.setHost("localhost")
	app.setPort(tostring(target.port))
	app:startSession()
end

--[[
	The user ended a session (Disconnect) or declined its first sync (Abort):
	that session is not connected again by itself. A new session (the project
	restarted) or connecting by hand lifts it.
]]
function Hub:decline(sessionId)
	self.declined = sessionId or (self.match and self.match.target and self.match.target.sessionId)
end

-- The picker on the Not Connected page.
function Hub:pick(project)
	local match = self.match
	if match and match.status == "choose" and project.reason ~= nil then
		-- Remembered for this place by the service, which then answers "connect".
		self:send({ type = "choose", slotId = project.slotId })
		return
	end
	self.declined = nil
	self.app.setHost("localhost")
	self.app.setPort(tostring(project.port))
	self.app:startSession()
end

return Hub
