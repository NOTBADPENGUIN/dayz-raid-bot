# DayZ Raid Alert Bot

Bot Discord qui alerte votre serveur en temps réel lors d'un raid DayZ — message embed, alerte vocale et appel téléphonique via Twilio.

## Fonctionnalités

- **Alerte Discord** — embed rouge avec localisation, heure et joueur détecté
- **Alerte vocale** — le bot rejoint le salon vocal occupé et joue un son d'alarme
- **Appel téléphonique** — appel automatique via Twilio (optionnel)
- **Webhook HTTP** — déclenche une alerte depuis n'importe quel outil externe (RaidAlarm, script, etc.)
- **Cooldown** — une seule alerte par minute pour éviter le spam

## Prérequis

- [Node.js](https://nodejs.org) v18+
- Un bot Discord avec les intents `Guilds`, `GuildVoiceStates`, `GuildMembers`, `GuildMessages`, `MessageContent`
- FFmpeg (inclus via `ffmpeg-static`)
- Un compte [Twilio](https://twilio.com) (optionnel, pour les appels)

## Installation

```bash
git clone https://github.com/NOTBADPENGUIN/dayz-raid-bot.git
cd dayz-raid-bot
npm install
```

Copiez le fichier d'exemple et remplissez vos valeurs :

```bash
cp .env.example .env
```

Ajoutez votre fichier audio d'alarme :
```
alert.mp3.mp3   # placez votre fichier audio ici
```

## Configuration

Éditez le fichier `.env` avec vos informations :

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Token du bot Discord |
| `GUILD_ID` | ID de votre serveur Discord |
| `ALERT_CHANNEL_ID` | ID du salon texte pour les alertes |
| `WEBHOOK_PORT` | Port du serveur HTTP (défaut : 3000) |
| `WEBHOOK_SECRET` | Secret optionnel pour sécuriser le webhook |
| `TWILIO_SID` | SID du compte Twilio (optionnel) |
| `TWILIO_TOKEN` | Token d'auth Twilio (optionnel) |
| `TWILIO_FROM` | Numéro Twilio émetteur (optionnel) |
| `PHONE_NUMBERS` | Numéros à appeler, séparés par des virgules (optionnel) |

## Lancement

```bash
npm start
```

## Déclencher une alerte manuellement

Envoyez une requête POST au webhook :

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"location": "Elektro", "player": "MonPseudo"}'
```

Ou envoyez un message dans le salon `ALERT_CHANNEL_ID` sur Discord.

## Permissions du bot Discord

Le bot nécessite les permissions suivantes :
- Lire les messages
- Envoyer des messages / embeds
- Mentionner @everyone
- Se connecter aux salons vocaux
- Parler dans les salons vocaux
