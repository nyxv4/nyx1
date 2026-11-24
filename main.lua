repeat task.wait() until game:IsLoaded()
if type(setthreadidentity) == 'function' then
	getgenv().NYXSetIdentity = setthreadidentity
	shared.NYXSetIdentity = setthreadidentity
	pcall(setthreadidentity, 8)
end
if shared.vape then pcall(function() shared.vape:Uninject() end) end

local NYX_KEY = getgenv and getgenv().NYX_KEY or nil
local NYX_HWID = getgenv and getgenv().NYX_HWID or nil
if type(NYX_KEY) ~= 'string' or type(NYX_HWID) ~= 'string' then
	error('NYX requires a valid key. Get your loader from the Discord server.', 0)
end
local function urlEncode(s)
	return (tostring(s):gsub('([^%w%-_.~])', function(c) return string.format('%%%02X', c:byte()) end))
end
local authOk = false
for _ = 1, 3 do
	local suc, res = pcall(function()
		return game:HttpGet('https://script-whitelist.nyx178bedwars.workers.dev/api/verify?key=' .. urlEncode(NYX_KEY) .. '&hwid=' .. urlEncode(NYX_HWID), true)
	end)
	if suc and type(res) == 'string' and res:find('"ok":true', 1, true) then
		authOk = true
		break
	end
	task.wait(1)
end
if not authOk then
	error('NYX key is invalid, expired, or revoked. Re-check it in the Discord server.', 0)
end
getgenv().NYX_KEY = nil
getgenv().NYX_HWID = nil

local LOADER_URL = "https://raw.githubusercontent.com/nyxv4/nyx1/main/downloader.lua" 
local _initArgs = ...
if type(_initArgs) ~= "table" then _initArgs = {} end

local args = _initArgs
local bootstrapCommit = type(args.Commit) == 'string' and args.Commit ~= '' and args.Commit or nil
if type(args) == "table" and args.Closet then
	getgenv().Closet = true
else
	if getgenv().Closet == nil then
		getgenv().Closet = true
	end
end

local vape
local loadstring = function(...)
	local res, err = loadstring(...)
	if err and vape then
		vape:CreateNotification('NYX', 'Failed to load : '..err, 30, 'alert')
	end
	return res
end
local queue_on_teleport = queue_on_teleport or queueonteleport or (syn and syn.queue_on_teleport) or (fluxus and fluxus.queue_on_teleport) or function() end
local clear_teleport_queue = clear_teleport_queue or clearteleportqueue or function() end
local isfile = isfile or function(file)
	local suc, res = pcall(function()
		return readfile(file)
	end)
	return suc and res ~= nil and res ~= ''
end
local delfile = delfile or function(file) writefile(file, '') end

for _, folder in {'NYX', 'NYX/games', 'NYX/profiles', 'NYX/assets', 'NYX/libraries', 'NYX/guis'} do
	if not isfolder(folder) then makefolder(folder) end
end

local UPDATE_CHECK_INTERVAL = 300
local function unixTime()
	local ok, t = pcall(function() return os.time() end)
	return ok and t or 0
end

local function checkForUpdates()
	local watermark = '--This watermark is used to delete the file if its cached, remove it to make the file persist after vape updates.'
	local current = isfile('NYX/profiles/commit.txt') and readfile('NYX/profiles/commit.txt') or ''
	local latest
	local lastCheck = tonumber(isfile('NYX/profiles/lastcheck.txt') and readfile('NYX/profiles/lastcheck.txt') or '') or 0
	local cachedLatest = isfile('NYX/profiles/latest.txt') and readfile('NYX/profiles/latest.txt') or ''
	local now = unixTime()
	if now - lastCheck < UPDATE_CHECK_INTERVAL and #cachedLatest == 40 and cachedLatest:match('^%x+$') then
		latest = cachedLatest
	else
		local ok, res = pcall(function()
			return game:HttpGet('https://api.github.com/repos/nyxv4/nyx1/commits/main', true)
		end)
		latest = ok and type(res) == 'string' and res:match('"sha"%s*:%s*"(%x+)"')
		if latest and #latest == 40 then
			pcall(writefile, 'NYX/profiles/latest.txt', latest)
			pcall(writefile, 'NYX/profiles/lastcheck.txt', tostring(now))
		end
	end
	if not latest or #latest ~= 40 then
		if current == '' then
			current = 'main'
			writefile('NYX/profiles/commit.txt', current)
		end
		return current
	end
	if latest == current then return latest end
	for _, folder in {'NYX', 'NYX/games', 'NYX/guis', 'NYX/libraries'} do
		for _, file in listfiles(folder) do
			if isfile(file) and readfile(file):sub(1, #watermark) == watermark then
				pcall(delfile, file)
			end
		end
	end
	writefile('NYX/profiles/commit.txt', latest)
	pcall(writefile, 'NYX/profiles/latest.txt', latest)
	return latest
end

local latestCommit = bootstrapCommit
if not shared.VapeDeveloper and not bootstrapCommit then
	local ok, res = pcall(checkForUpdates)
	if ok and res then latestCommit = res end
end

if bootstrapCommit and bootstrapCommit ~= '' then
	local pinned = bootstrapCommit
	local current = isfile('NYX/profiles/commit.txt') and readfile('NYX/profiles/commit.txt') or ''
	if current ~= pinned then
		local watermark = '--This watermark is used to delete the file if its cached, remove it to make the file persist after vape updates.'
		for _, folder in {'NYX/games', 'NYX/guis', 'NYX/libraries'} do
			for _, file in listfiles(folder) do
				if isfile(file) and readfile(file):sub(1, #watermark) == watermark then
					pcall(delfile, file)
				end
			end
		end
		writefile('NYX/profiles/commit.txt', pinned)
		latestCommit = pinned
	end
end
if bootstrapCommit and #bootstrapCommit == 40 then latestCommit = bootstrapCommit end

local function resolveBuildCommit()
	if type(latestCommit) == 'string' and latestCommit ~= '' then return latestCommit end
	local cached = isfile('NYX/profiles/latest.txt') and readfile('NYX/profiles/latest.txt') or ''
	if type(cached) == 'string' and #cached == 40 then return cached end
	return 'main'
end

local teleportExtras = {}
local function buildTeleportScript()
	if shared.VapeIndependent then return nil end

	local argParts = {}
	if type(latestCommit) == 'string' and #latestCommit == 40 then
		table.insert(argParts, 'Commit = "' .. latestCommit .. '"')
	end
	if getgenv().Closet then
		table.insert(argParts, 'Closet = true')
	end
	local args = #argParts > 0 and ('({' .. table.concat(argParts, ', ') .. '})') or '()'
	-- executors that append instead of replacing would otherwise load the hub once per queued copy
	local teleportScript = 'getgenv().NYX_KEY=[==[' .. NYX_KEY .. ']==];getgenv().NYX_HWID=[==[' .. NYX_HWID .. ']==];\nif shared.NYXTeleportLoad == game.JobId then return end\nshared.NYXTeleportLoad = game.JobId\nshared.vapereload = true\nloadstring(game:HttpGet("' .. LOADER_URL .. '", true), "loader")' .. args

	if identifyexecutor and ({identifyexecutor()})[1] == 'Potassium' then
		teleportScript = 'task.wait(12)\n' .. teleportScript
	end
	if shared.VapeDeveloper then
		teleportScript = 'shared.VapeDeveloper = true\n' .. teleportScript
	end
	if shared.VapeCustomProfile then
		teleportScript = 'shared.VapeCustomProfile = "' .. shared.VapeCustomProfile .. '"\n' .. teleportScript
	end
	if #teleportExtras > 0 then
		teleportScript = table.concat(teleportExtras, '\n') .. '\n' .. teleportScript
	end
	return teleportScript
end

local function queueTeleport()
	local teleportScript = buildTeleportScript()
	if not teleportScript then return end
	pcall(clear_teleport_queue)
	pcall(queue_on_teleport, teleportScript)
end

-- other scripts' queue_on_teleport calls replace the queue on most executors, so they go through here and ride along with the reinject
shared.NYXQueueTeleport = function(snippet)
	if type(snippet) ~= 'string' or snippet == '' then return end
	if shared.VapeIndependent then
		pcall(queue_on_teleport, snippet)
		return
	end
	table.insert(teleportExtras, snippet)
	queueTeleport()
end

queueTeleport()

if identifyexecutor and table.find({'Madium', 'Medium'}, ({identifyexecutor()})[1]) then
	local realgca = getcustomasset or getsynasset
	if realgca then
		getgenv().getcustomasset = function(path, ...)
			local args = {...}
			local function try()
				if not isfile(path) then return nil end
				local ok, res = pcall(function() return realgca(path, table.unpack(args)) end)
				if ok and res and res ~= '' then return res end
				return nil
			end
			local res = try()
			if res then return res end
			for _ = 1, 60 do
				task.wait(0.05)
				res = try()
				if res then return res end
			end
			return 'rbxassetid://0'
		end
	end
end
local cloneref = cloneref or function(obj)
	return obj
end
local playersService = cloneref(game:GetService('Players'))
local httpService = cloneref(game:GetService('HttpService'))
local teleportService = cloneref(game:GetService('TeleportService'))

local function downloadFile(path, func, forceRef)
	local cached = (isfile(path) and readfile(path)) or ''
	local commit = forceRef or (isfile('NYX/profiles/commit.txt') and readfile('NYX/profiles/commit.txt')) or 'main'
	if commit == '' then commit = 'main' end
	local watermark = '--This watermark is used to delete the file if its cached, remove it to make the file persist after vape updates.\n'
	local cachePrefix = #commit == 40 and commit:match('^%x+$') and (watermark..'--NYXCOMMIT:'..commit..'\n') or nil
	local current = cachePrefix and cached:sub(1, #cachePrefix) == cachePrefix
	if cached == '' or (forceRef and not current) then
		local res
		for attempt = 1, 3 do
			local suc, result = pcall(function()
				return game:HttpGet('https://raw.githubusercontent.com/nyxv4/nyx1/' .. commit .. '/' .. select(1, path:gsub('^NYX/', '')), true)
			end)
			if suc and type(result) == 'string' and #result > 0 and result ~= '404: Not Found' and not result:match('^%d%d%d:') and not result:match('^%s*<') then
				res = result
				break
			end
			if suc and result == '404: Not Found' then break end
			if attempt < 3 then task.wait(1) end
		end
		if not res then error('Failed to download ' .. path) end
		if path:find('%.lua') then res = (cachePrefix or watermark)..res end
		local dir = path:match('^(.*)/[^/]+$')
		if dir and not isfolder(dir) then makefolder(dir) end
		writefile(path, res)
		cached = res
	end
	if func then return func(path) end
	return cached
end

local function fetchFile(path, commit)
	local ok, res = pcall(downloadFile, path, nil, commit)
	if ok and type(res) == 'string' and res ~= '' then return res end
	if isfile(path) then return readfile(path) end
	return nil
end

local function migrateProfiles()
	if isfile('NYX/profiles/migrated_placeid.txt') then return end

	local oldId = tostring(game.GameId)
	local newId = tostring(game.PlaceId)

	if oldId == newId then
		pcall(writefile, 'NYX/profiles/migrated_placeid.txt', 'done')
		return
	end

	local suffix = oldId .. '.txt'
	for _, path in ipairs(listfiles('NYX/profiles')) do
		local name = path:gsub('\\', '/')
		if name:sub(-#suffix) == suffix then
			local newPath = name:sub(1, -#suffix - 1) .. newId .. '.txt'
			if not isfile(newPath) then
				pcall(function() writefile(newPath, readfile(path)) end)
			end
		end
	end

	if isfolder('NYX/profiles/premade') then
		for _, path in ipairs(listfiles('NYX/profiles/premade')) do
			local name = path:gsub('\\', '/')
			if name:sub(-#suffix) == suffix then
				local newPath = name:sub(1, -#suffix - 1) .. newId .. '.txt'
				if not isfile(newPath) then
					pcall(function() writefile(newPath, readfile(path)) end)
				end
			end
		end
	end

	pcall(writefile, 'NYX/profiles/migrated_placeid.txt', 'done')
end

pcall(migrateProfiles)

local function finishLoading()
	vape.Init = nil
	if not vape.Load then
		warn('[NYX] vape.Load is nil skipping load')
		return
	end
	vape:Load()
	vape:Clean(task.spawn(function()
		repeat
			pcall(vape.Save, vape)
			task.wait(10)
		until vape.Loaded == nil
	end))

	queueTeleport()

	vape:Clean(playersService.LocalPlayer.OnTeleport:Connect(function(state)
		if state == Enum.TeleportState.Failed then return end
		pcall(function() vape:Save() end)
		queueTeleport()
	end))

	vape:Clean(function()
		pcall(clear_teleport_queue)
	end)
end

if not isfile('NYX/profiles/gui.txt') then
	writefile('NYX/profiles/gui.txt', 'new')
end
local gui = readfile('NYX/profiles/gui.txt')

if not isfolder('NYX/assets/' .. gui) then
	makefolder('NYX/assets/' .. gui)
end

local guiPath = 'NYX/guis/' .. gui .. '.lua'
local buildCommit = resolveBuildCommit()
local gameFileId = (game.GameId == 2619619496) and (game.PlaceId == 6872265039 and 6872265039 or 6872274481) or (game.GameId == 10516888336 and 10516888336 or game.PlaceId)
local gamePath = 'NYX/games/' .. gameFileId .. '.lua'
local sourcePaths = {guiPath}
if not shared.VapeIndependent then
	table.insert(sourcePaths, 'NYX/libraries/hash.lua')
	table.insert(sourcePaths, 'NYX/libraries/prediction.lua')
	table.insert(sourcePaths, 'NYX/libraries/entity.lua')
	table.insert(sourcePaths, 'NYX/games/universal.lua')
	table.insert(sourcePaths, gamePath)
end

local sources = {}
for _, path in sourcePaths do
	local entry = {}
	sources[path] = entry
	task.spawn(function()
		entry.Ok, entry.Source = pcall(fetchFile, path, buildCommit)
		entry.Done = true
	end)
end

local function awaitSource(path)
	local entry = sources[path]
	if not entry then return end
	while not entry.Done do task.wait() end
	sources[path] = nil
	if entry.Ok then return entry.Source end
end

local guiSource = awaitSource(guiPath)
if not guiSource then
	error('[NYX] could not download ' .. guiPath .. ' and no cached copy exists')
end
local guiFunc, guiErr = loadstring(guiSource, 'gui')
if not guiFunc then
	local errMsg = tostring(guiErr)
	local lineNum = errMsg:match(':(%d+):')
	local context = ''
	if lineNum then
		local n = tonumber(lineNum)
		local lines = guiSource:split('\n')
		local from = math.max(1, n - 2)
		local to   = math.min(#lines, n + 2)
		local parts = {}
		for i = from, to do
			local marker = i == n and '>>> ' or '    '
			table.insert(parts, marker .. i .. ': ' .. (lines[i] or ''))
		end
		context = '\n\nContext:\n' .. table.concat(parts, '\n')
	end
	error('[NYX] syntax error in ' .. gui .. '.lua' .. '\n' .. errMsg .. context)
end
vape = guiFunc()
if type(vape) == 'table' and type(vape.Categories) ~= 'table' then
	local altSource = fetchFile('NYX/guis/new.lua', buildCommit)
	local altFunc = altSource and loadstring(altSource, 'gui')
	local altVape = altFunc and altFunc()
	if type(altVape) == 'table' and type(altVape.Categories) == 'table' and altVape.Load then
		warn('[NYX] selected GUI is incompatible, fell back to new')
		vape = altVape
	end
end
if not vape then
	error('[NYX] GUI returned nil file may be corrupted try deleting NYX/guis/' .. gui .. '.lua and reinjecting.')
end
if not vape.Load then
	if delfile then pcall(function() delfile('NYX/guis/' .. gui .. '.lua') end) end
	error('[NYX] gui file corrupted (missing load) reinject..')
end
if not vape.Init and not vape.Load then
	error('[NYX] failed to initialize properly reinject to fix this bs')
end

-- A cached or alternate GUI can come back without every category the game files
-- build modules into; create whatever is missing instead of losing those modules.
do
	local required = {'Combat', 'Blatant', 'Render', 'Utility', 'World', 'Kits', 'Inventory', 'Minigames', 'Legit'}
	if type(vape.Categories) == 'table' and type(vape.CreateCategory) == 'function' then
		for _, name in ipairs(required) do
			if not vape.Categories[name] then
				pcall(function()
					vape:CreateCategory({ Name = name, Size = UDim2.fromOffset(14, 14) })
				end)
			end
		end
	end
end

shared.vape = vape
task.wait(0.1)

if getgenv().Closet then
	local LogService = cloneref(game:GetService('LogService'))
	local originals = {}
	local function hook(funcName)
		if typeof(getgenv()[funcName]) == 'function' then
			local original = hookfunction(getgenv()[funcName], function() end)
			originals[funcName] = original
		end
	end
	hook('print')
	hook('warn')
	hook('error')
	hook('info')
	pcall(function() LogService:ClearOutput() end)
	local conn = LogService.MessageOut:Connect(function()
		LogService:ClearOutput()
	end)
	getgenv()._vape_log_connection = conn
	getgenv()._vape_originals = originals
end

if not shared.VapeIndependent then
	local universalSrc = awaitSource('NYX/games/universal.lua')
	if not universalSrc then
		error('[NYX] could not download universal.lua')
	end
	loadstring(universalSrc, 'universal')()
	local gameSrc = awaitSource(gamePath)

	if gameSrc then
		local gameFunc, gameErr = loadstring(gameSrc, tostring(gameFileId))
		if not gameFunc then
			local ls = gameSrc:split('\n')
			local msg = gameErr and tostring(gameErr) or 'executor didnt say why'
			local n = tonumber(msg:match(':(%d+):'))
			local where = ''
			if not n then
				local starts = {1}
				for i = 2, #ls do
					if ls[i]:match('^run%(function%(%)') then
						table.insert(starts, i)
					end
				end
				for idx, s in starts do
					local e = (starts[idx + 1] or (#ls + 1)) - 1
					if not loadstring(table.concat(ls, '\n', s, e), 'check') then
						local name
						for i = s, e do
							name = ls[i]:match("Name = '([^']+)'")
							if name then break end
						end
						where = '\nbroken part is lines ' .. s .. ' to ' .. e .. (name and ' in ' .. name or '')
						break
					end
				end
				if where == '' then
					where = '\ncouldnt find the broken part, prob a missing end between 2 modules'
				end
			end
			local ctx = ''
			if n then
				local parts = {}
				for i = math.max(1, n - 3), math.min(#ls, n + 3) do
					table.insert(parts, (i == n and '>>> ' or '    ') .. i .. ': ' .. (ls[i] or ''):gsub('\r', ''))
				end
				ctx = '\n\naround here:\n' .. table.concat(parts, '\n')
			end
			error('[NYX] syntax error in ' .. gameFileId .. '.lua\n' .. msg .. where .. ctx)
		end
		gameFunc(...)
	elseif isfile(gamePath) and readfile(gamePath) ~= '' then
		error('[NYX] could not load ' .. gameFileId .. '.lua')
	else
		warn('[NYX] no game file for ' .. tostring(gameFileId) .. ' - only universal modules loaded')
	end
	finishLoading()
else
	vape.Init = finishLoading
	return vape
end
