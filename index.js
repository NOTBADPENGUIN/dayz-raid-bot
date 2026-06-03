require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const express = require('express');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

// Nécessaire pour le chiffrement vocal Discord
try { require('sodium'); } catch(e) {
  try { require('libsodium-wrappers'); } catch(e2) {
    console.warn('⚠️ Sodium non trouvé, la connexion vocale peut échouer. Lance : npm install sodium');
  }
}

process.env.FFMPEG_PATH = ffmpegPath;

const COOLDOWN_MS = (parseInt(process.env.COOLDOWN_SECONDS) || 60) * 1000;

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

app.post('/webhook', async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  console.log('🚨 Raid détecté via POST !', body);
  await triggerRaidAlert(body);
});

async function logToDiscord(guild, message) {
  if (!process.env.LOG_CHANNEL_ID) return;
  const logChannel = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (logChannel) {
    await logChannel.send(message).catch(() => {});
  }
}

async function triggerRaidAlert(data) {
  const maintenant = Date.now();
  const tempsRestant = COOLDOWN_MS - (maintenant - dernierRaid);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;

  if (tempsRestant > 0) {
    const secondes = Math.ceil(tempsRestant / 1000);
    console.log(`⏳ Cooldown actif, alerte ignorée. (${secondes}s restantes)`);
    await logToDiscord(guild, `⏳ Alerte ignorée — cooldown actif (**${secondes}s** restantes)`);
    return;
  }
  dernierRaid = maintenant;

  const channel = guild.channels.cache.get(process.env.ALERT_CHANNEL_ID);

  if (channel) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚨 RAID EN COURS !')
      .setDescription('Un raid a été détecté sur le serveur !')
      .addFields(
        { name: '📍 Localisation', value: data.location || 'Inconnue', inline: true },
        { name: '⏰ Heure', value: new Date().toLocaleTimeString('fr-FR'), inline: true },
        { name: '👤 Détecté par', value: data.player || 'Raid Alarm', inline: true }
      )
      .setTimestamp();

    await channel.send({ content: '@everyone **RAID ALERT !**', embeds: [embed] });
  }

  await logToDiscord(guild, `🚨 **Raid déclenché** — Localisation : \`${data.location || 'Inconnue'}\` — Joueur : \`${data.player || 'Raid Alarm'}\` — <t:${Math.floor(maintenant / 1000)}:T>`);

  await discordVoiceAlert(guild);

  if (process.env.TWILIO_SID) {
    await phoneCallAlert();
  }
}

async function discordVoiceAlert(guild) {
  if (voiceAlertActive) {
    console.log('⏳ Alerte vocale déjà en cours, ignorée.');
    return;
  }
  voiceAlertActive = true;

  try {
    const voiceChannel = guild.channels.cache.find(
      ch => ch.isVoiceBased() && ch.members.size > 0
    );

    if (!voiceChannel) {
      console.log('Aucun salon vocal occupé trouvé');
      voiceAlertActive = false;
      return;
    }

    console.log(`🔊 Connexion au salon : ${voiceChannel.name}`);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    // Attendre que la connexion soit vraiment prête avant de jouer
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log('✅ Connexion vocale prête.');
    } catch (err) {
      console.error('❌ Connexion vocale échouée :', err.message);
      voiceAlertActive = false;
      connection.destroy();
      return;
    }

    const player = createAudioPlayer();
    const audioPath = path.resolve(__dirname, 'alert.mp3');
    console.log(`🎵 Lecture de : ${audioPath}`);

    const resource = createAudioResource(audioPath, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume?.setVolume(1);

    connection.subscribe(player);
    player.play(resource);

    // Ne déconnecter QUE quand le player passe de Playing → Idle (fin réelle)
    player.on('stateChange', (oldState, newState) => {
      console.log(`🔄 État audio : ${oldState.status} → ${newState.status}`);
      if (
        oldState.status === AudioPlayerStatus.Playing &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        console.log('✅ Audio terminé, déconnexion.');
        voiceAlertActive = false;
        connection.destroy();
      }
    });

    player.on('error', err => {
      console.error('❌ Erreur audio:', err.message);
      voiceAlertActive = false;
      connection.destroy();
    });

    // Sécurité : reset après 5 minutes max
    setTimeout(() => {
      if (voiceAlertActive) {
        console.log('⚠️ Timeout sécurité, déconnexion forcée.');
        voiceAlertActive = false;
        try { connection.destroy(); } catch (e) {}
      }
    }, 300000);

  } catch (err) {
    voiceAlertActive = false;
    console.error('Erreur appel vocal Discord:', err.message);
  }
}

async function phoneCallAlert() {
  const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  const numbers = process.env.PHONE_NUMBERS.split(',');

  for (const num of numbers) {
    try {
      await twilio.calls.create({
        twiml: '<Response><Say language="fr-FR" voice="alice">Alerte raid sur votre serveur DayZ. Un raid est en cours. Connectez-vous immédiatement.</Say></Response>',
        to: num.trim(),
        from: process.env.TWILIO_FROM,
      });
      console.log(`📞 Appel envoyé à ${num}`);
    } catch (err) {
      console.error(`Erreur appel ${num}:`, err.message);
    }
  }
}

client.once('ready', () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return;
  if (message.channelId !== process.env.ALERT_CHANNEL_ID) return;

  // Commande !status
  if (message.content.trim() === '!status') {
    const maintenant = Date.now();
    const tempsRestant = COOLDOWN_MS - (maintenant - dernierRaid);
    const cooldownActif = tempsRestant > 0;

    const embed = new EmbedBuilder()
      .setColor(cooldownActif ? 0xFFA500 : 0x00FF00)
      .setTitle('📊 Statut du bot')
      .addFields(
        { name: '🤖 Bot', value: 'En ligne ✅', inline: true },
        { name: '🔊 Alerte vocale', value: voiceAlertActive ? 'En cours ⚠️' : 'Inactive ✅', inline: true },
        {
          name: '⏳ Cooldown',
          value: cooldownActif
            ? `Actif — ${Math.ceil(tempsRestant / 1000)}s restantes`
            : 'Inactif — prêt',
          inline: true
        },
        {
          name: '🕐 Dernier raid',
          value: dernierRaid > 0
            ? `<t:${Math.floor(dernierRaid / 1000)}:R>`
            : 'Aucun depuis le démarrage',
          inline: true
        },
        { name: '⏱️ Cooldown configuré', value: `${COOLDOWN_MS / 1000}s`, inline: true }
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
    return;
  }

  // Commande !test
  if (message.content.trim() === '!test') {
    await message.reply('🧪 Lancement d\'une alerte de test...');
    await triggerRaidAlert({
      location: 'Test',
      player: message.author.username
    });
    return;
  }

  // Tout autre message déclenche l'alerte
  console.log(`📨 Message détecté de : ${message.author.username} — "${message.content}"`);
  await triggerRaidAlert({
    location: 'Détecté via message Discord',
    player: message.author.username
  });
});

client.login(process.env.DISCORD_TOKEN);

app.listen(process.env.WEBHOOK_PORT, () => {
  console.log(`🌐 Serveur webhook sur le port ${process.env.WEBHOOK_PORT}`);
});
