# NYX Keysystem Setup Guide

Complete step-by-step. You need: a Discord server (you have one), a Cloudflare account (you have one), Node.js installed, and ~20 minutes.

---

## PART 1 — Discord Bot (~10 min)

### 1.1 Create the application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it `NYX` (or anything) → Create
3. In the left sidebar click **Bot**
4. Click **Reset Token** → copy the token → save it somewhere safe (this is `DISCORD_TOKEN`)

### 1.2 Enable intents

Still on the **Bot** page, scroll to **Privileged Gateway Intents** and enable:
- ✅ **Server Members Intent**
- ✅ **Message Content Intent** (not strictly needed but harmless)

### 1.3 Invite the bot to your server

1. Left sidebar → **OAuth2** → **OAuth2 URL Generator**
2. Under **Scopes** check: `bot`
3. Under **Bot Permissions** check: `Send Messages`, `Embed Links`, `Attach Files`, `Use External Emojis` (optional)
4. Copy the generated URL at the bottom, open it in your browser
5. Select your server → Authorize

### 1.4 Get your Discord user ID

1. In Discord, enable Developer Mode: User Settings → Advanced → Developer Mode ON
2. Right-click your own profile → **Copy User ID**
3. Save it (this goes in `ADMIN_IDS`)

---

## PART 2 — Cloudflare Worker (~10 min)

### 2.1 Install wrangler

Open a terminal/PowerShell:

```
npm install -g wrangler
wrangler login
```

A browser window opens — log in with your Cloudflare account and authorize.

### 2.2 Create the KV database

```
cd keysystem
wrangler kv namespace create KEYS
```

Copy the `id` it prints (looks like `abc123...`) and paste it into `wrangler.toml` where it says `PASTE_KV_NAMESPACE_ID_HERE`.

### 2.3 Set config values

```
wrangler secret put BOT_SECRET
```

It will prompt — type a long random password (this lets the Discord bot talk to the Worker). Save it, you need it again for the bot.

`SCRIPT_URL` is already set in `wrangler.toml` — no action needed.

### 2.4 Deploy

```
wrangler deploy
```

It prints your Worker URL, e.g. `https://nyx-keysystem.yourname.workers.dev`. **Save this — it's `WORKER_URL`.**

---

## PART 3 — Run the Discord bot

You need somewhere to run it 24/7. Easiest options:
- Your own PC (must stay on)
- A free Railway/Render/Fly.io instance
- Any VPS

On that machine:

```
cd keysystem
npm install
```

Set environment variables (how depends on platform):

```
DISCORD_TOKEN=<token from step 1.1>
WORKER_URL=https://nyx-keysystem.yourname.workers.dev
BOT_SECRET=<the password you invented in step 2.3>
ADMIN_IDS=<your discord user id from step 1.4>
```

Then:

```
node bot.js
```

You should see `Logged in as NYX#0000` and `Slash commands registered`.

---

## PART 4 — Daily use

In your Discord server:

| Command | Who | What it does |
|---|---|---|
| `/createkeys amount:10 tier:lifetime` | You (admin) | Generates 10 keys, shows them to you only |
| `/redeem key:NYX-XXXX-...` | Buyer | Binds key to their Discord account |
| `/getscript` | Buyer | DMs them `nyx_loader.lua` |
| `/mykey` | Buyer | Shows their key status |
| `/resethwid` | Buyer | Clears HWID binding (max 3 times) |
| `/keyinfo key:NYX-...` | You (admin) | Shows key details |

### How a buyer uses it

1. You sell them a key (however you want — DM, TikTok, etc.)
2. They join your Discord, run `/redeem NYX-XXXX-XXXX-XXXX`
3. They run `/getscript` → get `nyx_loader.lua` in DMs
4. They save it, set their key via `getsenv('NYX_KEY', 'NYX-...')` or put it in `nyx_key.txt`, run it in their executor
5. First run binds their PC's HWID to the key automatically
6. Every run after checks key + HWID against your Worker

---

## Troubleshooting

- **"Missing env vars"** → you didn't set DISCORD_TOKEN / WORKER_URL / BOT_SECRET
- **Bot offline** → token wrong, or intents not enabled, or bot not invited
- **"unauthorized" from Worker** → BOT_SECRET mismatch between bot and worker
- **Key says invalid** → check `/keyinfo` — maybe expired or already redeemed
- **HWID mismatch** → buyer changed PC; they run `/resethwid` then re-run loader

## Reverting / removing

- Delete the `keysystem/` folder → nothing else in NYX is affected
- `wrangler delete` removes the Worker + all keys
- Kick the bot from Discord, delete the app in Developer Portal
