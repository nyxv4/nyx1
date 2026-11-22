import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('getscript')
    .setDescription('DM yourself your NYX loader file'),
  new SlashCommandBuilder()
    .setName('redeem')
    .setDescription('Bind a NYX key to your Discord account')
    .addStringOption((option) =>
      option.setName('key').setDescription('Your NYX key').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('mykey')
    .setDescription('Show your NYX key status'),
  new SlashCommandBuilder()
    .setName('resethwid')
    .setDescription('Reset your HWID binding (up to 3 times)'),
  new SlashCommandBuilder()
    .setName('createkeys')
    .setDescription('Create NYX keys (admins only)')
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Number of keys to create (1–100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('tier')
        .setDescription('Key duration')
        .setRequired(true)
        .addChoices(
          { name: 'Lifetime', value: 'lifetime' },
          { name: '7 days', value: '7d' },
          { name: '30 days', value: '30d' },
          { name: '90 days', value: '90d' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('keyinfo')
    .setDescription('Show details for a NYX key (admins only)')
    .addStringOption((option) =>
      option.setName('key').setDescription('NYX key to inspect').setRequired(true),
    ),
].map((command) => command.toJSON());
