/**
 * Kyogre Modern Staff Salary Management & PokéTwo Market Bot
 * - Points are now cleared in autopay() exactly when the selfbot clicks the Confirm button.
 * - No clearing of points in the !claim command handler anymore.
 * - All logic for updating points and database is inside the CONFIRM button click block.
 * - Other commands remain unchanged.
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const config = require('./config.json');
const { logEvent, logToConsole } = require('./log.js');
const Database = require('better-sqlite3');

// ====== DATABASE SETUP ======
const db = new Database('messages.db');
db.prepare(`
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id TEXT PRIMARY KEY,
    messages INTEGER NOT NULL,
    points INTEGER NOT NULL
  )
`).run();

// ====== AUTOPAY STATE ======
let autopayEnabled = true;

// ====== CONSTANTS ======
const PREFIX = '!';
const OWNER_PREFIX = '$';
const MESSAGE_LIMIT = 4;
const SPAM_TIMEFRAME = 5 * 1000;
const POINTS_THRESHOLD = 100;
const BONUS_THRESHOLD = 1000;
const BONUS_POINTS = 5;
const POKECOINS_PER_POINT = 75000;
const LOG_COLOR = '#FFD700';
const MAIN_COLOR = '#5865F2';
const ERROR_COLOR = '#ED4245';
const COIN_EMOJI = '🪙';
const POINT_EMOJI = '⭐';
const BAR_LENGTH = 20;

// ====== CLIENT SETUP ======
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});
const selfbotClient = new SelfbotClient();

// ====== RUNTIME DATA STORAGE ======
const monitoredChannelId = { id: null };
const logChannelId = { id: config.log_channel_id || null };
// Cache for in-memory fast access
const messageCounts = new Collection();
const userPoints = new Collection();
const userTimestamps = new Collection();
const recentMessages = new Collection();

// ====== DATABASE HELPERS ======
function dbGetUserStats(userId) {
    return db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(userId);
}
function dbSetUserStats(userId, messages, points) {
    db.prepare(`
        INSERT INTO user_stats (user_id, messages, points)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            messages = excluded.messages,
            points = excluded.points
    `).run(userId, messages, points);
}
function dbResetUserStats(userId) {
    db.prepare('DELETE FROM user_stats WHERE user_id = ?').run(userId);
}
function dbGetAllUserStats() {
    return db.prepare('SELECT * FROM user_stats').all();
}

// ====== PERMISSION HELPERS ======
function isOwner(userId) {
    return Array.isArray(config.owner_ids) && config.owner_ids.includes(userId);
}
function hasAllowedRole(member) {
    if (!member || !member.roles || !config.allowed_role_id) return false;
    return member.roles.cache.has(config.allowed_role_id);
}
function checkPermission(member, authorId) {
    return isOwner(authorId) || hasAllowedRole(member);
}

// ====== UTILITY FUNCTIONS ======
function formatNumber(num) { return num.toLocaleString(); }
function getProgressBar(current, total, length = BAR_LENGTH) {
    const percent = Math.min(current / total, 1);
    const filled = Math.round(percent * length);
    return `\`${'█'.repeat(filled)}${'░'.repeat(length - filled)}\` ${formatNumber(current)}/${formatNumber(total)}`;
}
function getMedal(index) {
    switch (index) {
        case 0: return '🥇';
        case 1: return '🥈';
        case 2: return '🥉';
        default: return `${index + 1}.`;
    }
}
function calculateTotalPoints(msgCount) {
    const basePoints = Math.floor(msgCount / POINTS_THRESHOLD);
    const bonusPoints = Math.floor(msgCount / BONUS_THRESHOLD) * BONUS_POINTS;
    return basePoints + bonusPoints;
}

// ====== SYNC DB TO MEMORY ON STARTUP ======
function syncDbToMemory() {
    const all = dbGetAllUserStats();
    messageCounts.clear();
    userPoints.clear();
    for (const {user_id, messages, points} of all) {
        messageCounts.set(user_id, messages);
        userPoints.set(user_id, points);
    }
}
syncDbToMemory();

// ====== DATA CLEANUP ======
setInterval(() => {
    const now = Date.now();
    for (const [userId, timestamps] of userTimestamps) {
        userTimestamps.set(userId, timestamps.filter(ts => now - ts < SPAM_TIMEFRAME));
    }
    for (const [userId, msgs] of recentMessages) {
        recentMessages.set(userId, msgs.filter(msg => now - msg.createdTimestamp < 5 * 60 * 1000));
    }
    logToConsole('Ran data cleanup.');
}, 10 * 60 * 1000);

// ====== AUTOPAY LOGIC (reset points on actual confirmation) ======
async function autopay(user, marketId, pokecoinsAmount, message) {
    if (!autopayEnabled) {
        await message.reply({ embeds: [new EmbedBuilder().setDescription('⚠️ Autopay is currently **disabled** by the owner.').setColor(ERROR_COLOR)] });
        return false;
    }
    return new Promise(async (resolve) => {
        try {
            const selfbotChannelId = config.selfbot_location.channel_id;
            const poketwoUserId = config.poketwo_user_id;
            const selfbotChannel = await selfbotClient.channels.fetch(selfbotChannelId);
            if (!selfbotChannel) {
                await message.reply('❌ Internal error: Selfbot channel not found.');
                return resolve(false);
            }
            const cmdMsg = await selfbotChannel.send(`<@${poketwoUserId}> m b ${marketId}`);
            let resolved = false;
            const collector = selfbotChannel.createMessageCollector({
                filter: m => m.author.id === poketwoUserId,
                time: 30000
            });
            collector.on('collect', async poketwoMessage => {
                if (poketwoMessage.reference && poketwoMessage.reference.messageId === cmdMsg.id) {
                    const content = poketwoMessage.content;
                    if (content.includes('I could not find that market listing') || content.includes('You do not have enough Pokécoins')) {
                        await message.reply(`❌ Pokétwo error: ${content}`);
                        collector.stop('poketwo_error');
                        if (!resolved) { resolved = true; resolve(false); }
                        return;
                    }
                    const match = content.match(/for\s+\*{1,2}([\d,]+)\*{1,2}\s+pokécoins/i);
                    if (match) {
                        const poketwoAmount = parseInt(match[1].replace(/,/g, ''), 10);
                        if (poketwoAmount !== pokecoinsAmount) {
                            await message.reply(`❌ Pokétwo price (${formatNumber(poketwoAmount)}) does not match your claim amount (${formatNumber(pokecoinsAmount)}).`);
                            collector.stop('mismatch');
                            if (!resolved) { resolved = true; resolve(false); }
                            return;
                        }
                    } else {
                        await message.reply('❌ Could not verify Pokétwo price.');
                        collector.stop('parse_error');
                        if (!resolved) { resolved = true; resolve(false); }
                        return;
                    }
                    if (poketwoMessage.components.length > 0) {
                        const buttonRow = poketwoMessage.components[0];
                        const confirmButton = buttonRow.components.find(c => c.label === 'Confirm');
                        if (confirmButton) {
                            try {
                                await poketwoMessage.clickButton(confirmButton.customId);
                                collector.stop('success');
                                // ==== CLEAR USER DATA HERE ====
                                userPoints.set(user.id, 0);
                                dbSetUserStats(user.id, messageCounts.get(user.id) || 0, 0);
                                // Optionally: messageCounts.set(user.id, 0);
                                await message.reply('✅ Pokécoins claim processed successfully!');
                                if (!resolved) { resolved = true; resolve(true); }
                                return;
                            } catch (err) {
                                await message.reply('❌ Failed to confirm the purchase.');
                                collector.stop('fail');
                                if (!resolved) { resolved = true; resolve(false); }
                                return;
                            }
                        }
                    }
                }
            });
            collector.on('end', (collected, reason) => {
                if (!resolved) { resolved = true; resolve(false); }
            });
        } catch (error) {
            await message.reply('❌ Error during autopay.');
            return resolve(false);
        }
    });
}

// ====== MAIN EVENT: MESSAGE MONITORING & ANTI-SPAM ======
client.on('messageCreate', async message => {
    try {
        if (message.author.bot) return;

        // ... OWNER COMMANDS and others omitted for brevity (keep your originals) ...

        // --- COMMANDS ---
        if (!message.content.startsWith(PREFIX)) return;
        const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        if (command === 'claim') {
            const userId = message.author.id;
            const currentPoints = userPoints.get(userId) || 0;
            if (currentPoints < 1) {
                return message.reply({ embeds: [new EmbedBuilder().setDescription('❌ You have no points to claim!').setColor(ERROR_COLOR)] })
                    .then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
            }
            const marketId = args[0];
            if (!marketId) return message.reply('Please provide your Market ID: `!claim <market_id>`').then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
            const pokecoins = currentPoints * POKECOINS_PER_POINT;
            // -- autopay will handle the userPoints/dbSetUserStats reset inside the confirm button click --
            await autopay(message.author, marketId, pokecoins, message);
            return;
        }

        // ...all other command logic remains unchanged...
        if (command === 'help') {
            const helpMenu = new StringSelectMenuBuilder()
                .setCustomId('select-help')
                .setPlaceholder('Choose a help topic')
                .addOptions([
                    { label: 'User Commands', value: 'u', emoji: '👤', description: 'How to use the bot as a user' },
                    { label: 'Admin Commands', value: 'a', emoji: '🛡️', description: 'Admin-only commands' },
                    { label: 'Owner Commands', value: 'o', emoji: '👑', description: 'Bot owner commands' },
                    { label: 'Points System', value: 'p', emoji: '⭐', description: 'How points and pokecoins work' }
                ]);
            const menuRow = new ActionRowBuilder().addComponents(helpMenu);
            const embed = new EmbedBuilder()
                .setTitle('📖 Kyogre Help Menu')
                .setDescription('Select a topic below to view more information.')
                .setColor(MAIN_COLOR);
            await message.channel.send({ embeds: [embed], components: [menuRow] });
            return;
        }

        // ...rest of your commands (leaderboard, stats, etc.) here...
    } catch (err) {
        logToConsole('Error in message handler:', err);
        try {
            await message.reply({ embeds: [new EmbedBuilder().setDescription('⚠️ An error occurred.').setColor(ERROR_COLOR)] });
        } catch {}
    }
});

// ====== INTERACTION HANDLER FOR HELP DROPDOWN ======
client.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId === 'select-help') {
        let desc = '';
        switch (interaction.values[0]) {
            case 'u':
                desc = [
                    '**User Commands**',
                    '• 💰 `!claim <market_id>` — Claim Pokecoins for your points',
                    '• 🏆 `!leaderboard messages` / `!lb messages` — Top message senders',
                    '• 🥅 `!leaderboard points` / `!lb points` — Top points earners',
                    '• 📊 `!stats` — View your own stats & progress',
                    '• 📊 `!stats @user` — View stats for another user',
                    '• 🆔 `!myid` — Get your Discord user ID'
                ].join('\n');
                break;
            case 'a':
                desc = [
                    '**Admin Commands**',
                    '• #⃣ `!setchannel` — Set this channel for monitoring',
                    '• 📝 `!setlogchannel` — Set this channel for logging',
                    '• ♻️ `!reset @user` — Reset all data for a user'
                ].join('\n');
                break;
            case 'o':
                desc = [
                    '**Owner Commands**',
                    '• 🛠️ `$addmessages @user <number>` — Add messages to a user (adjusts points)',
                    '• 🛠️ `$addpoints @user <number>` — Add points to a user (auto-sets min messages)',
                    '• 🔌 `!autopay on/off` — Enable or disable autopay for all users'
                ].join('\n');
                break;
            case 'p':
                desc = [
                    '**Points System**',
                    `⭐ 1 point per 100 messages`,
                    `🪙 Each point = 75,000 Pokecoins`,
                    `🎁 5 bonus points for every 1000 messages!`,
                    `❗ Claim via \`!claim <market_id>\``
                ].join('\n');
                break;
        }
        await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('Help').setDescription(desc).setColor(MAIN_COLOR)] });
    }
});

// ====== READY EVENTS ======
client.on('ready', () => {
    logToConsole(`Kyogre Salary Management Bot online as ${client.user.tag}`);
});
selfbotClient.on('ready', () => {
    logToConsole(`Selfbot logged in as ${selfbotClient.user.tag}`);
});
client.on('error', (err) => logToConsole('Client error:', err));
client.on('warn', (warn) => logToConsole('Client warn:', warn));

client.login(config.bot_token);
selfbotClient.login(config.selfbot_token);