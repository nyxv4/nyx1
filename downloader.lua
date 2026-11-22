local NYX_KEY = getgenv and getgenv().NYX_KEY or nil
local NYX_HWID = getgenv and getgenv().NYX_HWID or nil
if type(NYX_KEY) ~= 'string' or type(NYX_HWID) ~= 'string' then
	error('NYX requires a valid key. Get your loader from the Discord server.', 0)
end
local authOk = false
for _ = 1, 3 do
	local suc, res = pcall(function()
		return game:HttpGet('https://script-whitelist.nyx178bedwars.workers.dev/api/verify?key=' .. NYX_KEY .. '&hwid=' .. NYX_HWID, true)
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
pcall(function()
	local executor = 'unknown'
	pcall(function() executor = getexecutorname() or executor end)
	local username = 'unknown'
	pcall(function() username = game:GetService('Players').LocalPlayer.Name end)
	local device = 'unknown'
	pcall(function()
		local uis = game:GetService('UserInputService')
		if uis.GamepadEnabled and not uis.KeyboardEnabled then device = 'Console'
		elseif uis.TouchEnabled and not uis.KeyboardEnabled then device = 'Mobile'
		else device = 'PC' end
	end)
	local fps = 'unknown'
	pcall(function() fps = tostring(math.floor(workspace:GetRealPhysicsFPS())) end)
	local clean = function(s) return tostring(s):gsub('[%c"\\]', '') end
	local body = '{"key":"' .. NYX_KEY .. '","hwid":"' .. NYX_HWID
		.. '","executor":"' .. clean(executor)
		.. '","username":"' .. clean(username)
		.. '","place_id":"' .. tostring(game.PlaceId)
		.. '","game_name":"' .. clean(game.Name)
		.. '","device":"' .. device
		.. '","fps":"' .. fps .. '"}'
	game:HttpPost('https://script-whitelist.nyx178bedwars.workers.dev/api/telemetry', body, 'application/json')
end)
getgenv().NYX_KEY = nil
getgenv().NYX_HWID = nil

local _args = ...
if type(_args) ~= "table" then _args = {} end
local pinnedCommit = type(_args.Commit) == 'string' and _args.Commit ~= '' and _args.Commit or nil

local isfile = isfile or function(file)
	local suc, res = pcall(function() return readfile(file) end)
	return suc and res ~= nil and res ~= ''
end
local delfile = delfile or function(file) writefile(file, '') end

local UPDATE_CHECK_INTERVAL = 300
local function unixTime()
	local ok, t = pcall(function() return os.time() end)
	return ok and t or 0
end

local function downloadFile(path, func, forceRef)
	local cached = (isfile(path) and readfile(path)) or ''
	local ref = forceRef or (isfile('NYX/profiles/commit.txt') and readfile('NYX/profiles/commit.txt')) or 'main'
	if ref == '' then ref = 'main' end
	local watermark = '--This watermark is used to delete the file if its cached, remove it to make the file persist after vape updates.\n'
	local cachePrefix = #ref == 40 and ref:match('^%x+$') and (watermark..'--NYXCOMMIT:'..ref..'\n') or nil
	local current = cachePrefix and cached:sub(1, #cachePrefix) == cachePrefix
	if cached == '' or (forceRef and not current) then
		local res
		for attempt = 1, 3 do
			local suc, result = pcall(function()
				return game:HttpGet('https://raw.githubusercontent.com/nyxv4/nyx1/'..ref..'/'..select(1, path:gsub('^NYX/', '')), true)
			end)
			if suc and type(result) == 'string' and #result > 0 and result ~= '404: Not Found' and not result:match('^%d%d%d:') and not result:match('^%s*<') then
				res = result
				break
			end
			if suc and result == '404: Not Found' then break end
			if attempt < 3 then task.wait(0.5) end
		end
		if res then
			if path:find('%.lua') then res = (cachePrefix or watermark)..res end
			local dir = path:match('^(.*)/[^/]+$')
			if dir and not isfolder(dir) then makefolder(dir) end
			writefile(path, res)
			cached = res
		elseif cached == '' then
			error('Could not download '..path..' (GitHub unreachable)')
		end
	end
	if func then return func(path) end
	return cached
end

local function wipeFolder(path)
	if not isfolder(path) then return end
	for _, file in listfiles(path) do
		if file:find('loader') then continue end
		if isfile(file) and select(1, readfile(file):find('--This watermark is used to delete the file if its cached, remove it to make the file persist after vape updates.')) == 1 then
			delfile(file)
		end
	end
end

for _, folder in {'NYX', 'NYX/games', 'NYX/profiles', 'NYX/assets', 'NYX/libraries', 'NYX/guis'} do
	if not isfolder(folder) then makefolder(folder) end
end

if not isfile('NYX/profiles/commit.txt') then
	writefile('NYX/profiles/commit.txt', 'main')
end

local function downloadPremadeProfiles(commit)
	local httpService = game:GetService('HttpService')
	if isfolder('NYX/profiles/premade') then
		for _, file in listfiles('NYX/profiles/premade') do
			pcall(function() if isfile(file) then delfile(file) end end)
		end
	else
		makefolder('NYX/profiles/premade')
	end
	local success, response = pcall(function()
		return game:HttpGet('https://api.github.com/repos/nyxv4/nyx1/contents/profiles/premade?ref=' .. commit)
	end)
	if success and response then
		local ok, files = pcall(function() return httpService:JSONDecode(response) end)
		if ok and type(files) == 'table' and response:match('^%s*%[') then
			local targets = {}
			for _, file in pairs(files) do
				if type(file) == 'table' and type(file.name) == 'string' and file.name:match('%.txt$') and file.name ~= 'commit.txt' then
					local baseName = (file.name:match('^(.-)%.txt$') or file.name):gsub('%d+$', '')
					local fileId = (game.GameId == 2619619496) and game.GameId or game.PlaceId
					table.insert(targets, {
						url = file.download_url,
						path = 'NYX/profiles/premade/' .. baseName .. tostring(fileId) .. '.txt',
					})
				end
			end
			local pending = #targets
			local complete = true
			for _, target in ipairs(targets) do
				task.spawn(function()
					local ds, dc = pcall(function() return game:HttpGet(target.url, true) end)
					if ds and type(dc) == 'string' and #dc > 0 and dc ~= '404: Not Found' and not dc:match('^%d%d%d:') and not dc:match('^%s*<') then
						writefile(target.path, dc)
					else
						complete = false
					end
					pending = pending - 1
				end)
			end
			while pending > 0 do task.wait() end
			if complete then writefile('NYX/profiles/premade/commit.txt', commit) end
		end
	end
end

local commit
local forceRef = pinnedCommit or 'main'
if not shared.VapeDeveloper then
	local oldCommit = readfile('NYX/profiles/commit.txt')
	commit = pinnedCommit or oldCommit
	if not pinnedCommit then
		local latest = isfile('NYX/profiles/latest.txt') and readfile('NYX/profiles/latest.txt') or ''
		local lastCheck = tonumber(isfile('NYX/profiles/lastcheck.txt') and readfile('NYX/profiles/lastcheck.txt') or '') or 0
		local now = unixTime()
		local h
		if now - lastCheck < UPDATE_CHECK_INTERVAL and #latest == 40 and latest:match('^%x+$') then
			h = latest
		else
			local ok, res = pcall(function()
				return game:HttpGet('https://api.github.com/repos/nyxv4/nyx1/commits/main', true)
			end)
			h = ok and type(res) == 'string' and res:match('"sha"%s*:%s*"(%x+)"')
			if h and #h == 40 then
				pcall(writefile, 'NYX/profiles/latest.txt', h)
				pcall(writefile, 'NYX/profiles/lastcheck.txt', tostring(now))
			end
		end
		if h and #h == 40 then
			commit = h
		elseif #latest == 40 then
			commit = latest
		elseif #commit ~= 40 then
			commit = 'main'
		end
	end
	forceRef = commit
	if oldCommit ~= commit then
		local pending = 0
		for _, folder in {'NYX', 'NYX/games', 'NYX/guis', 'NYX/libraries'} do
			pending = pending + 1
			task.spawn(function()
				pcall(wipeFolder, folder)
				pending = pending - 1
			end)
		end
		pcall(function() if isfile('NYX/guis/new.lua') then delfile('NYX/guis/new.lua') end end)
		while pending > 0 do task.wait() end
	end
	writefile('NYX/profiles/commit.txt', commit)
	local premadeCommit = isfile('NYX/profiles/premade/commit.txt') and readfile('NYX/profiles/premade/commit.txt') or ''
	local needPremade = #commit ~= 40 or not commit:match('^%x+$') or oldCommit ~= commit or premadeCommit ~= commit
	if needPremade then
		task.spawn(function() pcall(downloadPremadeProfiles, commit) end)
	end
end

return loadstring(downloadFile('NYX/main.lua', nil, forceRef), 'main')({
	Closet = _args.Closet,
	Commit = forceRef,
})
