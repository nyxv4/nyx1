getgenv().script_key = "NYX-7F3K-9Q2M-XT5P"

local hwid = nil
if gethwid then
	local ok, v = pcall(gethwid)
	if ok and type(v) == "string" then hwid = v end
end
if not hwid then
	local ok, v = pcall(function()
		return game:GetService("RbxAnalyticsService"):GetClientId()
	end)
	if ok and type(v) == "string" then hwid = v end
end
if not hwid then hwid = "unknown" end
if crypt and crypt.hash then
	local ok, h = pcall(crypt.hash, hwid, "sha256")
	if ok and type(h) == "string" then hwid = h end
end

local f, e = loadstring(game:HttpGet("https://nyx-keysystem.yourname.workers.dev/getscript?key=NYX-7F3K-9Q2M-XT5P&hwid=" .. tostring(hwid)))
if f then f() else warn(e) end
