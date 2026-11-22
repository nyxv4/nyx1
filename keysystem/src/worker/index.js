const TIERS = Object.freeze({ lifetime: null, '7d': 7, '30d': 30, '90d': 90 });
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_PATTERN = /^NYX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_RESETS = 3;
const MAX_CREATE_AMOUNT = 100;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function loaderError(message) {
  // Keep the body plain text and successful at HTTP level so Roblox's HttpGet can
  // pass it into loadstring, where the loader's warn(e) displays the parse error.
  return new Response(`not authorized: ${message}`, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function recordKey(key) {
  return `key:${key}`;
}

function discordIndexKey(discordId) {
  return `discord:${discordId}`;
}

function normalizeKey(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function isExpired(record, now = Date.now()) {
  if (!record.expires) return false;
  const expiresAt = Date.parse(record.expires);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

async function readRecord(env, key) {
  const raw = await env.KEYS.get(recordKey(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(500, 'Stored key record is invalid.');
  }
}

async function writeRecord(env, record) {
  await env.KEYS.put(recordKey(record.key), JSON.stringify(record));
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
    return body;
  } catch {
    throw new ApiError(400, 'Expected a JSON object.');
  }
}

function sameSecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) return false;
  const left = new TextEncoder().encode(candidate);
  const right = new TextEncoder().encode(expected);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

function requireBotSecret(body, env) {
  if (!env.BOT_SECRET) throw new ApiError(503, 'Worker BOT_SECRET is not configured.');
  if (!sameSecret(body.secret, env.BOT_SECRET)) throw new ApiError(401, 'Unauthorized.');
}

function requireDiscordId(value) {
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
    throw new ApiError(400, 'A valid Discord user ID is required.');
  }
  return value;
}

function requireKey(value) {
  const key = normalizeKey(value);
  if (!KEY_PATTERN.test(key)) throw new ApiError(400, 'Key format must be NYX-XXXX-XXXX-XXXX.');
  return key;
}

function expirationFor(tier, now = Date.now()) {
  const days = TIERS[tier];
  return days === null ? null : new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

async function makeUniqueKey(env) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      chunks.push(Array.from(bytes.subarray(offset, offset + 4), (byte) => KEY_ALPHABET[byte % KEY_ALPHABET.length]).join(''));
    }
    const key = `NYX-${chunks.join('-')}`;
    if (!(await env.KEYS.get(recordKey(key)))) return key;
  }
  throw new ApiError(503, 'Could not allocate a unique key. Try again.');
}

async function createKeys(body, env) {
  requireBotSecret(body, env);
  const amount = Number(body.amount);
  const tier = body.tier;
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CREATE_AMOUNT) {
    throw new ApiError(400, `amount must be an integer from 1 to ${MAX_CREATE_AMOUNT}.`);
  }
  if (!Object.hasOwn(TIERS, tier)) throw new ApiError(400, 'tier must be lifetime, 7d, 30d, or 90d.');

  const keys = [];
  const created = new Date().toISOString();
  for (let i = 0; i < amount; i += 1) {
    const key = await makeUniqueKey(env);
    const record = {
      key,
      status: 'unused',
      discord_id: null,
      hwid: null,
      resets: 0,
      created,
      expires: null,
      tier,
    };
    await writeRecord(env, record);
    keys.push(key);
  }
  return json({ ok: true, keys, tier });
}

async function redeem(body, env) {
  requireBotSecret(body, env);
  const key = requireKey(body.key);
  const discordId = requireDiscordId(body.discord_id);
  const record = await readRecord(env, key);
  if (!record) throw new ApiError(404, 'Key not found.');
  if (record.status === 'banned') throw new ApiError(403, 'This key is banned.');
  if (isExpired(record)) throw new ApiError(403, 'This key has expired.');

  if (record.discord_id === discordId && ['redeemed', 'active'].includes(record.status)) {
    return json({ ok: true, already_redeemed: true, key: record });
  }
  if (record.status !== 'unused') throw new ApiError(409, 'This key is already linked to another Discord account.');

  const existingKey = await env.KEYS.get(discordIndexKey(discordId));
  if (existingKey && existingKey !== key) {
    const existingRecord = await readRecord(env, existingKey);
    if (existingRecord && existingRecord.status !== 'banned' && !isExpired(existingRecord)) {
      throw new ApiError(409, 'Your Discord account already has an unexpired key.');
    }
  }

  record.status = 'redeemed';
  record.discord_id = discordId;
  record.expires = expirationFor(record.tier);
  await writeRecord(env, record);
  await env.KEYS.put(discordIndexKey(discordId), key);
  return json({ ok: true, already_redeemed: false, key: record });
}

async function discordKey(body, env) {
  requireBotSecret(body, env);
  const discordId = requireDiscordId(body.discord_id);
  const key = await env.KEYS.get(discordIndexKey(discordId));
  if (!key) return json({ ok: true, found: false });
  const record = await readRecord(env, key);
  if (!record) return json({ ok: true, found: false });
  return json({ ok: true, found: true, key: record });
}

async function keyInfo(body, env) {
  requireBotSecret(body, env);
  const key = requireKey(body.key);
  const record = await readRecord(env, key);
  return json({ ok: true, found: Boolean(record), ...(record ? { key: record } : {}) });
}

async function revoke(body, env) {
  requireBotSecret(body, env);
  const discordId = requireDiscordId(body.discord_id);
  const key = await env.KEYS.get(discordIndexKey(discordId));
  if (!key) return json({ ok: true, found: false });
  const record = await readRecord(env, key);
  if (record) {
    record.status = 'banned';
    await writeRecord(env, record);
  }
  await env.KEYS.delete(discordIndexKey(discordId));
  return json({ ok: true, found: true, key: record ? record.key : null });
}

async function resetHwid(body, env) {
  requireBotSecret(body, env);
  const discordId = requireDiscordId(body.discord_id);
  const key = await env.KEYS.get(discordIndexKey(discordId));
  if (!key) throw new ApiError(404, 'No key is linked to that Discord account.');
  const record = await readRecord(env, key);
  if (!record) throw new ApiError(404, 'No key is linked to that Discord account.');
  if (record.status === 'banned') throw new ApiError(403, 'This key is banned.');
  if (isExpired(record)) throw new ApiError(403, 'This key has expired.');
  if (!record.hwid) throw new ApiError(409, 'No HWID is currently bound to this key.');
  if (record.resets >= MAX_RESETS) throw new ApiError(403, 'The maximum of 3 HWID resets has been used.');

  record.hwid = null;
  record.status = 'redeemed';
  record.resets += 1;
  await writeRecord(env, record);
  return json({ ok: true, key: record });
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getScript(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!env.GETSCRIPT_RATE_LIMITER) return loaderError('service is unavailable');
  try {
    const limit = await env.GETSCRIPT_RATE_LIMITER.limit({ key: await sha256Hex(ip) });
    if (!limit.success) return loaderError('too many attempts; wait a minute and retry');
  } catch {
    return loaderError('authorization service is unavailable');
  }

  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get('key'));
  const hwid = (url.searchParams.get('hwid') || '').trim();
  if (!KEY_PATTERN.test(key) || hwid.length < 8 || hwid.length > 256) {
    return loaderError('invalid key or HWID');
  }

  let record;
  try {
    record = await readRecord(env, key);
  } catch {
    return loaderError('authorization service is unavailable');
  }
  if (!record || record.status === 'unused' || record.status === 'banned' || isExpired(record)) {
    return loaderError('invalid or expired key');
  }
  if (!['redeemed', 'active'].includes(record.status)) return loaderError('invalid key status');
  if (!record.discord_id) return loaderError('key has not been redeemed');

  if (record.hwid && record.hwid !== hwid) return loaderError('HWID mismatch');
  let needsWrite = false;
  if (!record.hwid) {
    record.hwid = hwid;
    record.status = 'active';
    needsWrite = true;
  }
  if (!record.injected_at) {
    record.injected_at = new Date().toISOString();
    needsWrite = true;
  }
  if (needsWrite) {
    try {
      await writeRecord(env, record);
    } catch {
      return loaderError('could not bind this HWID; retry');
    }
  }

  const sourceUrl = env.SCRIPT_SOURCE_URL || 'https://raw.githubusercontent.com/nyxv4/nyx1/main/downloader.lua';
  let upstream;
  try {
    upstream = await fetch(sourceUrl, { headers: { accept: 'text/plain' } });
  } catch {
    return loaderError('script source is temporarily unavailable');
  }
  if (!upstream.ok) return loaderError('script source is temporarily unavailable');

  let source;
  try {
    source = await upstream.text();
  } catch {
    return loaderError('script source is temporarily unavailable');
  }
  if (!source.trim()) return loaderError('script source is empty');
  return new Response(source, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function handleApi(request, env, path) {
  if (request.method !== 'POST') throw new ApiError(405, 'Method not allowed.');
  const body = await readJson(request);
  switch (path) {
    case '/api/redeem': return redeem(body, env);
    case '/api/admin/createkeys': return createKeys(body, env);
    case '/api/admin/revoke': return revoke(body, env);
    case '/api/admin/resethwid': return resetHwid(body, env);
    case '/api/admin/discordkey': return discordKey(body, env);
    case '/api/admin/keyinfo': return keyInfo(body, env);
    default: throw new ApiError(404, 'Not found.');
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/' && request.method === 'GET') {
      return json({ ok: true, service: 'NYX key system' });
    }
    if (pathname === '/getscript' && request.method === 'GET') {
      return getScript(request, env);
    }
    if (pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, pathname);
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500;
        const message = error instanceof ApiError ? error.message : 'Internal server error.';
        return json({ ok: false, error: message }, status);
      }
    }
    return json({ ok: false, error: 'Not found.' }, 404);
  },
};
