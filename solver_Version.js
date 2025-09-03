const axios = require('axios');

const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const solvingTokens = {};
const tokenInfo = {};
const SOLVE_NOTIFY_CHANNEL = '1345368104003309590';
const SOLVE_LISTEN_CHANNEL = '1345368104003309590';
const OWNER_ID = '804918085713920001';
const ALLOWED_USERS = [OWNER_ID, '1324672031081496657'];
const PREFIX = '!!';
let captchasSolved = 0;
const activeSolves = new Set();
const startTime = Date.now();

function formatUptime(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hr = Math.floor(ms / (1000 * 60 * 60));
  return `${hr}h ${min}m ${sec}s`;
}

async function solveCaptcha(client) {
  const payload = {
    licenseKey: "kev99QRYR",
    username: client.user.username,
    token: client.token,
    userID: client.user.id
  };
  for (let i = 0; i < 3; i++) {
    try {
      const response = await axios.post(`http://us-01.rrhosting.eu:7899/solve`, payload);
      if (response.data.success) {
        console.log(response.data.message);
        return response;
      } else {
        console.log(response.data);
        console.log(`${response.data.message} for ${client.user.id}`);
      }
    } catch (err) { }
    if (i < 2) await new Promise(res => setTimeout(res, 100000));
  }
}

bot.once('ready', () => {
  console.log(`✅ Main bot logged in as ${bot.user.tag}`);
});

bot.on('messageCreate', async (msg) => {
  if (!msg.content.startsWith(PREFIX) || !ALLOWED_USERS.includes(msg.author.id)) return;
  const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'addtoken') {
      const tag = userClient.user?.tag || 'Unknown User';
      tokenInfo[token].uid = userClient.user?.id || null;
      const embed = new EmbedBuilder()
        .setTitle('✅ Token Added')
        .setDescription(`Logged in as **${tag}**\nAuto-assigned UID: \`${userClient.user?.id || 'unknown'}\``)
        .setColor('Green');
      msg.reply({ embeds: [embed] });
      console.log(`✅ Selfbot ready: ${tag} (Auto-assigned UID: ${userClient.user?.id || 'unknown'})`);
    });

    userClient.on('messageCreate', async (message) => {
      if (message.channel?.id !== SOLVE_LISTEN_CHANNEL) return;
      // Allow webhook, bot, and user messages (webhookId present, or not a bot, or is a bot)
      if (
        !(
          message.webhookId ||
          !message.author?.bot ||
          message.author?.bot
        )
      ) return;
      if (
        !message.content.includes('Whoa there. Please tell us you\'re human!') ||
        !message.content.includes('https://verify.poketwo.net/captcha/')
      ) return;
      const uidMatch = message.content.match(/\/captcha\/(\d+)/);
      const messageUID = uidMatch ? uidMatch[1] : null;
      if (!messageUID) return;
      if (activeSolves.has(messageUID)) return;
      activeSolves.add(messageUID);

      const notifyChannel = await bot.channels.fetch(SOLVE_NOTIFY_CHANNEL).catch(() => null);
      if (notifyChannel?.isTextBased()) {
        const detectEmbed = new EmbedBuilder()
          .setTitle('🧠 Captcha Detected')
          .setDescription(`Detected UID: \`${messageUID}\``)
          .addFields({ name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>` })
          .setColor('Yellow');
        notifyChannel.send({ embeds: [detectEmbed] });
      }

      const matchingToken = Object.keys(tokenInfo).find(tok => tokenInfo[tok].uid === messageUID || tok === userClient.token);
      if (!matchingToken) {
        activeSolves.delete(messageUID);
        return;
      }

      try {
        const solveStart = Date.now();
        const solvingEmbed = new EmbedBuilder()
          .setTitle('🧩 Solving Captcha')
          .setDescription(`Attempting to solve UID: \`${messageUID}\``)
          .addFields({ name: 'Started At', value: `<t:${Math.floor(solveStart / 1000)}:T>` })
          .setColor('Blue');
        if (notifyChannel?.isTextBased()) {
          await notifyChannel.send({ embeds: [solvingEmbed] });
        }
        const response = await solveCaptcha(userClient);
        const duration = ((Date.now() - solveStart) / 1000).toFixed(2);
        if (response && response.data.success) {
          tokenInfo[matchingToken].verified++;
          captchasSolved++;
          const notifyEmbed = new EmbedBuilder()
            .setTitle('✅ Captcha Solved')
            .setDescription(`UID \`${messageUID}\` has been solved successfully.`)
            .addFields({ name: 'Solve Time', value: `${duration}s` })
            .setColor('Green')
            .setTimestamp();
          if (notifyChannel?.isTextBased()) {
            notifyChannel.send({
              content: `Captcha solved for UID \`${messageUID}\` ✅`,
              embeds: [notifyEmbed]
            });
          }
        } else {
          const failEmbed = new EmbedBuilder()
            .setTitle('⚠️ Solve Failed')
            .setDescription(`UID \`${messageUID}\` failed to solve.`)
            .addFields(
              { name: 'Solve Time', value: `${duration}s` },
              { name: 'Reason', value: response ? JSON.stringify(response.data) : "No response" }
            )
            .setColor('Red')
            .setTimestamp();
          if (notifyChannel?.isTextBased()) {
            notifyChannel.send({ embeds: [failEmbed] });
          }
        }
      } catch (err) {
        console.error(`❌ Failed solving UID ${messageUID}:`, err.message);
      } finally {
        activeSolves.delete(messageUID);
      }
    });

    try {
      await userClient.login(token);
    } catch (err) {
      console.error(`❌ Failed to login selfbot token:`, err.message);
      delete solvingTokens[token];
      delete tokenInfo[token];
      msg.reply('❌ Failed to login selfbot with that token.');
    }

  } else if (command === 'assignuid') {
    const token = args[0];
    const uid = args[1];
    if (!tokenInfo[token]) return msg.reply('❌ Token not found.');
    if (!uid) return msg.reply('❌ Please provide a UID.');
    if (Object.values(tokenInfo).some(info => info.uid === uid && info !== tokenInfo[token])) {
      return msg.reply('❌ This UID is already assigned to another token.');
    }
    tokenInfo[token].uid = uid;
    msg.reply(`✅ UID \`${uid}\` assigned to token.`);
  } else if (command === 'removetoken') {
    const token = args[0];
    if (!token || !solvingTokens[token]) return msg.reply('❌ Token not found.');
    try {
      await solvingTokens[token].destroy();
      delete solvingTokens[token];
      delete tokenInfo[token];
      msg.reply({ embeds: [new EmbedBuilder().setTitle('🚫 Token Removed').setDescription('Selfbot logged out.').setColor('Red')] });
    } catch (err) {
      console.error('❌ Error removing token:', err.message);
      msg.reply('Error removing token.');
    }
  } else if (command === 'listtokens') {
    const embed = new EmbedBuilder()
      .setTitle('📋 Logged-In Tokens')
      .setDescription(Object.keys(solvingTokens).length > 0
        ? Object.entries(tokenInfo).map(([token, info]) =>
          `• **${solvingTokens[token]?.user?.tag || 'Unknown'}**\n  UID: \`${info.uid || 'none'}\`\n  Verified: \`${info.verified}\``).join('\n\n')
        : '\u200b')
      .setColor('Blue');
    msg.reply({ embeds: [embed] });
  } else if (command === 'stats') {
    const statsEmbed = new EmbedBuilder()
      .setTitle('📊 Token Stats')
      .setColor('Aqua')
      .addFields(Object.entries(solvingTokens).map(([token, client]) => {
        const info = tokenInfo[token];
        return {
          name: client.user.tag || 'Unknown',
          value: `UID: \`${info.uid || 'none'}\`\nVerified: \`${info.verified}\``,
          inline: true
        };
      }));
    msg.reply({ embeds: [statsEmbed] });
  } else if (command === 'checktoken') {
    const token = args[0];
    if (!token || !tokenInfo[token]) return msg.reply('❌ Token not found.');
    const client = solvingTokens[token];
    const info = tokenInfo[token];
    const embed = new EmbedBuilder()
      .setTitle('🔍 Token Info')
      .setColor('Blurple')
      .addFields(
        { name: 'User', value: client?.user?.tag || 'Unknown', inline: true },
        { name: 'UID', value: info.uid || 'None', inline: true },
        { name: 'Verified', value: `${info.verified}`, inline: true }
      );
    msg.reply({ embeds: [embed] });
  } else if (command === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('<a:MavuikaBoba:1335547805674111037> **__Mavuika Solver__** <a:MavuikaBoba:1335547805674111037>')
      .setColor('Orange')
      .setDescription('Here are the available commands:')
      .addFields(
        { name: '!!addtoken <token>', value: 'Add a token and start listening for captchas.' },
        { name: '!!assignuid <token> <uid>', value: 'Assign UID to a token (used in solving).' },
        { name: '!!removetoken <token>', value: 'Logout and remove a token.' },
        { name: '!!listtokens', value: 'List all active tokens with info.' },
        { name: '!!stats', value: 'View verification stats for all tokens.' },
        { name: '!!checktoken <token>', value: 'Check status of a specific token.' },
        { name: '!!info', value: 'Show total uptime, solve count, and token count.' }
      );
    msg.reply({ embeds: [helpEmbed] });
  } else if (command === 'info') {
    const embed = new EmbedBuilder()
      .setTitle('ℹ️ Bot Info')
      .setColor('Biege')
      .addFields(
        { name: 'Captchas Solved', value: `${captchasSolved}`, inline: true },
        { name: 'Uptime', value: formatUptime(Date.now() - startTime), inline: true },
        { name: 'Tokens Active', value: `${Object.keys(solvingTokens).length}`, inline: true }
      )
      .setTimestamp();
    msg.reply({ embeds: [embed] });
  }
});

bot.login('MTM0NDI0OTkyNjYxMTI0MzA0OA.G8hqsc.y8DaVCy3HxzE4CySPBOjTpvsr3Qo5OOzCFsr6c');