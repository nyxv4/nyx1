import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  StringSelectMenuBuilder,
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

function findRole(guild, name) {
  const needle = name.toLowerCase();
  return guild.roles.cache.find((role) => role.name.trim().toLowerCase() === needle);
}

async function addJoinRoles(member) {
  const roles = JOIN_ROLE_NAMES.map((name) => findRole(member.guild, name)).filter(Boolean);
  const missing = roles.filter((role) => !member.roles.cache.has(role.id));
  if (missing.length > 0) await member.roles.add(missing);
}

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
  if (result.stacked) {
    return `Key stacked! ${result.key.tier === 'lifetime' ? 'Your key is now **lifetime**.' : `New expiry: **${dateText(result.key.expires)}**.`} Press **Get Script** below for your loader.`;
  }
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

// ---- ticket tool + dropdown panels ----

const TICKET_PANEL_CHANNEL_ID = '1574039296258736210'; // #purchase
const SUPPORT_PANEL_CHANNEL_ID = '1574045977940332677'; // #support
const stateDir = path.dirname(fileURLToPath(import.meta.url));
const ticketPanelStatePath = path.join(stateDir, '..', '.ticket-panel.json');
const supportPanelStatePath = path.join(stateDir, '..', '.support-panel.json');

const PURCHASE_PLANS = [
  { label: '1 Day Trial', value: '1d', description: '24 hour access' },
  { label: '7 Days', value: '7d', description: 'Weekly access' },
  { label: '30 Days', value: '30d', description: 'Monthly access' },
  { label: 'Lifetime', value: 'lifetime', description: 'Never expires' },
];

const TICKET_TYPES = [
  { label: 'General Support', value: 'general', description: 'Questions and help' },
  { label: 'Bug Report', value: 'bug', description: 'Report a bug' },
  { label: 'Key Issue', value: 'key', description: 'Key, HWID or loader problems' },
  { label: 'Purchase Help', value: 'purchase', description: 'Buying or payment questions' },
  { label: 'Other', value: 'other', description: 'Anything else' },
];

function ticketChannelName(user, type) {
  const base = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'user';
  return `ticket-${base}-${type}`.slice(0, 90);
}

function buildPurchasePanel() {
  return {
    content: '**purchase nyx**\nselect a plan below, or open a ticket and staff will help you buy.',
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('nyx:plan')
          .setPlaceholder('Select a plan')
          .addOptions(PURCHASE_PLANS),
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('nyx:tickettype')
          .setPlaceholder('Open a ticket')
          .addOptions(TICKET_TYPES),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nyx:ticket').setLabel('Open Ticket').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function buildSupportPanel() {
  return {
    content: '**support**\nselect a topic below to open a private ticket with staff.',
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('nyx:support')
          .setPlaceholder('What do you need help with?')
          .addOptions(TICKET_TYPES),
      ),
    ],
  };
}

async function postManagedPanel(client, channelId, stateFile, payload, label) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    let state = null;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    if (state?.channelId === channel.id && state?.messageId) {
      try {
        await (await channel.messages.fetch(state.messageId)).edit(payload);
        console.log(`${label} updated.`);
        return;
      } catch {}
    }
    const msg = await channel.send(payload);
    fs.writeFileSync(stateFile, JSON.stringify({ channelId: channel.id, messageId: msg.id }));
    console.log(`${label} posted.`);
  } catch (error) {
    console.error(`${label} failed:`, error.message);
  }
}

async function handleTicketOpen(interaction, type = 'general') {
  const guild = interaction.guild;
  const base = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'user';
  const existing = guild.channels.cache.find((channel) => channel.name?.startsWith(`ticket-${base}-`));
  if (existing) return interaction.editReply(`You already have an open ticket: ${existing}`);

  const name = ticketChannelName(interaction.user, type);
  let category = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === 'tickets',
  );
  if (!category) {
    category = await guild.channels.create({ name: 'Tickets', type: ChannelType.GuildCategory });
  }

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Ticket type: ${type}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      { id: client.user.id, allow: [PermissionFlagsBits.Administrator] },
    ],
  });

  await channel.send({
    content: `Hey ${interaction.user}, staff will be with you shortly.\nTicket type: **${type}**\nClick **Close Ticket** when you're done.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nyx:close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
      ),
    ],
  });
  return interaction.editReply(`Ticket created: ${channel}`);
}

async function handleSelect(interaction) {
  const id = interaction.customId;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (id === 'nyx:plan') {
      const plan = PURCHASE_PLANS.find((option) => option.value === interaction.values[0]);
      return interaction.editReply(
        `You selected **${plan ? plan.label : interaction.values[0]}**.\nTo purchase, open a ticket and staff will send you the payment details.`,
      );
    }
    if (id === 'nyx:support' || id === 'nyx:tickettype') {
      const type = TICKET_TYPES.some((option) => option.value === interaction.values[0])
        ? interaction.values[0]
        : 'general';
      return await handleTicketOpen(interaction, type);
    }
  } catch (error) {
    console.error(`Select ${id} failed:`, error.message);
    return interaction.editReply('Could not complete that. Please try again.');
  }
}

async function handleTicketClose(interaction) {
  const channel = interaction.channel;
  if (!channel || !channel.name?.startsWith('ticket-')) {
    return interaction.editReply('This is not a ticket channel.');
  }
  await interaction.editReply('Closing this ticket in 3 seconds...');
  setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 3000);
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
    if (id === 'nyx:ticket') return await handleTicketOpen(interaction);
    if (id === 'nyx:close_ticket') return await handleTicketClose(interaction);
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
  const member = interaction.guild
    ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
    : null;
  const allowed = member && member.roles.cache.some((role) => SCRIPT_ROLE_NAMES.has(role.name.toLowerCase()));
  if (!allowed) {
    return interaction.editReply('The script is only available to buyers and trial members. Ask an admin for a role.');
  }
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
    ...(result.telemetry ? [
      `**Executor:** ${result.telemetry.executor}`,
      `**Roblox user:** ${result.telemetry.username}`,
      `**Last seen:** ${dateText(result.telemetry.ts)}`,
    ] : ['**Executor:** No data yet']),
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
  await postManagedPanel(readyClient, TICKET_PANEL_CHANNEL_ID, ticketPanelStatePath, buildPurchasePanel(), 'Purchase panel');
  await postManagedPanel(readyClient, SUPPORT_PANEL_CHANNEL_ID, supportPanelStatePath, buildSupportPanel(), 'Support panel');
  await sweepJoinRoles().catch((error) => console.error('Join-role backfill failed:', error.message));
});

const BUYER_ROLE_TIERS = {
  'buyer (temporary)': '7d',
  'buyer (permanent)': 'lifetime',
  'trial': '1d',
};

const SCRIPT_ROLE_NAMES = new Set(Object.keys(BUYER_ROLE_TIERS));

function hasScriptRole(member) {
  return member.roles.cache.some((role) => SCRIPT_ROLE_NAMES.has(role.name.trim().toLowerCase()));
}

async function sweepJoinRoles() {
  for (const guild of client.guilds.cache.values()) {
    const joinRoles = JOIN_ROLE_NAMES.map((name) => findRole(guild, name)).filter(Boolean);
    if (joinRoles.length === 0) continue;
    const members = await guild.members.fetch().catch(() => null);
    if (!members) continue;
    for (const member of members.values()) {
      if (member.user.bot || hasScriptRole(member)) continue;
      const missing = joinRoles.filter((role) => !member.roles.cache.has(role.id));
      if (missing.length === 0) continue;
      await member.roles.add(missing).catch((error) => {
        console.error(`Join-role backfill failed for ${member.user.tag}:`, error.message);
      });
    }
  }
}

setInterval(sweepJoinRoles, 15 * 60 * 1000);

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const memberRole = newMember.guild.roles.cache.find((r) => r.name.toLowerCase() === 'member');
    for (const [roleName, tier] of Object.entries(BUYER_ROLE_TIERS)) {
      const role = newMember.guild.roles.cache.find((r) => r.name.toLowerCase() === roleName);
      if (!role) continue;
      const had = oldMember.roles.cache.has(role.id);
      const has = newMember.roles.cache.has(role.id);
      if (had && !has) {
        await callWorker('/api/admin/revoke', { discord_id: newMember.id }).catch(() => {});
        await newMember.send('Your NYX key has been deactivated.').catch(() => {});
        if (memberRole && !newMember.roles.cache.has(memberRole.id)) {
          await newMember.roles.add(memberRole).catch(() => {});
        }
        console.log(`Revoked key for ${newMember.user.tag} (${role.name} removed)`);
        continue;
      }
      if (had || !has) continue;

      if (memberRole && newMember.roles.cache.has(memberRole.id)) {
        await newMember.roles.remove(memberRole).catch(() => {});
      }

      const existing = await fetchOwnKey(newMember.id).catch(() => null);
      if (existing) {
        await newMember.send('You already have a NYX key linked to this Discord account. Use `/mykey` to check it.').catch(() => {});
        continue;
      }
      const result = await callWorker('/api/admin/createkeys', { amount: 1, tier });
      const key = result.keys[0];
      const intro = roleName === 'trial'
        ? 'Enjoy your trial!'
        : 'Thanks for your purchase!';
      await newMember.send([
        intro,
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

const EXPIRING_KEY_ROLES = ['trial', 'buyer (temporary)'];

async function sweepExpiredKeyRoles() {
  for (const guild of client.guilds.cache.values()) {
    const watched = EXPIRING_KEY_ROLES
      .map((name) => guild.roles.cache.find((role) => role.name.toLowerCase() === name))
      .filter(Boolean);
    if (!watched.length) continue;
    const members = await guild.members.fetch().catch(() => null);
    if (!members) continue;
    for (const member of members.values()) {
      const stale = watched.filter((role) => member.roles.cache.has(role.id));
      if (!stale.length) continue;
      const record = await fetchOwnKey(member.id).catch(() => null);
      if (record && (isExpired(record.expires) || record.status === 'banned')) {
        await member.roles.remove(stale.map((role) => role.id)).catch(() => {});
        const memberRole = guild.roles.cache.find((role) => role.name.toLowerCase() === 'member');
        if (memberRole) await member.roles.add(memberRole).catch(() => {});
        console.log(`Removed expired key roles from ${member.user.tag}`);
      }
    }
  }
}

setInterval(sweepExpiredKeyRoles, 5 * 60 * 1000);
setTimeout(sweepExpiredKeyRoles, 30 * 1000);

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await addJoinRoles(member);
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
  if (interaction.isStringSelectMenu()) {
    try {
      return await handleSelect(interaction);
    } catch (error) {
      console.error('Select interaction failed:', error.message);
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
