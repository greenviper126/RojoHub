--[[
	Rojo-Hub (spec 010). MIT licensed, like the rest of Rojo-Hub.

	Creates the instance a patch adds, as Rojo's reify does with Instance.new,
	except where Studio already has it: a switch to a branch whose project file
	adds a node like StarterCharacterScripts (which cannot be created, but
	every place has) would otherwise drop that node and everything under it,
	until a new session's first sync matched it by name. Here it is adopted
	instead, as that first sync would: the existing child of the same Name and
	ClassName that no Rojo ID owns takes the ID. Under an adopted instance,
	existing children are adopted the same way before anything is created, so
	a script already there is not duplicated.
]]

local Adopt = {}

-- Instances adopted this plugin session; their children are matched before created.
local adopted = setmetatable({}, { __mode = "k" })

local function findUnowned(instanceMap, parentInstance, virtualInstance)
	if parentInstance == nil then
		return nil
	end
	for _, child in parentInstance:GetChildren() do
		-- Guarded like hydrate: some children of the DataModel cannot be read at all.
		local ok, matches = pcall(function()
			return child.Name == virtualInstance.Name and child.ClassName == virtualInstance.ClassName
		end)
		if ok and matches and instanceMap.fromInstances[child] == nil then
			return child
		end
	end
	return nil
end

--[[
	Returns createSuccess, instance, wasAdopted. An adopted instance keeps its
	Name and Parent (a service's are locked), so reify leaves both alone.
]]
function Adopt.create(instanceMap, parentInstance, virtualInstance)
	if parentInstance ~= nil and adopted[parentInstance] then
		local existing = findUnowned(instanceMap, parentInstance, virtualInstance)
		if existing then
			adopted[existing] = true
			return true, existing, true
		end
	end

	local createSuccess, instance = pcall(Instance.new, virtualInstance.ClassName)
	if createSuccess then
		return true, instance, false
	end

	local existing = findUnowned(instanceMap, parentInstance, virtualInstance)
	if existing then
		adopted[existing] = true
		return true, existing, true
	end
	return false, instance, false
end

return Adopt
