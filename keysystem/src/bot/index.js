import {
  AttachmentBuilder,
  Client,
  Events,
  MessageFlags,
  REST,
  Routes,
} from 'discord.js';
import { commands } from './commands.js';

const requiredEnv = ['DISCORD_TOKEN', 'WORKER_URL', 'BOT_SECRET', 'ADMIN_IDS'];
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const workerBase = new URL(process.env.WORKER_URL);
if (!['http:', 'https:'].includes(workerBase.protocol)) {
  throw new Error('WORKER_URL must use http:// or https://');
}
const workerUrl = workerBase.toString().replace(/\/$/, '');
const adminIds = new Set(process.env.ADMIN_IDS.split(',').map((id) => id.trim()).filter(Boolean));
if (adminIds.size === 0) throw new Error('ADMIN_IDS must contain at least one Discord user ID');

const client = new Client({ intents: [] });
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

class WorkerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function callWorker(path, fields = {}) {
  const response = await fetch(`${workerUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fields, secret: process.env.BOT_SECRET }),
    signal: AbortSignal.timeout(12_000),
  });
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new WorkerError('The Worker returned an unexpected response.', response.status);
  }
  if (!response.ok || result.ok === false) {
    throw new WorkerError(result.error || `Worker request failed (${response.status}).`, response.status);
  }
  return result;
}

function privateReply(content, extra = {}) {
  return { content, flags: MessageFlags.Ephemeral, ...extra };
}

function isExpired(expires) {
  return Boolean(expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now()));
}

function visibleStatus(record) {
  return isExpired(record.expires) ? 'expired' : record.status;
}

function maskedKey(key) {
  const parts = key.split('-');
  return `${parts[0]}-••••-••••-${parts.at(-1)}`;
}

function dateText(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Invalid date' : date.toUTCString();
}

function expiryText(record) {
  if (!record.expires) {
    if (record.tier === 'lifetime') return 'Never (lifetime)';
    return record.status === 'unused' ? 'Starts on redemption' : 'Not set';
  }
  return dateText(record.expires);
}

function buildLoader(key) {
  const endpoint = `${workerUrl}/getscript?key=${key}&hwid=`;
  return [
    `getgenv().script_key = "${key}"`,
    'local i=game:GetService("RbxAnalyticsService"):GetClientId()local h=i',
    'if crypt and crypt.hash then local o,x=pcall(crypt.hash,"sha256",i)if o and type(x)=="string"then h=x end end',
    `local f,e=loadstring(game:HttpGet("${endpoint}"..tostring(h)))`,
    'if f then f()else warn(e)end',
  ].join('\n');
}

async function fetchOwnKey(discordId) {
  const result = await callWorker('/api/admin/discordkey', { discord_id: discordId });
  return result.found ? result.key : null;
}

async function handleGetScript(interaction) {
  const record = await fetchOwnKey(interaction.user.id);
  if (!record) return interaction.editReply('No key is linked to your Discord account. Redeem one with `/redeem` first.');
  if (!['redeemed', 'active'].includes(record.status) || isExpired(record.expires)) {
    return interaction.editReply(`Your key cannot load the script (status: ${visibleStatus(record)}).`);
  }

  const attachment = new AttachmentBuilder(Buffer.from(buildLoader(record.key), 'utf8'), {
    name: 'nyx-loader.lua',
  });
  try {
    await interaction.user.send({
      content: 'Your NYX loader is attached. Keep this file private; it contains your key.',
      files: [attachment],
    });
    return interaction.editReply('I sent your loader in a DM. Check that your DMs are open.');
  } catch {
    return interaction.editReply('I could not DM you. Enable DMs from server members, then run `/getscript` again.');
  }
}

async function handleMyKey(interaction) {
  const record = await fetchOwnKey(interaction.user.id);
  if (!record) return interaction.editReply('You do not have a redeemed NYX key linked to this Discord account.');
  return interaction.editReply([
    `**Key:** \`${maskedKey(record.key)}\``,
    `**Status:** ${visibleStatus(record)}`,
    `**Tier:** ${record.tier}`,
    `**Expires:** ${expiryText(record)}`,
    `**HWID:** ${record.hwid ? 'Bound' : 'Not bound yet'}`,
    `**HWID resets:** ${record.resets}/3`,
  ].join('\n'));
}

async function handleKeyInfo(interaction) {
  const key = interaction.options.getString('key', true).trim().toUpperCase();
  const result = await callWorker('/api/admin/keyinfo', { key });
  if (!result.found) return interaction.editReply('That key was not found.');
  const record = result.key;
  return interaction.editReply([
    `**Key:** \`${record.key}\``,
    `**Status:** ${visibleStatus(record)}`,
    `**Discord ID:** ${record.discord_id || '—'}`,
    `**HWID:** ${record.hwid ? 'Bound' : 'Not bound'}`,
    `**Resets:** ${record.resets}/3`,
    `**Tier:** ${record.tier}`,
    `**Created:** ${dateText(record.created)}`,
    `**Expires:** ${expiryText(record)}`,
  ].join('\n'));
}

client.once(Events.ClientReady, async (readyClient) => {
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const route = guildId
    ? Routes.applicationGuildCommands(readyClient.user.id, guildId)
    : Routes.applicationCommands(readyClient.user.id);
  try {
    await rest.put(route, { body: commands });
    console.log(`Registered ${commands.length} slash commands${guildId ? ` in guild ${guildId}` : ' globally'}.`);
  } catch (error) {
    console.error('Slash command registration failed:', error.message);
  }
  console.log(`NYX bot online as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.commandName;
  const adminOnly = command === 'createkeys' || command === 'keyinfo';
  if (adminOnly && !adminIds.has(interaction.user.id)) {
    return interaction.reply(privateReply('You are not allowed to use this command.'));
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (command) {
      case 'getscript':
        return await handleGetScript(interaction);
      case 'redeem': {
        const key = interaction.options.getString('key', true).trim().toUpperCase();
        const result = await callWorker('/api/redeem', { key, discord_id: interaction.user.id });
        return await interaction.editReply(result.already_redeemed
          ? 'That key is already linked to your Discord account.'
          : `Key redeemed. Tier: **${result.key.tier}**. Run \`/getscript\` for your loader.`);
      }
      case 'mykey':
        return await handleMyKey(interaction);
      case 'resethwid': {
        const result = await callWorker('/api/admin/resethwid', { discord_id: interaction.user.id });
        return await interaction.editReply(`HWID reset. Resets used: **${result.key.resets}/3**. Your next valid loader request will bind the new HWID.`);
      }
      case 'createkeys': {
        const amount = interaction.options.getInteger('amount', true);
        const tier = interaction.options.getString('tier', true);
        const result = await callWorker('/api/admin/createkeys', { amount, tier });
        const text = result.keys.join('\n') + '\n';
        const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `nyx-${tier}-keys.txt` });
        return await interaction.editReply({
          content: `Created **${result.keys.length}** ${tier} key(s). The private attachment contains the keys.`,
          files: [file],
        });
      }
      case 'keyinfo':
        return await handleKeyInfo(interaction);
      default:
        return await interaction.editReply('Unknown command.');
    }
  } catch (error) {
    console.error(`/${command} failed:`, error.message);
    const message = error instanceof WorkerError ? error.message : 'The request failed. Please try again shortly.';
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(`Could not complete that command: ${message}`);
    }
    return interaction.reply(privateReply(`Could not complete that command: ${message}`));
  }
});

client.login(process.env.DISCORD_TOKEN);
