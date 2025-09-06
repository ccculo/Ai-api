/**
 * Poketwo Captcha Solver API with Discord bot for API key management, solve limits, and multi-token support.
 *
 * Features:
 * - Discord bot command (!genkey) generates an API key (up to 70,000 solves, no time expiry).
 * - Each API key can be used with multiple Discord user tokens.
 * - Each solve deducts from the key's remaining solves.
 * - Selfbot solves Poketwo captchas and authorizes them as before.
 *
 * Dependencies:
 *   npm install express puppeteer discord.js-selfbot-v13 discord.js axios crypto
 */

const express = require('express');
const puppeteer = require('puppeteer');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');

const API_PORT = 8000;
const NEXTCAPTCHA_API_KEY = 'next_f0cbbff92735399d23e80e9ff316f5ca48'; // <-- Updated NextCaptcha key
const POKETWO_BOT_ID = '716390085896962058';
const KEY_GEN_BOT_TOKEN = 'MTQwNTc0MTIxMjMwMzg4NDQ0MA.GWfs14.K2YTvMl1HMfnSMUJCiBtt2I-PyCEk31PlQcack';
const KEY_NOTIFY_CHANNEL = '1410152232069890169'; // <-- Updated channel ID
const MAX_SOLVES_PER_KEY = 70000;

const app = express();
app.use(express.json());

// In-memory API key management
// Structure: key -> { discordId, solvesLeft, tokens: Set }
const validApiKeys = new Map();

/**
 * Discord bot for API key generation.
 */
const keyBot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

keyBot.once('ready', () => {
  console.log(`KeyBot logged in as ${keyBot.user.tag}`);
});

keyBot.on('messageCreate', async (msg) => {
  if (!msg.content.startsWith('!genkey')) return;
  if (msg.channel.id !== KEY_NOTIFY_CHANNEL) return;

  const key = crypto.randomBytes(16).toString('hex');
  validApiKeys.set(key, {
    discordId: msg.author.id,
    solvesLeft: MAX_SOLVES_PER_KEY,
    tokens: new Set()
  });

  await msg.reply(`Your API access key:\n\`${key}\`\nLimit: ${MAX_SOLVES_PER_KEY} solves\nNo time limit. This key lasts until solves are exhausted or deleted.`);
});

keyBot.login(KEY_GEN_BOT_TOKEN);

/**
 * Helper: Solve reCAPTCHA v2 using NextCaptcha
 */
async function solveRecaptcha(siteKey, url) {
  const taskResp = await axios.post('https://api.nextcaptcha.com/tasks', {
    clientKey: NEXTCAPTCHA_API_KEY,
    task: {
      type: 'RecaptchaV2TaskProxyless',
      websiteURL: url,
      websiteKey: siteKey
    }
  });

  const taskId = taskResp.data.taskId;
  if (!taskId) throw new Error('Failed to create NextCaptcha task');

  for (let i = 0; i < 24; i++) {
    await new Promise(res => setTimeout(res, 5000));
    const resultResp = await axios.post('https://api.nextcaptcha.com/tasks/get', {
      clientKey: NEXTCAPTCHA_API_KEY,
      taskId
    });
    if (resultResp.data.status === 'ready') {
      return resultResp.data.solution.gRecaptchaResponse;
    }
  }
  throw new Error('Timeout waiting for captcha solve');
}

/**
 * Helper: Puppeteer flow for captcha solve and Discord OAuth2
 */
async function solveAndAuthorize({ captchaUrl, userToken }) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-gpu', '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0'
  });

  // 1. Visit captcha page and bypass Cloudflare
  await page.goto(captchaUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // 2. Extract recaptcha sitekey
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  });
  if (!siteKey) {
    await browser.close();
    throw new Error('Sitekey not found on captcha page');
  }

  // 3. Solve recaptcha
  const captchaToken = await solveRecaptcha(siteKey, captchaUrl);

  // 4. Submit captcha token
  await page.evaluate((token) => {
    document.querySelector('textarea[name="g-recaptcha-response"]').value = token;
    document.querySelector('form').submit();
  }, captchaToken);

  // 5. Wait for redirect to Discord OAuth2 page
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

  // 6. Discord OAuth2 page: inject token for login (if not already logged in)
  const url = page.url();
  if (url.includes('discord.com/login')) {
    await page.evaluate((token) => {
      window.localStorage.setItem('token', `"${token}"`);
    }, userToken);

    // Reload to apply token
    await page.goto('https://discord.com/oauth2/authorize?client_id=716390085896962058&redirect_uri=https%3A%2F%2Fverify.poketwo.net%2Fapi%2Fcallback&response_type=code&scope=identify&state=092eca2ce812fcc6e8e3c929b981a5d6185c0f4965c11bce05d7b79d571acf59', { waitUntil: 'networkidle2', timeout: 60000 });
  }

  // 7. Click the "Authorize" button
  await page.waitForSelector('button[type="submit"],button[aria-label="Authorize"]', { timeout: 15000 });
  await page.evaluate(() => {
    const authBtn = document.querySelector('button[type="submit"],button[aria-label="Authorize"]');
    if (authBtn) authBtn.click();
  });

  // 8. Wait for confirmation or redirect back to Poketwo
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

  const finalUrl = page.url();
  await browser.close();

  return { success: true, message: 'Captcha solved and authorized', redirect: finalUrl };
}

/**
 * Discord selfbot clients per token (to allow multiple tokens at once)
 */
const clients = {}; // token -> discord client

/**
 * POST /api/solve
 * Body: { apiKey: key, token: Discord user token, uid: captcha UID }
 */
app.post('/api/solve', async (req, res) => {
  const { apiKey, token, uid } = req.body;
  if (!apiKey || !token || !uid) return res.status(400).json({ success: false, message: 'Missing apiKey, token, or uid' });

  const keyEntry = validApiKeys.get(apiKey);
  if (!keyEntry) return res.status(403).json({ success: false, message: 'Invalid API key.' });
  if (keyEntry.solvesLeft <= 0) return res.status(403).json({ success: false, message: 'Solve limit reached for this API key.' });

  // Add token to key's set
  keyEntry.tokens.add(token);

  // Launch or reuse selfbot for this token
  let client = clients[token];
  if (!client) {
    client = new SelfbotClient();
    clients[token] = client;
    try {
      await client.login(token);
    } catch (err) {
      delete clients[token];
      return res.status(401).json({ success: false, message: 'Discord login failed: ' + err.message });
    }
  }

  let solved = false;

  client.on('messageCreate', async (message) => {
    if (solved) return;
    if (message.author.id === POKETWO_BOT_ID && message.content.includes('https://verify.poketwo.net/captcha/')) {
      const match = message.content.match(/\/captcha\/(\d+)/);
      const messageUID = match ? match[1] : null;
      if (messageUID && messageUID === uid) {
        solved = true;
        const captchaUrl = `https://verify.poketwo.net/captcha/${uid}`;
        try {
          const result = await solveAndAuthorize({ captchaUrl, userToken: token });
          keyEntry.solvesLeft -= 1;
          res.json({ ...result, uid, solvesLeft: keyEntry.solvesLeft });
        } catch (err) {
          res.json({ success: false, message: err.message });
        }
        // Don't destroy client, keep for multi-token support
      }
    }
  });

  // Timeout if not found in 3 minutes
  setTimeout(() => {
    if (!solved) {
      res.json({ success: false, message: 'Captcha link not found for UID within time limit' });
      // Don't destroy client (multi-token support)
    }
  }, 180000);
});

/**
 * Simple health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(API_PORT, () => {
  console.log(`Poketwo Captcha Solver API running on port ${API_PORT}`);
});