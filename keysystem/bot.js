// NYX Keysystem - Discord bot
// Requires: discord.js v14
// Env vars: DISCORD_TOKEN, WORKER_URL, BOT_SECRET, ADMIN_IDS (comma-separated Discord user IDs)

const {
	Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const BOT_SECRET = process.env.BOT_SECRET;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!DISCORD_TOKEN || !WORKER_URL || !BOT_SECRET) {
	console.error('Missing env vars: DISCORD_TOKEN, WORKER_URL, BOT_SECRET');
	process.exit(1);
}

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.DirectMessages,
	],
});

async function api(path, body) {
	const res = await fetch(WORKER_URL + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, secret: BOT_SECRET }),
	});
	return res.json();
}

function isAdmin(userId) {
	return ADMIN_IDS.includes(String(userId));
}

// Loader sent to buyers via /getscript. __WORKER_URL__ is replaced at send time.
const LOADER_LUA = `-- NYX Loader - requires a valid key
local WORKER = "__WORKER_URL__"

local function getKey()
	if getsenv then
		local ok, v = pcall(getsenv, "NYX_KEY")
		if ok and type(v) == "string" and #v > 0 then return v end
	end
	if readfile then
		local ok, v = pcall(readfile, "nyx_key.txt")
		if ok and type(v) == "string" and #v > 0 then return v:match("[^%s]+") end
	end
	if shared and shared.NYX_KEY then return shared.NYX_KEY end
	return nil
end

local key = getKey()
if not key then
	warn("[NYX] No key found. Set NYX_KEY env var, put your key in nyx_key.txt, or set shared.NYX_KEY")
	return
end

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

-- hash hwid if the executor supports it
if crypt and crypt.hash then
	local ok, h = pcall(crypt.hash, hwid, "sha256")
	if ok and type(h) == "string" then hwid = h end
elseif sha256 then
	local ok, h = pcall(sha256, hwid)
	if ok and type(h) == "string" then hwid = h end
end

local function httpPost(url, body)
	local http = (syn and syn.request) or http_request or request or http
	if not http then return nil end
	local payload = '{"key":"' .. key:gsub('"', '') .. '","hwid":"' .. tostring(hwid):gsub('"', '') .. '"}'
	local ok, res = pcall(http, {
		Url = url,
		Method = "POST",
		Headers = { ["Content-Type"] = "application/json" },
		Body = payload,
	})
	if not ok or not res then return nil end
	return res.Body and game:GetService("HttpService"):JSONDecode(res.Body) or nil
end

local auth = httpPost(WORKER .. "/api/auth", { key = key, hwid = hwid })
if not auth or not auth.ok then
	warn("[NYX] Auth failed: " .. tostring(auth and auth.error or "no response"))
	return
end

loadstring(game:HttpGet(auth.url))()
`;

const commands = [
	new SlashCommandBuilder().setName('createkeys').setDescription('Generate keys (admin)')
		.addIntegerOption(o => o.setName('amount').setDescription('How many keys').setRequired(true).setMinValue(1).setMaxValue(100))
		.addStringOption(o => o.setName('tier').setDescription('Key tier').setRequired(false)
			.addChoices(
				{ name: 'Lifetime', value: 'lifetime' },
				{ name: '7 days', value: '7d' },
				{ name: '30 days', value: '30d' },
				{ name: '90 days', value: '90d' },
			)),
	new SlashCommandBuilder().setName('redeem').setDescription('Redeem a key to your account')
		.addStringOption(o => o.setName('key').setDescription('Your key').setRequired(true)),
	new SlashCommandBuilder().setName('mykey').setDescription('Show your key status'),
	new SlashCommandBuilder().setName('getscript').setDescription('DM yourself the NYX loader'),
	new SlashCommandBuilder().setName('resethwid').setDescription('Reset your HWID (max 3 times)'),
	new SlashCommandBuilder().setName('keyinfo').setDescription('Look up a key (admin)')
		.addStringOption(o => o.setName('key').setDescription('The key').setRequired(true)),
];

client.once('ready', async () => {
	console.log(`Logged in as ${client.user.tag}`);
	const rest = new REST().setToken(DISCORD_TOKEN);
	await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
	console.log('Slash commands registered');
});

client.on('interactionCreate', async interaction => {
	if (!interaction.isChatInputCommand()) return;
	const { commandName, user } = interaction;

	try {
		switch (commandName) {
			case 'createkeys': {
				if (!isAdmin(user.id)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
				const amount = interaction.options.getInteger('amount');
				const tier = interaction.options.getString('tier') || 'lifetime';
				await interaction.deferReply({ ephemeral: true });
				const res = await api('/api/admin/createkeys', { amount, tier });
				if (!res.ok) return interaction.editReply('Failed to create keys.');
				const text = res.keys.join('\n');
				// keys can exceed message limit - split
				const chunks = text.match(/.{1,1900}/gs) || [text];
				for (const chunk of chunks) {
					await interaction.followUp({ content: '```\n' + chunk + '\n```', ephemeral: true });
				}
				break;
			}

			case 'redeem': {
				const key = interaction.options.getString('key').toUpperCase();
				await interaction.deferReply({ ephemeral: true });
				const res = await api('/api/admin/redeem', { key, discord_id: user.id });
				if (res.ok) {
					return interaction.editReply('Key redeemed! Run `/getscript` to get your loader.');
				}
				const msgs = {
					key_not_found: 'That key does not exist.',
					key_banned: 'That key is banned.',
					key_already_redeemed: 'That key is already redeemed by someone else.',
				};
				return interaction.editReply(msgs[res.error] || 'Redeem failed: ' + res.error);
			}

			case 'mykey': {
				await interaction.deferReply({ ephemeral: true });
				const res = await api('/api/admin/discordkey', { discord_id: user.id });
				if (!res.ok || !res.key) return interaction.editReply('You have no redeemed key. Use `/redeem` first.');
				const status = res.expired ? 'EXPIRED' : res.status.toUpperCase();
				return interaction.editReply(
					`**Your key:** \`${res.key}\`\n**Status:** ${status}\n**HWID bound:** ${res.hwid_bound ? 'yes' : 'no'}\n**HWID resets left:** ${Math.max(0, 3 - res.resets)}`
				);
			}

			case 'getscript': {
				await interaction.deferReply({ ephemeral: true });
				const res = await api('/api/admin/discordkey', { discord_id: user.id });
				if (!res.ok || !res.key || res.status === 'unused' || res.expired) {
					return interaction.editReply('You need a redeemed, unexpired key first. Use `/redeem`.');
				}
				const loader = LOADER_LUA.replace('__WORKER_URL__', WORKER_URL);
				try {
					await user.send({
						content: 'Here is your NYX loader. Save it as `loader.lua` and run it in your executor.',
						files: [{ attachment: Buffer.from(loader), name: 'nyx_loader.lua' }],
					});
					return interaction.editReply('Check your DMs for the loader.');
				} catch {
					return interaction.editReply('I could not DM you - enable DMs from server members and try again.');
				}
			}

			case 'resethwid': {
				await interaction.deferReply({ ephemeral: true });
				const res = await api('/api/admin/resethwid', { discord_id: user.id });
				if (res.ok) {
					return interaction.editReply(`HWID reset! ${res.resets_left} reset(s) remaining. Run your loader again to bind the new device.`);
				}
				if (res.error === 'reset_limit') return interaction.editReply('Reset limit reached. Contact an admin.');
				return interaction.editReply('No key found for your account.');
			}

			case 'keyinfo': {
				if (!isAdmin(user.id)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
				const key = interaction.options.getString('key').toUpperCase();
				await interaction.deferReply({ ephemeral: true });
				const res = await api('/api/admin/keyinfo', { key });
				if (!res.ok) return interaction.editReply('Key not found.');
				return interaction.editReply([
					`**Key:** \`${res.key}\``,
					`**Status:** ${res.status}${res.expired ? ' (expired)' : ''}`,
					`**Tier:** ${res.tier}`,
					`**Discord ID:** ${res.discord_id || 'none'}`,
					`**HWID bound:** ${res.hwid ? 'yes' : 'no'}`,
					`**Resets used:** ${res.resets}/3`,
					`**Created:** ${new Date(res.created).toISOString()}`,
				].join('\n'));
			}
		}
	} catch (e) {
		console.error(e);
		const msg = 'Something went wrong.';
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply(msg).catch(() => {});
		} else {
			await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
		}
	}
});

client.login(DISCORD_TOKEN);
