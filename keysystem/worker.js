// NYX Keysystem - Cloudflare Worker
// KV namespace "KEYS" stores:
//   key:<KEY>    -> {key, status, discord_id, hwid, resets, created, expires, tier}
//   user:<discord_id> -> <KEY>
//   fail:<ip>    -> failed auth attempts (rate limit)

const TIERS = {
	lifetime: null,
	'7d': 7,
	'30d': 30,
	'90d': 90,
};

const MAX_RESETS = 3;
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW = 600; // seconds

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function readBody(request) {
	try {
		return await request.json();
	} catch {
		return {};
	}
}

function genKey() {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < 16; i++) {
		out += chars[bytes[i] % chars.length];
		if (i === 3 || i === 7 || i === 11) out += '-';
	}
	return 'NYX-' + out;
}

async function getKey(env, key) {
	const raw = await env.KEYS.get('key:' + key);
	return raw ? JSON.parse(raw) : null;
}

async function putKey(env, record) {
	await env.KEYS.put('key:' + record.key, JSON.stringify(record));
	if (record.discord_id) {
		await env.KEYS.put('user:' + record.discord_id, record.key);
	}
}

function isExpired(record) {
	return record.expires && Date.now() > record.expires;
}

function checkSecret(env, body) {
	return body.secret && body.secret === env.BOT_SECRET;
}

async function handleAdminCreate(env, body) {
	if (!checkSecret(env, body)) return json({ ok: false, error: 'unauthorized' }, 401);
	const amount = Math.min(Math.max(parseInt(body.amount) || 1, 1), 100);
	const tier = TIERS[body.tier] !== undefined ? body.tier : 'lifetime';
	const days = TIERS[tier];
	const keys = [];
	for (let i = 0; i < amount; i++) {
		const key = genKey();
		const record = {
			key,
			status: 'unused',
			discord_id: null,
			hwid: null,
			resets: 0,
			created: Date.now(),
			expires: days ? Date.now() + days * 86400000 : null,
			tier,
		};
		await putKey(env, record);
		keys.push(key);
	}
	return json({ ok: true, keys });
}

async function handleAdminRedeem(env, body) {
	if (!checkSecret(env, body)) return json({ ok: false, error: 'unauthorized' }, 401);
	const record = await getKey(env, (body.key || '').toUpperCase());
	if (!record) return json({ ok: false, error: 'key_not_found' }, 404);
	if (record.status === 'banned') return json({ ok: false, error: 'key_banned' }, 403);
	if (record.status === 'redeemed' || record.status === 'active') {
		if (record.discord_id === String(body.discord_id)) {
			return json({ ok: true, already: true });
		}
		return json({ ok: false, error: 'key_already_redeemed' }, 409);
	}
	record.status = 'redeemed';
	record.discord_id = String(body.discord_id);
	await putKey(env, record);
	return json({ ok: true });
}

async function handleAdminResetHwid(env, body) {
	if (!checkSecret(env, body)) return json({ ok: false, error: 'unauthorized' }, 401);
	let record = null;
	if (body.discord_id) {
		const key = await env.KEYS.get('user:' + String(body.discord_id));
		if (key) record = await getKey(env, key);
	} else if (body.key) {
		record = await getKey(env, body.key.toUpperCase());
	}
	if (!record) return json({ ok: false, error: 'key_not_found' }, 404);
	if ((record.resets || 0) >= MAX_RESETS) {
		return json({ ok: false, error: 'reset_limit', resets: record.resets }, 429);
	}
	record.hwid = null;
	record.resets = (record.resets || 0) + 1;
	record.status = record.status === 'active' ? 'redeemed' : record.status;
	await putKey(env, record);
	return json({ ok: true, resets_left: MAX_RESETS - record.resets });
}

async function handleAdminDiscordKey(env, body) {
	if (!checkSecret(env, body)) return json({ ok: false, error: 'unauthorized' }, 401);
	const key = await env.KEYS.get('user:' + String(body.discord_id));
	if (!key) return json({ ok: true, key: null });
	const record = await getKey(env, key);
	if (!record) return json({ ok: true, key: null });
	return json({
		ok: true,
		key: record.key,
		status: record.status,
		hwid_bound: !!record.hwid,
		resets: record.resets || 0,
		expires: record.expires,
		expired: isExpired(record),
	});
}

async function handleAdminKeyInfo(env, body) {
	if (!checkSecret(env, body)) return json({ ok: false, error: 'unauthorized' }, 401);
	const record = await getKey(env, (body.key || '').toUpperCase());
	if (!record) return json({ ok: false, error: 'key_not_found' }, 404);
	const { secret, ...safe } = record;
	return json({ ok: true, ...safe, expired: isExpired(record) });
}

// GET /getscript?key=...&hwid=... -> validates key+HWID then returns the
// script source as plain text so loadstring() can run it. Errors are
// returned as warn("...") Lua so the loader's `if f then f() else warn(e)`
// always shows a readable message.
function luaWarn(msg) {
	return 'warn(' + JSON.stringify(msg) + ')';
}

async function handleGetScript(env, url, request) {
	const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
	const failKey = 'fail:' + ip;
	const fails = parseInt((await env.KEYS.get(failKey)) || '0');
	if (fails >= AUTH_FAIL_LIMIT) {
		return new Response(luaWarn('NYX: too many attempts, try later'), { headers: { 'Content-Type': 'text/plain' } });
	}

	const fail = async (msg) => {
		await env.KEYS.put(failKey, String(fails + 1), { expirationTtl: AUTH_FAIL_WINDOW });
		return new Response(luaWarn(msg), { headers: { 'Content-Type': 'text/plain' } });
	};

	const record = await getKey(env, (url.searchParams.get('key') || '').toUpperCase());
	const hwid = url.searchParams.get('hwid') || '';

	if (!record) return fail('NYX: invalid key');
	if (isExpired(record)) return fail('NYX: key expired');
	if (record.status === 'banned') return fail('NYX: key banned');
	if (record.status !== 'redeemed' && record.status !== 'active') return fail('NYX: key not redeemed');

	// HWID binding - only enforced when the loader sends a hwid param
	if (hwid) {
		if (!record.hwid) {
			record.hwid = hwid;
			record.status = 'active';
			await putKey(env, record);
		} else if (record.hwid !== hwid) {
			return new Response(luaWarn('NYX: HWID mismatch - run /resethwid in Discord'), { headers: { 'Content-Type': 'text/plain' } });
		}
	}

	if (fails > 0) await env.KEYS.delete(failKey);

	const upstream = await fetch(env.SCRIPT_URL);
	const source = await upstream.text();
	return new Response(source, { headers: { 'Content-Type': 'text/plain' } });
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === 'GET' && path === '/getscript') {
			return handleGetScript(env, url, request);
		}
		if (request.method !== 'POST') return json({ ok: false, error: 'not_found' }, 404);

		const body = await readBody(request);
		switch (path) {
			case '/api/admin/createkeys': return handleAdminCreate(env, body);
			case '/api/admin/redeem': return handleAdminRedeem(env, body);
			case '/api/admin/resethwid': return handleAdminResetHwid(env, body);
			case '/api/admin/discordkey': return handleAdminDiscordKey(env, body);
			case '/api/admin/keyinfo': return handleAdminKeyInfo(env, body);
			default: return json({ ok: false, error: 'not_found' }, 404);
		}
	},
};
