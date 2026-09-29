--[[
	The Connect to <project> button on the Not Connected page (spec 007): shown
	only while the service answers "connect", it connects to the port the service
	gives, whatever is in Rojo's address boxes. Green, so it is not mistaken for
	Rojo's own Connect. MIT.
]]

local Rojo = script:FindFirstAncestor("Rojo")
local Plugin = Rojo.Plugin
local Packages = Rojo.Packages

local Roact = require(Packages.Roact)

local Theme = require(Plugin.App.Theme)
local Assets = require(Plugin.Assets)
local SlicedImage = require(Plugin.App.Components.SlicedImage)
local Tooltip = require(Plugin.App.Components.Tooltip)
local bindingUtil = require(Plugin.App.bindingUtil)
local getTextBoundsAsync = require(Plugin.App.getTextBoundsAsync)

local GREEN = Color3.fromHex("2EA043")
local HEIGHT = 34

local e = Roact.createElement

local ConnectButton = Roact.Component:extend("RojoHubConnectButton")

function ConnectButton:init()
	self:setState({ hover = false })
end

function ConnectButton:render()
	local target = self.props.target
	local text = `Connect to {target.projectName}`

	return Theme.with(function(theme)
		local textBounds = getTextBoundsAsync(text, theme.Font.Main, theme.TextSize.Large, math.huge)

		return e("Frame", {
			Size = UDim2.new(1, 0, 0, HEIGHT),
			LayoutOrder = self.props.layoutOrder,
			BackgroundTransparency = 1,
		}, {
			Button = e("ImageButton", {
				-- As wide as its text, but never wider than the page; a long name is cut.
				Size = UDim2.new(1, 0, 0, HEIGHT),
				Position = UDim2.new(1, 0, 0, 0),
				AnchorPoint = Vector2.new(1, 0),
				BackgroundTransparency = 1,

				[Roact.Event.Activated] = self.props.onClick,
				[Roact.Event.MouseEnter] = function()
					self:setState({ hover = true })
				end,
				[Roact.Event.MouseLeave] = function()
					self:setState({ hover = false })
				end,
			}, {
				SizeLimit = e("UISizeConstraint", {
					MaxSize = Vector2.new((theme.TextSize.Body * 2) + textBounds.X, HEIGHT),
				}),

				Text = e("TextLabel", {
					Text = text,
					FontFace = theme.Font.Main,
					TextSize = theme.TextSize.Large,
					TextColor3 = Color3.fromHex("FFFFFF"),
					TextTransparency = self.props.transparency,
					TextTruncate = Enum.TextTruncate.AtEnd,
					Size = UDim2.new(1, -theme.TextSize.Body, 1, 0),
					Position = UDim2.new(0.5, 0, 0, 0),
					AnchorPoint = Vector2.new(0.5, 0),
					BackgroundTransparency = 1,
				}),

				HoverOverlay = e(SlicedImage, {
					slice = Assets.Slices.RoundedBackground,
					color = Color3.fromHex("FFFFFF"),
					transparency = self.props.transparency:map(function(value)
						return bindingUtil.blendAlpha({ if self.state.hover then 0.85 else 1, value })
					end),
					size = UDim2.new(1, 0, 1, 0),
					zIndex = -1,
				}),

				Background = e(SlicedImage, {
					slice = Assets.Slices.RoundedBackground,
					color = GREEN,
					transparency = self.props.transparency,
					size = UDim2.new(1, 0, 1, 0),
					zIndex = -2,
				}),

				Tip = e(Tooltip.Trigger, {
					text = `Connect to localhost:{target.port}, where Rojo-Hub serves {target.projectName}`,
				}),
			}),
		})
	end)
end

return ConnectButton
