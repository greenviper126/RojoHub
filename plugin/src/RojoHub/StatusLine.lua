--[[
	The Rojo-Hub line on the Not Connected page (spec 007): what the service
	says about this place, and a picker of every serving project. MIT.
]]

local Rojo = script:FindFirstAncestor("Rojo")
local Plugin = Rojo.Plugin
local Packages = Rojo.Packages

local Roact = require(Packages.Roact)

local Theme = require(Plugin.App.Theme)
local Dropdown = require(Plugin.App.Components.Dropdown)

local e = Roact.createElement

local NOT_RUNNING = "Rojo-Hub isn't running. Open VS Code with Rojo-Hub, or connect by hand."

local function StatusLine(props)
	local match = props.match
	local options = {}
	local byLabel = {}
	if match then
		for _, project in match.projects do
			local label = `{project.projectName} · {project.targetLabel ~= "" and project.targetLabel or project.port}`
			if not project.supported then
				label ..= " (Rojo too old)"
			end
			table.insert(options, label)
			byLabel[label] = project
		end
	end

	return Theme.with(function(theme)
		return e("Frame", {
			Size = UDim2.new(1, 0, 0, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			LayoutOrder = props.layoutOrder,
			BackgroundTransparency = 1,
			ZIndex = 3,
		}, {
			Layout = e("UIListLayout", {
				FillDirection = Enum.FillDirection.Vertical,
				HorizontalAlignment = Enum.HorizontalAlignment.Right,
				SortOrder = Enum.SortOrder.LayoutOrder,
				Padding = UDim.new(0, 6),
			}),

			Message = e("TextLabel", {
				Text = if match then match.message else NOT_RUNNING,
				FontFace = theme.Font.Main,
				TextSize = theme.TextSize.Small,
				TextColor3 = theme.SubTextColor,
				TextTransparency = props.transparency,
				TextXAlignment = Enum.TextXAlignment.Left,
				TextWrapped = true,
				Size = UDim2.new(1, 0, 0, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				BackgroundTransparency = 1,
				LayoutOrder = 1,
			}),

			Picker = if #options > 0
				then e(Dropdown, {
					options = options,
					active = if match.status == "choose" then "Pick this place's project" else "Sync with…",
					transparency = props.transparency,
					layoutOrder = 2,
					zIndex = 3,
					onClick = function(label)
						local project = byLabel[label]
						if project and project.supported then
							props.onPick(project)
						end
					end,
				})
				else nil,
		})
	end)
end

return StatusLine
