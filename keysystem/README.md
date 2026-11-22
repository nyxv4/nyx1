# NYX Discord bot and key Worker

This folder contains a Discord bot built with discord.js v14 and a Cloudflare Worker that stores NYX keys in Workers KV. The bot registers slash commands when it starts. The Worker serves `downloader.lua` from the configured GitHub raw URL only after the key and HWID pass validation.

## Requirements

- Node.js 20 or later and npm
- A Discord application and bot added to your server
- A Cloudflare account with Workers and Workers KV
- The GitHub raw URL for the NYX downloader must be publicly reachable

## 1. Install and configure

From this directory, install dependencies and create the bot environment file:

```sh
npm install
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp` if needed. Set these values in `.env`:

| Variable | Value |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal. Keep it private. |
| `WORKER_URL` | Deployed Worker URL, or `http://127.0.0.1:8787` while running locally. |
| `BOT_SECRET` | A long random secret shared with the Worker. |
| `ADMIN_IDS` | Comma-separated Discord user IDs allowed to run `/createkeys` and `/keyinfo`. |
| `DISCORD_GUILD_ID` | Optional server ID for quick guild-only command registration during development. Leave blank for global commands. |

Generate a random secret with:

```sh
node -p "require('node:crypto').randomBytes(32).toString('hex')"
```

Use the same secret for the bot and Worker. To find Discord user and server IDs, enable Developer Mode in Discord, then use **Copy User ID** or **Copy Server ID**. The application ID is obtained from the logged-in bot, so it does not need a separate environment variable.

In the Developer Portal, create a bot and invite it to your server with the `bot` and `applications.commands` scopes. Give it permission to send messages, attach files, and manage roles. Enable the **Server Members** privileged gateway intent so join auto-roles and member role updates work. Users must allow DMs from server members to receive `/getscript`.

## 2. Create the KV namespaces

Authenticate Wrangler, then create production and preview namespaces:

```sh
npx wrangler login
npx wrangler kv namespace create NYX_KEYS
npx wrangler kv namespace create NYX_KEYS_PREVIEW
```

Copy the IDs Wrangler prints into `wrangler.toml`, replacing `REPLACE_WITH_PRODUCTION_KV_NAMESPACE_ID` and `REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID`. Keep the `KEYS` binding name unchanged. The rate limit binding uses a separate integer namespace ID (`1001` by default); choose another integer if that ID is already used by another rate limiter in your Cloudflare account.

## 3. Set the Worker secret and deploy

For local Worker development, create a `.dev.vars` file beside `wrangler.toml`:

```dotenv
BOT_SECRET="paste-the-same-random-secret-used-in-.env"
```

The `.dev.vars` file is gitignored. Start the local Worker in one terminal:

```sh
npm run worker:dev
```

Set `WORKER_URL=http://127.0.0.1:8787` in `.env` for local bot development.

For production, set the encrypted Cloudflare secret and deploy:

```sh
npx wrangler secret put BOT_SECRET --config wrangler.toml
npm run worker:deploy
```

Paste the same random secret when Wrangler prompts. With the configured Worker name and the `nyxauth` workers.dev account subdomain, the expected URL is `https://script-whitelist.nyx178bedwars.workers.dev`; use the URL printed by Wrangler if your account uses a different workers.dev subdomain. Set that URL as `WORKER_URL` in `.env`.

`SCRIPT_SOURCE_URL` in `wrangler.toml` points to:

```text
https://raw.githubusercontent.com/nyxv4/nyx1/main/downloader.lua
```

Change that non-secret variable if the source moves. The Worker fetches the source only after authorizing each `/getscript` request.

## 4. Start the bot

```sh
npm start
```

On first login, the bot registers all six commands. Global command registration may take time to appear throughout Discord. For quick development, set `DISCORD_GUILD_ID` to your test server ID and restart the bot; guild commands normally update sooner. Keep the bot process running to handle interactions.

## Commands and key lifecycle

| Command | Behavior |
| --- | --- |
| `/getscript` | Looks up the caller's redeemed key and DMs a `nyx-loader.lua` attachment with that key baked in. |
| `/redeem key:<key>` | Redeems an unused key to the caller's Discord ID. Redeeming the same key again from the same account is idempotent. |
| `/mykey` | Shows the caller's tier, status, expiration, whether an HWID is bound, and reset count. The key is masked. |
| `/resethwid` | Clears a bound HWID, up to three successful resets. The next valid loader request binds the new one. |
| `/createkeys amount:<1–100> tier:<lifetime\|7d\|30d\|90d>` | Admin only. Creates keys and returns them in a private text attachment. |
| `/keyinfo key:<key>` | Admin only. Shows the key record. |

The key status starts at `unused`. `/redeem` changes it to `redeemed`, associates it with a Discord account, and starts the paid tier's expiration clock. Lifetime keys have no expiration. The first authorized `/getscript` request binds the HWID and changes the status to `active`. A reset returns the key to `redeemed` until its next loader request.

The generated loader follows this pattern, with the actual key inserted for each user and an HWID query added to the URL:

```lua
getgenv().script_key = "NYX-ABCD-EFGH-JKLM"
local clientId = game:GetService("RbxAnalyticsService"):GetClientId()
local hwid = clientId
if type(crypt) == "table" and type(crypt.hash) == "function" then
    local ok, hashed = pcall(function() return crypt.hash("sha256", clientId) end)
    if ok and type(hashed) == "string" and #hashed > 0 then hwid = hashed end
end
local http = game:GetService("HttpService")
local f, e = loadstring(game:HttpGet("https://script-whitelist.nyx178bedwars.workers.dev/getscript?key=NYX-ABCD-EFGH-JKLM&hwid=" .. http:UrlEncode(tostring(hwid))))
if f then f() else warn(e) end
```

When available, `crypt.hash("sha256", clientId)` is sent; otherwise the Roblox `RbxAnalyticsService` client ID is sent. This is a client-provided identifier, so hashing does not make it impossible to spoof. Invalid `/getscript` requests return plain text with HTTP 200 so the response can flow into `loadstring` and its error can reach `warn(e)`.

## Worker API

The bot calls these JSON APIs over HTTPS and supplies `secret` in the request body. Every API route requires the shared `BOT_SECRET`.

| Method and path | Body fields |
| --- | --- |
| `GET /getscript?key=...&hwid=...` | Public loader authorization; the HWID binds on first successful use. |
| `POST /api/redeem` | `key`, `discord_id`, `secret` |
| `POST /api/admin/createkeys` | `amount`, `tier`, `secret` |
| `POST /api/admin/resethwid` | `discord_id`, `secret` |
| `POST /api/admin/discordkey` | `discord_id`, `secret` |
| `POST /api/admin/keyinfo` | `key`, `secret` |

`/api/admin/keyinfo` is included for the bot's `/keyinfo` command. `GET /` is a minimal health response.

KV records use `key:<NYX-...>` for the key object and `discord:<Discord ID>` as the current key lookup index. Each key object contains `key`, `status`, `discord_id`, `hwid`, `resets`, `created`, `expires`, and `tier`.

## Operational notes

- `/getscript` is limited to 20 attempts per IP per 60 seconds by the Cloudflare Rate Limiting binding. Cloudflare's binding is approximate and counts separately in each location, so it is a practical abuse throttle rather than a strict global quota.
- Workers KV is eventually consistent and does not provide transactions. The implementation is suitable for a small key system, but simultaneous redemption or first-use requests from different locations can briefly race. If you need strict single-use guarantees at higher scale, move redemption and HWID binding to a transactional store or serialize those writes through a Durable Object.
- Keep `.env`, `.dev.vars`, bot tokens, and `BOT_SECRET` private. Rotate the Discord token or shared secret if one is exposed.
- The bot returns generated keys and loader files as ephemeral interaction replies or DMs, but recipients can still copy or share them.

## Troubleshooting

- **Commands are missing:** confirm the bot is in the server with `applications.commands`; for development, set `DISCORD_GUILD_ID` and restart.
- **`/getscript` says no key:** redeem an unused key from the same Discord account first.
- **Loader reports an HWID mismatch:** use `/resethwid` if you have resets left, then run the loader once from the new device.
- **Worker API reports unauthorized:** ensure the bot's `BOT_SECRET` and the Worker secret match exactly.
- **Loader says the source is unavailable:** check that `SCRIPT_SOURCE_URL` returns the Lua source without authentication and that the GitHub repository/path is correct.
