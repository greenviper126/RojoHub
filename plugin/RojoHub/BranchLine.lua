--[[
	The branch line on the Connected page, under the project name: which branch
	(or worktree) Rojo-Hub is serving, so a switch is visible in Studio. The text
	is made by Hub:branchText from the service's answer. MIT.
]]

local Rojo = script:FindFirstAncestor("Rojo")
local Plugin = Rojo.Plugin
local Packages = Rojo.Packages

local Roact = require(Packages.Roact)

local Theme = require(Plugin.App.Theme)

local e = Roact.createElement

local function BranchLine(props)
	return Theme.with(function(theme)
		return e("TextLabel", {
			Text = props.text,
			FontFace = theme.Font.Main,
			TextSize = theme.TextSize.Medium,
			TextColor3 = theme.ConnectionDetails.AddressColor,
			TextTransparency = props.transparency,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextTruncate = Enum.TextTruncate.AtEnd,
			Size = UDim2.new(1, 0, 0, theme.TextSize.Medium),
			BackgroundTransparency = 1,
			LayoutOrder = props.layoutOrder,
		})
	end)
end

return BranchLine
