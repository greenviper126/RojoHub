--[[
	The "reopen this place" line (both pages). A plugin is loaded when a place
	opens, so a Rojo-Hub update reaches an open place's plugin only then. The
	service names its version in every match; when it is newer than this
	plugin's, this says so. Nil when they agree, or the service did not say. MIT.
]]

local HubVersion = require(script.Parent.Version)

local function parts(version)
	local numbers = {}
	for piece in string.gmatch(version, "%d+") do
		table.insert(numbers, tonumber(piece))
	end
	return numbers
end

-- True when `a` is an older dotted version than `b`.
local function older(a, b)
	local left, right = parts(a), parts(b)
	for i = 1, math.max(#left, #right) do
		local x, y = left[i] or 0, right[i] or 0
		if x ~= y then
			return x < y
		end
	end
	return false
end

local function updateNote(match)
	local installed = match and match.serviceVersion
	if type(installed) ~= "string" or not older(HubVersion, installed) then
		return nil
	end
	-- The Connected page shows this on one line cut at its end, so the instruction comes first.
	return `Reopen this place to update Rojo-Hub: plugin {HubVersion}, {installed} installed.`
end

return updateNote
