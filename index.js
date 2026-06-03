require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { spawn } = require('child_process');
const express = require('express');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

try { require('sodium'); } catch(e) {
  try { require('libsodium-wrappers'); } catch(e2) {
    console.warn('Sodium non trouve. Lance : npm install sodium');
  }
}

process.env.FFMPEG_PATH = ffmpegPath;

const COOLDOWN_MS = (parseInt(process.env.COOLDOWN_SECONDS) || 60) * 1000;
const RAID_ALARM_ROLE_ID = process.env.RAID_ALARM_ROLE_ID;
const DM_INTERVAL_MS = 15000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const app = express();
app.use(express.json());

let dernierRaid = 0;
let voiceAlertActive = false;
let dmSpamInterval = null;

const joueursEnLigne = new Set();

app.post('/webhook', async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  await triggerRaidAlert(body);
});

async function logToDiscord(guild, message) {
  if (!process.env.LOG_CHANNEL_ID) return;
  const logChannel = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (logChannel) await logChannel.send(message).catch(() => {});
}

async function envoyerDMsRaid(guild, data) {
  if (!RAID_ALARM_ROLE_ID) return;
  await guild.members.fetch();
  const membres = guild.members.cache.filter(m =>
    m.roles.cache.has(RAID_ALARM_ROLE_ID) && !m.user.bot
  );
  for (const [id, membre] of membres) {
    if (joueursEnLigne.has(id)) continue;
    try {
      await membre.send(
        `RAID EN COURS !\nLocalisation : ${data.location || 'Inconnue'}\nDetecte par : ${data.player || 'Raid Alarm'}\nHeure : ${new Date().toLocaleTimeString('fr-FR')}\n\nTape !joue dans le salon raid pour arreter ces notifications.`
      );
    } catch (e) {
      console.log(`Impossible d envoyer DM a ${membre.user.username}`);
    }
  }
}

function demarrerSpamDM(data) {
  stopperSpamDM();
  dmSpamInterval = setInterval(async () => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;
    await envoyerDMsRaid(guild, data);
  }, DM_INTERVAL_MS);
}

function stopperSpamDM() {
  if (dmSpamInterval) {
    clearInterval(dmSpamInterval);
    dmSpamInterval = null;
  }
}

async function triggerRaidAlert(data) {
  const maintenant = Date.now();
  const tempsRestant = COOLDOWN_MS - (maintenant - dernierRaid);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;

  if (tempsRestant > 0) {
    const secondes = Math.ceil(tempsRestant / 1000);
    console.log(`Cooldown actif (${secondes}s restantes)`);
    await logToDiscord(guild, `Alerte ignoree, cooldown actif (${secondes}s restantes)`);
    return;
  }
  dernierRaid = maintenant;

  const channel = guild.channels.cache.get(process.env.ALERT_CHANNEL_ID);
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

  await logToDiscord(guild, `Raid declenche — ${data.location || 'Inconnue'} — ${data.player || 'Raid Alarm'}`);
  await envoyerDMsRaid(guild, data);
  demarrerSpamDM(data);
  await discordVoiceAlert(guild);

  if (process.env.TWILIO_SID) {
    await phoneCallAlert();
  }
}

async function discordVoiceAlert(guild) {
  if (voiceAlertActive) return;
  voiceAlertActive = true;

  try {
    const voiceChannel = guild.channels.cache.find(
      ch => ch.isVoiceBased() && ch.members.size > 0
    );

    if (!voiceChannel) {
      voiceAlertActive = false;
      return;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      voiceAlertActive = false;
      connection.destroy();
      return;
    }

    const player = createAudioPlayer();
    const audioPath = path.resolve(__dirname, 'alert.mp3');
    const ffmpeg = spawn(ffmpegPath, ['-i', audioPath, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(1);
    ffmpeg.stderr.on('data', d => console.log('ffmpeg:', d.toString().trim()));

    connection.subscribe(player);
    player.play(resource);

    player.on('error', err => {
      voiceAlertActive = false;
      connection.destroy();
    });

    setTimeout(() => {
      voiceAlertActive = false;
      try { connection.destroy(); } catch (e) {}
    }, 60000);

  } catch (err) {
    voiceAlertActive = false;
  }
}

async function phoneCallAlert() {
  const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  const numbers = process.env.PHONE_NUMBERS.split(',');
  for (const num of numbers) {
    try {
      await twilio.calls.create({
        twiml: '<Response><Say language="fr-FR" voice="alice">Alerte raid sur votre serveur DayZ. Un raid est en cours. Connectez-vous immediatement.</Say></Response>',
        to: num.trim(),
        from: process.env.TWILIO_FROM,
      });
    } catch (err) {
      console.error(`Erreur appel ${num}:`, err.message);
    }
  }
}

client.once('ready', () => {
  console.log(`Bot connecte : ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return;
  if (message.channelId !== process.env.ALERT_CHANNEL_ID) return;

  const cmd = message.content.trim().toLowerCase();

  if (cmd === '!joue') {
    joueursEnLigne.add(message.author.id);
    await message.reply(`${message.author.username} est en ligne — DMs desactives. Tape !offline quand tu pars.`);
    return;
  }

  if (cmd === '!offline') {
    joueursEnLigne.delete(message.author.id);
    await message.reply(`${message.author.username} est hors ligne — tu recevras les alertes DM au prochain raid.`);
    return;
  }

  if (cmd === '!status') {
    const maintenant = Date.now();
    const tempsRestant = COOLDOWN_MS - (maintenant - dernierRaid);
    const cooldownActif = tempsRestant > 0;
    const embed = new EmbedBuilder()
      .setColor(cooldownActif ? 0xFFA500 : 0x00FF00)
      .setTitle('Statut du bot')
      .addFields(
        { name: 'Bot', value: 'En ligne', inline: true },
        { name: 'Alerte vocale', value: voiceAlertActive ? 'En cours' : 'Inactive', inline: true },
        { name: 'Cooldown', value: cooldownActif ? `${Math.ceil(tempsRestant / 1000)}s restantes` : 'Pret', inline: true },
        { name: 'Dernier raid', value: dernierRaid > 0 ? `<t:${Math.floor(dernierRaid / 1000)}:R>` : 'Aucun', inline: true },
        { name: 'Joueurs en ligne', value: `${joueursEnLigne.size} (DMs desactives)`, inline: true }
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (cmd === '!test') {
    await message.reply('Lancement alerte de test...');
    await triggerRaidAlert({ location: 'Test', player: message.author.username });
    return;
  }

  await triggerRaidAlert({ location: 'Detecte via message Discord', player: message.author.username });
});

client.login(process.env.DISCORD_TOKEN);

app.listen(process.env.WEBHOOK_PORT, () => {
  console.log(`Serveur webhook sur le port ${process.env.WEBHOOK_PORT}`);
});
