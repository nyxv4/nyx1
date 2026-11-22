import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { commands } from './commands.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const panelChannelId = process.env.PANEL_CHANNEL_ID?.trim() || '';
const panelStatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.panel.json');

const JOIN_ROLE_NAMES = ['Free', 'Member'];
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
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
  return `loadstring(game:HttpGet("${endpoint}"..game:GetService("RbxAnalyticsService"):GetClientId()))({
    Closet = false, -- set to true to disable all notifications
})`;
}

async function fetchOwnKey(discordId) {
  const result = await callWorker('/api/admin/discordkey', { discord_id: discordId });
  return result.found ? result.key : null;
}

async function redeemKey(discordId, key) {
  const result = await callWorker('/api/redeem', { key: key.trim().toUpperCase(), discord_id: discordId });
  return result.already_redeemed
    ? 'That key is already linked to your Discord account.'
    : `Key redeemed. Tier: **${result.key.tier}**. Press **Get Script** below for your loader.`;
}

async function resetHwid(discordId) {
  const result = await callWorker('/api/admin/resethwid', { discord_id: discordId });
  return `HWID reset. Resets used this week: **${result.key.resets}/10**. Your next valid loader request will bind the new HWID.`;
}

// ---- catvape-style button panel ----

const PANEL_CONTENT = [
  '**nyx**',
  '**get your script, reset your hwid or check your key below.**',
].join('\n');

function buildPanel() {
  return {
    content: PANEL_CONTENT,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nyx:getscript').setLabel('Get Script').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('nyx:resethwid').setLabel('Reset HWID').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nyx:mykey').setLabel('My Key').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nyx:redeem').setLabel('Redeem Key').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

async function postOrUpdatePanel(client) {
  if (!panelChannelId) return;
  try {
    const channel = await client.channels.fetch(panelChannelId);
    if (!channel || !channel.isTextBased()) {
      console.error('PANEL_CHANNEL_ID is not a text channel.');
      return;
    }
    let state = null;
    try { state = JSON.parse(fs.readFileSync(panelStatePath, 'utf8')); } catch {}
    const payload = buildPanel();
    if (state?.channelId === channel.id && state?.messageId) {
      try {
        const msg = await channel.messages.fetch(state.messageId);
        await msg.edit(payload);
        console.log('Panel message updated.');
        return;
      } catch {}
    }
    const msg = await channel.send(payload);
    fs.writeFileSync(panelStatePath, JSON.stringify({ channelId: channel.id, messageId: msg.id }));
    console.log('Panel message posted.');
  } catch (error) {
    console.error('Panel post failed:', error.message);
  }
}

async function handleButton(interaction) {
  const id = interaction.customId;
  if (id === 'nyx:redeem') {
    const modal = new ModalBuilder().setCustomId('nyx:redeem_modal').setTitle('Redeem NYX Key');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('key')
        .setLabel('Your key (NYX-XXXX-XXXX-XXXX)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(19),
    ));
    return interaction.showModal(modal);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (id === 'nyx:getscript') return await handleGetScript(interaction);
    if (id === 'nyx:resethwid') return await interaction.editReply(await resetHwid(interaction.user.id));
    if (id === 'nyx:mykey') return await handleMyKey(interaction);
  } catch (error) {
    console.error(`Button ${id} failed:`, error.message);
    const message = error instanceof WorkerError ? error.message : 'The request failed. Please try again shortly.';
    return interaction.editReply(`Could not complete that: ${message}`);
  }
}

async function handleModal(interaction) {
  if (interaction.customId !== 'nyx:redeem_modal') return;
  const key = interaction.fields.getTextInputValue('key');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    return await interaction.editReply(await redeemKey(interaction.user.id, key));
  } catch (error) {
    console.error('Redeem modal failed:', error.message);
    const message = error instanceof WorkerError ? error.message : 'The request failed. Please try again shortly.';
    return interaction.editReply(`Could not redeem: ${message}`);
  }
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
    `**Key:** \`${record.key}\``,
    `**Status:** ${visibleStatus(record)}`,
    `**Tier:** ${record.tier}`,
    `**Expires:** ${expiryText(record)}`,
    `**Injected:** ${record.injected_at ? dateText(record.injected_at) : 'Not injected yet'}`,
    `**HWID:** ${record.hwid ? 'Bound' : 'Not bound yet'}`,
    `**HWID resets:** ${record.resets}/10 this week`,
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
    `**Resets:** ${record.resets}/10 this week`,
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
  await postOrUpdatePanel(readyClient);
});

const BUYER_ROLE_TIERS = {
  'buyer (temporary)': '7d',
  'buyer (permanent)': 'lifetime',
  'trial': '1d',
};

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    for (const [roleName, tier] of Object.entries(BUYER_ROLE_TIERS)) {
      const role = newMember.guild.roles.cache.find((r) => r.name.toLowerCase() === roleName);
      if (!role) continue;
      const had = oldMember.roles.cache.has(role.id);
      const has = newMember.roles.cache.has(role.id);
      if (had && !has) {
        await callWorker('/api/admin/revoke', { discord_id: newMember.id }).catch(() => {});
        await newMember.send('Your NYX key has been deactivated.').catch(() => {});
        console.log(`Revoked key for ${newMember.user.tag} (${role.name} removed)`);
        continue;
      }
      if (had || !has) continue;

      const existing = await fetchOwnKey(newMember.id).catch(() => null);
      if (existing) {
        await newMember.send('You already have a NYX key linked to this Discord account. Use `/mykey` to check it.').catch(() => {});
        continue;
      }
      const result = await callWorker('/api/admin/createkeys', { amount: 1, tier });
      const key = result.keys[0];
      await newMember.send([
        'Thanks for your purchase!',
        '',
        `Your NYX key: \`${key}\``,
        '',
        'Redeem it in the server with `/redeem key:' + key + '` or the **Redeem Key** button,',
        'then grab your loader with **Get Script**.',
      ].join('\n')).catch(() => {});
      console.log(`Sent ${tier} key to ${newMember.user.tag} via ${role.name}`);
    }
  } catch (error) {
    console.error('Buyer role key delivery failed:', error.message);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const roles = JOIN_ROLE_NAMES
      .map((name) => member.guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase()))
      .filter(Boolean);
    if (roles.length > 0) await member.roles.add(roles);
  } catch (error) {
    console.error(`Auto-role failed for ${member.user.tag}:`, error.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    try {
      return await handleButton(interaction);
    } catch (error) {
      console.error('Button interaction failed:', error.message);
    }
    return;
  }
  if (interaction.isModalSubmit()) {
    try {
      return await handleModal(interaction);
    } catch (error) {
      console.error('Modal interaction failed:', error.message);
    }
    return;
  }
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
        const key = interaction.options.getString('key', true);
        return await interaction.editReply(await redeemKey(interaction.user.id, key));
      }
      case 'mykey':
        return await handleMyKey(interaction);
      case 'resethwid':
        return await interaction.editReply(await resetHwid(interaction.user.id));
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
