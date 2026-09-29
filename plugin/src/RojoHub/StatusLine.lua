--[[
	The Rojo-Hub line on the Not Connected page (spec 007): what the service says
	about this place. Read-only: which project a place syncs with is decided in
	VS Code. MIT.
]]

local Rojo = script:FindFirstAncestor("Rojo")
local Plugin = Rojo.Plugin
local Packages = Rojo.Packages

local Roact = require(Packages.Roact)

local Theme = require(Plugin.App.Theme)

local e = Roact.createElement

local NOT_RUNNING = "Rojo-Hub isn't running. Open VS Code with Rojo-Hub, or connect by hand."

local function StatusLine(props)
	return Theme.with(function(theme)
		return e("TextLabel", {
			Text = if props.match then `Rojo-Hub: {props.match.message}` else NOT_RUNNING,
			FontFace = theme.Font.Main,
			TextSize = theme.TextSize.Small,
			TextColor3 = theme.SubTextColor,
			TextTransparency = props.transparency,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextWrapped = true,
			Size = UDim2.new(1, 0, 0, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			BackgroundTransparency = 1,
			LayoutOrder = props.layoutOrder,
		})
	end)
end

return StatusLine
