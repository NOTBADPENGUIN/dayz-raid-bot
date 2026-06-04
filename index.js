require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { spawn } = require('child_process');
const express = require('express');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const https = require('https');
const axios = require('axios');
const fs = require('fs');
const mongoose = require('mongoose');

try { require('sodium'); } catch(e) {
  try { require('libsodium-wrappers'); } catch(e2) {}
}

process.env.FFMPEG_PATH = ffmpegPath;

// ─── Connexion MongoDB ────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).then(() => {
  console.log('MongoDB connecte');
}).catch(e => console.error('Erreur MongoDB:', e.message));

// ─── Schema config par serveur ────────────────────────────────────────────────
const guildSchema = new mongoose.Schema({
  guildId:          { type: String, required: true, unique: true },
  alertChannelId:   { type: String, default: null },
  raidAlarmRoleId:  { type: String, default: null },
  logChannelId:     { type: String, default: null },
  cooldownSeconds:  { type: Number, default: 60 },
  ntfyTopic:        { type: String, default: null },
  serverIp:         { type: String, default: null },
  joueursEnLigne:   { type: [String], default: [] },
});
const GuildConfig = mongoose.model('GuildConfig', guildSchema);

async function getConfig(guildId) {
  let config = await GuildConfig.findOne({ guildId });
  if (!config) config = await GuildConfig.create({ guildId });
  return config;
}

// ─── Etat par serveur (en mémoire) ───────────────────────────────────────────
const dernierRaidMap   = new Map();
const voiceActiveMap   = new Map();
const dmSpamMap        = new Map();

// ─── Client Discord ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ─── Webhook Express ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhook/:guildId', async (req, res) => {
  res.sendStatus(200);
  const guild = client.guilds.cache.get(req.params.guildId);
  if (guild) await triggerRaidAlert(guild, req.body);
});

// ─── Commandes Slash ─────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configurer le bot DayZ Raid pour ce serveur')
    .setDefaultMemberPermissions(0x8) // ADMINISTRATOR
    .addSubcommand(sub => sub
      .setName('salon-alerte')
      .setDescription('Salon où les alertes seront envoyées')
      .addChannelOption(opt => opt.setName('salon').setDescription('Salon texte').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('role')
      .setDescription('Role qui recevra les DMs d\'alerte')
      .addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('salon-logs')
      .setDescription('Salon pour les logs (optionnel)')
      .addChannelOption(opt => opt.setName('salon').setDescription('Salon texte').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('serveur-dayz')
      .setDescription('IP de votre serveur DayZ (optionnel)')
      .addStringOption(opt => opt.setName('ip').setDescription('IP:PORT ex: 37.156.35.92:2302').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('cooldown')
      .setDescription('Delai minimum entre deux alertes en secondes (defaut: 60)')
      .addIntegerOption(opt => opt.setName('secondes').setDescription('Secondes').setRequired(true).setMinValue(10).setMaxValue(3600)))
    .addSubcommand(sub => sub
      .setName('ntfy')
      .setDescription('Topic ntfy.sh pour notifications telephone (optionnel)')
      .addStringOption(opt => opt.setName('topic').setDescription('Votre topic ntfy').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('statut')
      .setDescription('Voir la configuration actuelle')),
].map(cmd => cmd.toJSON());

// ─── Enregistrer les slash commands ──────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('Slash commands enregistrees');
}

// ─── Logique d'alerte ─────────────────────────────────────────────────────────
async function logToDiscord(guild, config, message) {
  if (!config.logChannelId) return;
  const ch = guild.channels.cache.get(config.logChannelId);
  if (ch) await ch.send(message).catch(() => {});
}

async function envoyerDMsRaid(guild, config, data) {
  if (!config.raidAlarmRoleId) return;
  const role = guild.roles.cache.get(config.raidAlarmRoleId);
  if (!role) return;
  const membres = role.members.filter(m => !m.user.bot);
  console.log(`DMs: ${membres.size} membres avec le role, ${config.joueursEnLigne.length} en ligne`);
  for (const [id, membre] of membres) {
    if (config.joueursEnLigne.includes(id)) continue;
    try {
      await membre.send(`RAID EN COURS !\nLocalisation: ${data.location || 'Inconnue'}\nDetecte par: ${data.player || 'Raid Alarm'}\nHeure: ${new Date().toLocaleTimeString('fr-FR')}\n\nTape !joue dans le salon raid pour arreter ces notifications.`);
    } catch (e) {}
  }
}

function demarrerSpamDM(guild, config, data) {
  stopperSpamDM(guild.id);
  let i = 0;
  const interval = setInterval(async () => {
    if (++i >= 20) { stopperSpamDM(guild.id); return; }
    const cfg = await getConfig(guild.id);
    await envoyerDMsRaid(guild, cfg, data);
  }, 15000);
  dmSpamMap.set(guild.id, interval);
}

function stopperSpamDM(guildId) {
  if (dmSpamMap.has(guildId)) {
    clearInterval(dmSpamMap.get(guildId));
    dmSpamMap.delete(guildId);
  }
}

async function triggerRaidAlert(guild, data) {
  const config = await getConfig(guild.id);
  if (!config.alertChannelId) return;

  const maintenant = Date.now();
  const dernierRaid = dernierRaidMap.get(guild.id) || 0;
  const cooldown = (config.cooldownSeconds || 60) * 1000;
  if (maintenant - dernierRaid < cooldown) return;
  dernierRaidMap.set(guild.id, maintenant);

  const channel = guild.channels.cache.get(config.alertChannelId);
  if (channel) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('RAID EN COURS !')
      .setDescription('Un raid a ete detecte sur le serveur !')
      .addFields(
        { name: 'Localisation', value: data.location || 'Inconnue', inline: true },
        { name: 'Heure', value: new Date().toLocaleTimeString('fr-FR'), inline: true },
        { name: 'Detecte par', value: data.player || 'Raid Alarm', inline: true }
      )
      .setTimestamp();
    await channel.send({ content: '@everyone **RAID ALERT !**', embeds: [embed] });
  }

  await logToDiscord(guild, config, `Raid declenche — ${data.location || 'Inconnue'} — ${data.player || 'Raid Alarm'}`);
  await envoyerDMsRaid(guild, config, data);
  demarrerSpamDM(guild, config, data);
  if (config.ntfyTopic) await ntfyAlert(config.ntfyTopic, data);
  await discordVoiceAlert(guild, config);
  if (process.env.TWILIO_SID) await phoneCallAlert();
}

async function discordVoiceAlert(guild, config) {
  if (voiceActiveMap.get(guild.id)) return;
  voiceActiveMap.set(guild.id, true);
  try {
    const voiceChannel = guild.channels.cache.find(ch => ch.isVoiceBased() && ch.members.size > 0);
    if (!voiceChannel) { voiceActiveMap.set(guild.id, false); return; }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      voiceActiveMap.set(guild.id, false);
      connection.destroy();
      return;
    }

    const player = createAudioPlayer();
    const audioPath = path.resolve(__dirname, 'alert.mp3');
    const ffmpeg = spawn(ffmpegPath, ['-i', audioPath, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(1);
    connection.subscribe(player);
    player.play(resource);
    player.on('error', () => { voiceActiveMap.set(guild.id, false); connection.destroy(); });

    setTimeout(() => {
      voiceActiveMap.set(guild.id, false);
      try { connection.destroy(); } catch {}
    }, 60000);
  } catch {
    voiceActiveMap.set(guild.id, false);
  }
}

async function ntfyAlert(topic, data) {
  return new Promise(resolve => {
    const body = Buffer.from(`RAID EN COURS !\nLocalisation: ${data.location || 'Inconnue'}\nDetecte par: ${data.player || 'Raid Alarm'}`);
    const req = https.request({
      hostname: 'ntfy.sh', port: 443, path: `/${topic}`, method: 'POST',
      headers: { 'Title': 'RAID EN COURS !', 'Priority': 'urgent', 'Tags': 'rotating_light,bell', 'Content-Length': body.length }
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

async function phoneCallAlert() {
  if (!process.env.TWILIO_SID) return;
  const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  const numbers = process.env.PHONE_NUMBERS?.split(',') || [];
  for (const num of numbers) {
    try {
      await twilio.calls.create({
        twiml: '<Response><Say language="fr-FR" voice="alice">Alerte raid sur votre serveur DayZ. Connectez-vous immediatement.</Say></Response>',
        to: num.trim(), from: process.env.TWILIO_FROM,
      });
    } catch (e) { console.error(`Erreur appel ${num}:`, e.message); }
  }
}

async function mettreAJourSalonServeur(guild, config) {
  if (!config.serverIp) return;
  const ip = config.serverIp.split(':')[0];
  let nom;
  try {
    const steamKey = process.env.STEAM_API_KEY;
    const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?filter=addr\\${config.serverIp}&key=${steamKey}&limit=1`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const serveur = data.response?.servers?.[0];
    if (serveur) {
      nom = `🟢 DayZ | ${serveur.players}/${serveur.max_players}`;
    } else {
      nom = `🔴 DayZ | Hors ligne`;
    }
  } catch (e) {
    console.log('Erreur Steam API:', e.message);
    nom = `🔴 DayZ | Erreur`;
  }

  let salon = guild.channels.cache.find(ch => ch.isVoiceBased() && ch.name.includes('DayZ |'));
  if (salon) { if (salon.name !== nom) await salon.setName(nom).catch(() => {}); }
  else {
    await guild.channels.create({
      name: nom, type: ChannelType.GuildVoice,
      permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] }],
    }).catch(() => {});
  }
}

async function nettoyerSalon(guild, config) {
  if (!config.alertChannelId) return;
  const channel = guild.channels.cache.get(config.alertChannelId);
  if (!channel) return;
  const cinqHeures = Date.now() - 5 * 60 * 60 * 1000;
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const vieux = messages.filter(m => m.createdTimestamp < cinqHeures);
    if (vieux.size === 0) return;
    if (vieux.size === 1) await vieux.first().delete().catch(() => {});
    else await channel.bulkDelete(vieux, true).catch(() => {});
    console.log(`[${guild.name}] ${vieux.size} message(s) supprimes`);
  } catch {}
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`Bot connecte : ${client.user.tag}`);
  await registerCommands();

  // Boucles toutes les 60s pour chaque serveur
  setInterval(async () => {
    for (const [, guild] of client.guilds.cache) {
      const config = await getConfig(guild.id);
      await mettreAJourSalonServeur(guild, config);
    }
  }, 60000);

  // Nettoyage toutes les heures
  setInterval(async () => {
    for (const [, guild] of client.guilds.cache) {
      const config = await getConfig(guild.id);
      await nettoyerSalon(guild, config);
    }
  }, 60 * 60 * 1000);
});

// ─── Slash commands handler ───────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'setup') return;

  const sub = interaction.options.getSubcommand();
  const config = await getConfig(interaction.guildId);

  if (sub === 'salon-alerte') {
    const salon = interaction.options.getChannel('salon');
    config.alertChannelId = salon.id;
    await config.save();
    await interaction.reply(`Salon d'alerte configure : ${salon}`);

  } else if (sub === 'role') {
    const role = interaction.options.getRole('role');
    config.raidAlarmRoleId = role.id;
    await config.save();
    await interaction.reply(`Role configure : ${role}`);

  } else if (sub === 'salon-logs') {
    const salon = interaction.options.getChannel('salon');
    config.logChannelId = salon.id;
    await config.save();
    await interaction.reply(`Salon logs configure : ${salon}`);

  } else if (sub === 'serveur-dayz') {
    const ip = interaction.options.getString('ip');
    config.serverIp = ip;
    await config.save();
    await interaction.reply(`Serveur DayZ configure : \`${ip}\``);

  } else if (sub === 'cooldown') {
    const secondes = interaction.options.getInteger('secondes');
    config.cooldownSeconds = secondes;
    await config.save();
    await interaction.reply(`Cooldown configure : ${secondes}s`);

  } else if (sub === 'ntfy') {
    const topic = interaction.options.getString('topic');
    config.ntfyTopic = topic;
    await config.save();
    await interaction.reply(`Topic ntfy configure : \`${topic}\``);

  } else if (sub === 'statut') {
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('Configuration du bot')
      .addFields(
        { name: 'Salon alerte', value: config.alertChannelId ? `<#${config.alertChannelId}>` : 'Non configure', inline: true },
        { name: 'Role', value: config.raidAlarmRoleId ? `<@&${config.raidAlarmRoleId}>` : 'Non configure', inline: true },
        { name: 'Salon logs', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Non configure', inline: true },
        { name: 'Cooldown', value: `${config.cooldownSeconds}s`, inline: true },
        { name: 'Serveur DayZ', value: config.serverIp || 'Non configure', inline: true },
        { name: 'Ntfy', value: config.ntfyTopic || 'Non configure', inline: true },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
});

// ─── Messages handler ─────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return;

  const config = await getConfig(message.guildId);
  if (!config.alertChannelId) return;

  // Bot/webhook dans le salon d'alerte -> declencher raid
  if (message.author.bot && message.channelId === config.alertChannelId) {
    await triggerRaidAlert(message.guild, { location: 'Detecte via bot/webhook', player: message.author.username });
    return;
  }
  if (message.author.bot) return;

  // Commande !fc (tous salons)
  if (message.content.trim().toLowerCase() === '!fc') {
    await message.reply('https://onlyfans.com/sophieraiin/videos');
    return;
  }

  if (message.channelId !== config.alertChannelId) return;

  const cmd = message.content.trim().toLowerCase();

  if (cmd === '!joue') {
    if (!config.joueursEnLigne.includes(message.author.id)) {
      config.joueursEnLigne.push(message.author.id);
      await config.save();
    }
    await message.reply(`${message.author.username} est en ligne — DMs desactives jusqu a !offline.`);
    return;
  }

  if (cmd === '!offline') {
    config.joueursEnLigne = config.joueursEnLigne.filter(id => id !== message.author.id);
    await config.save();
    await message.reply(`${message.author.username} est hors ligne — DMs reactives au prochain raid.`);
    return;
  }

  if (cmd === '!status') {
    const dernierRaid = dernierRaidMap.get(message.guildId) || 0;
    const cooldown = (config.cooldownSeconds || 60) * 1000;
    const tempsRestant = cooldown - (Date.now() - dernierRaid);
    const embed = new EmbedBuilder()
      .setColor(tempsRestant > 0 ? 0xFFA500 : 0x00FF00)
      .setTitle('Statut du bot')
      .addFields(
        { name: 'Bot', value: 'En ligne', inline: true },
        { name: 'Cooldown', value: tempsRestant > 0 ? `${Math.ceil(tempsRestant/1000)}s restantes` : 'Pret', inline: true },
        { name: 'Joueurs en ligne', value: `${config.joueursEnLigne.length}`, inline: true },
        { name: 'Dernier raid', value: dernierRaid > 0 ? `<t:${Math.floor(dernierRaid/1000)}:R>` : 'Aucun', inline: true },
      ).setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (cmd === '!test') {
    await message.reply('Lancement alerte de test...');
    await triggerRaidAlert(message.guild, { location: 'Test', player: message.author.username });
    return;
  }

  await triggerRaidAlert(message.guild, { location: 'Detecte via message Discord', player: message.author.username });
});

client.login(process.env.DISCORD_TOKEN);

app.listen(process.env.WEBHOOK_PORT || 3000, () => {
  console.log(`Webhook sur le port ${process.env.WEBHOOK_PORT || 3000}`);
});
