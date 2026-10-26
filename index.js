// PLAY POINT QUEST HUB — Ultimate Final Code (Custom Price Text)

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const { BOT_TOKEN, ADMIN_CHAT_ID, SUPPORT_USERNAME = "", BKASH_NUMBER = "", NAGAD_NUMBER = "", ADMIN_WHATSAPP = "" } = process.env;
const ADMIN_ID = Number(ADMIN_CHAT_ID);
const REQUIRED_CHANNEL = "@google_play_point_01";
const DB_FILE = process.env.DB_FILE || "./quest_hub.sqlite";

if (!BOT_TOKEN || !Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  console.error("ERROR: Set BOT_TOKEN and numeric ADMIN_CHAT_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ===== Error Logging Setup =====
const errorLogPath = path.join(__dirname, 'error.log');
if (!fs.existsSync(errorLogPath)) fs.writeFileSync(errorLogPath, '');

function logError(error) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${error.stack || error.message || error}\n\n`;
  fs.appendFileSync(errorLogPath, logMessage);
  console.error(error);
  safeNotify(ADMIN_ID, `⚠️ <b>বটে একটি এরর হয়েছে!</b>\n\n<code>${esc(logMessage.slice(0, 500))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
}

process.on('uncaughtException', (err) => logError(err));
process.on('unhandledRejection', (reason) => logError(reason));

// ===== Database Setup =====
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
  is_banned INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, coupon INTEGER NOT NULL,
  qty INTEGER DEFAULT 1, amount INTEGER NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED','REJECTED')),
  delivery_method TEXT, delivery_info TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS quests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, screenshot TEXT NOT NULL, gmail TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')),
  reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, completed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, action TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS support_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, message TEXT, reply TEXT, status TEXT DEFAULT 'OPEN', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, replied_at TEXT);
CREATE TABLE IF NOT EXISTS sell_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL,
  coupon INTEGER NOT NULL CHECK(coupon IN (4,5,10,20,25)),
  qty INTEGER NOT NULL CHECK(qty > 0), amount INTEGER NOT NULL CHECK(amount > 0),
  gmail TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT,
  FOREIGN KEY(uid) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS bins (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bin_number TEXT NOT NULL, bank_name TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS us_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, address_text TEXT NOT NULL,
  added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, api_key TEXT NOT NULL,
  added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const defaultSettings = [
  ['rules_text', '📖 <b>RULES & REGULATIONS</b>\n\n1️⃣ সঠিক তথ্য জমা দিন।\n2️⃣ Admin যাচাই করার পরই সার্ভিস দেওয়া হবে।\n3️⃣ PIN, OTP বা পাসওয়ার্ড কারও সাথে শেয়ার করবেন না।\n4️⃣ Coupon-এর দাম Admin নিশ্চিত করবেন।'],
  ['support_text', '💬 Support-এর জন্য Admin-কে মেসেজ করুন।'],
  ['buy_price_4', '0'], ['buy_price_val_4', '0'], ['stock_4', '0'], ['buy_status_4', '1'],
  ['buy_price_5', '0'], ['buy_price_val_5', '0'], ['stock_5', '0'], ['buy_status_5', '1'],
  ['buy_price_10', '0'], ['buy_price_val_10', '0'], ['stock_10', '0'], ['buy_status_10', '1'],
  ['buy_price_20', '0'], ['buy_price_val_20', '0'], ['stock_20', '0'], ['buy_status_20', '1'],
  ['buy_price_25', '0'], ['buy_price_val_25', '0'], ['stock_25', '0'], ['buy_status_25', '1'],
  ['sell_price_4', '0'], ['sell_price_val_4', '0'], ['sell_status_4', '1'],
  ['sell_price_5', '0'], ['sell_price_val_5', '0'], ['sell_status_5', '1'],
  ['sell_price_10', '0'], ['sell_price_val_10', '0'], ['sell_status_10', '1'],
  ['sell_price_20', '0'], ['sell_price_val_20', '0'], ['sell_status_20', '1'],
  ['sell_price_25', '0'], ['sell_price_val_25', '0'], ['sell_status_25', '1'],
  ['card_make_price', '0']
];
defaultSettings.forEach(([k, v]) => db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)").run(k, v));

// ===== Helpers =====
const sessions = new Map();
const fmt = (paisa = 0) => `৳${(Number(paisa || 0) / 100).toFixed(2)}`;
const toPaisa = v => Math.round(Number(v) * 100);
const isAdmin = id => Number(id) === ADMIN_ID;
const esc = v => String(v ?? "").replace(/[&<>"]/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[ch]));
const displayName = u => `${u.first_name || ""}${u.username ? ` (@${u.username})` : ""}`.trim() || String(u.id);
const getSetting = key => db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
const setSetting = (key, value) => db.prepare("UPDATE settings SET value=? WHERE key=?").run(value, key);
const logAdmin = (action) => db.prepare("INSERT INTO admin_logs(admin_id, action) VALUES(?,?)").run(ADMIN_ID, action);

// বাংলা সংখ্যা থেকে ইংরেজি সংখ্যা
function toEnglishDigits(str) {
  const bengali = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
  const english = ['0','1','2','3','4','5','6','7','8','9'];
  return String(str).replace(/[০-৯]/g, d => english[bengali.indexOf(d)]);
}

// স্মার্ট নাম্বার এক্সট্রাক্টর
function parseSmartMoney(text) {
  let clean = toEnglishDigits(text).toLowerCase();
  clean = clean.replace(/(tk|taka|৳|\$|bdt)/gi, '');

  const wordMap = {
    'zero': '0', 'shunno': '0', 'শূন্য': '0',
    'one': '1', 'ek': '1', 'এক': '1',
    'two': '2', 'dui': '2', 'দুই': '2',
    'three': '3', 'tin': '3', 'তিন': '3',
    'four': '4', 'char': '4', 'চার': '4',
    'five': '5', 'panch': '5', 'পাঁচ': '5',
    'six': '6', 'choy': '6', 'ছয়': '6',
    'seven': '7', 'shat': '7', 'সাত': '7',
    'eight': '8', 'aat': '8', 'আট': '8',
    'nine': '9', 'noy': '9', 'নয়': '9',
    'ten': '10', 'dosh': '10', 'দশ': '10',
    'twenty': '20', 'bish': '20', 'বিশ': '20',
    'fifty': '50', 'ponchash': '50', 'পঞ্চাশ': '50',
    'hundred': '100', 'shoto': '100', 'শত': '100'
  };

  for (const [word, num] of Object.entries(wordMap)) {
    clean = clean.split(word).join(num);
  }

  const match = clean.match(/(\d+(\.\d{1,2})?)/);
  if (!match) return null;

  const v = Number(match[0]);
  if (!Number.isFinite(v) || v <= 0 || v > 100000) return null;
  return toPaisa(v);
}

function parseSmartInteger(text) {
  let clean = toEnglishDigits(text).toLowerCase();
  clean = clean.replace(/(tk|taka|৳|\$|bdt|pcs|pice|ta)/gi, '');
  
  const wordMap = {
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
    'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
    'ek': '1', 'dui': '2', 'tin': '3', 'char': '4', 'panch': '5',
    'choy': '6', 'shat': '7', 'aat': '8', 'noy': '9', 'dosh': '10',
    'এক': '1', 'দুই': '2', 'তিন': '3', 'চার': '4', 'পাঁচ': '5',
    'ছয়': '6', 'সাত': '7', 'আট': '8', 'নয়': '9', 'দশ': '10'
  };

  for (const [word, num] of Object.entries(wordMap)) {
    clean = clean.split(word).join(num);
  }

  const match = clean.match(/\d+/);
  if (!match) return null;
  return parseInt(match[0], 10);
}

function ensureUser(user) {
  db.prepare(`INSERT INTO users(id,name,username) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username`)
    .run(user.id, user.first_name || "", user.username || "");
}
async function safeNotify(chatId, text, options = {}) {
  try { await bot.sendMessage(chatId, text, options); return true; }
  catch (err) { return false; }
}
function sendAdmin(text, reply_markup) {
  return safeNotify(ADMIN_ID, text, { parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) });
}

async function sequentialDelete(chatId, msgIds, delay = 300) {
  if (!Array.isArray(msgIds)) msgIds = [msgIds];
  for (let i = 0; i < msgIds.length; i++) {
    if (msgIds[i]) {
      await bot.deleteMessage(chatId, msgIds[i]).catch(() => {});
      if (i < msgIds.length - 1) await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function editAndAutoDelete(chatId, messageId, newText, delayMs = 5000, editOptions = {}) {
  try { await bot.editMessageText(newText, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", ...editOptions }); } catch (e) {}
  setTimeout(() => { bot.deleteMessage(chatId, messageId).catch(() => {}); }, delayMs);
}

// ===== Card Generation =====
function luhnCheckDigit(partial) {
  let sum = 0, alt = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let n = parseInt(partial[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return (10 - (sum % 10)) % 10;
}
function generateCardNumber(bin) {
  const remaining = 15 - bin.length;
  if (remaining < 0) return null;
  let random = '';
  for (let i = 0; i < remaining; i++) random += Math.floor(Math.random() * 10);
  const partial = bin + random;
  return partial + luhnCheckDigit(partial);
}
function parseBinInput(text) {
  const cleanText = toEnglishDigits(text);
  if (!cleanText.startsWith('.gen ')) return null;
  const parts = cleanText.slice(5).trim().split(/[\s\/]+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) return null;
  const bin = parts[0];
  if (!/^\d{4,15}$/.test(bin)) return null;
  let mm = null, yy = null;
  if (parts.length >= 2) {
    if (!/^\d{1,2}$/.test(parts[1])) return null;
    mm = parts[1].padStart(2, '0');
    if (parseInt(mm, 10) < 1 || parseInt(mm, 10) > 12) return null;
  }
  if (parts.length >= 3) {
    if (!/^\d{2,4}$/.test(parts[2])) return null;
    yy = parts[2].slice(-2);
  }
  return { bin, mm, yy };
}

// ===== Force Join =====
async function checkMembership(userId) {
  if (isAdmin(userId)) return true;
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) { return false; }
}
function sendJoinPrompt(chatId) {
  return bot.sendMessage(chatId, "⚠️ <b>বট ব্যবহার করতে হলে আপনাকে আমাদের চ্যানেলে জয়েন করতে হবে।</b>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "📢 চ্যানেলে জয়েন করুন", url: "https://t.me/google_play_point_01" }], [{ text: "✅ চেক করুন", callback_data: "check_join" }]] }
  }).catch(() => {});
}

// ===== Keyboards =====
const getHome = (uid) => {
  const keyboard = [
    [{ text: "🚀 রিস্টার্ট বট" }, { text: "🎮 কুপন সার্ভিস" }],
    [{ text: "🔢 BIN নাম্বার" }, { text: "💳 কার্ড মেক" }],
    [{ text: "🇺🇸 USA এড্রেস" }, { text: "🤖 AI অ্যাসিস্ট্যান্ট" }],
    [{ text: "🎯 কুইস্ট কমপ্লিট" }, { text: "💬 সাপোর্ট" }],
    [{ text: "📞 হোয়াটসঅ্যাপ" }, { text: "📖 নিয়মাবলী" }]
  ];
  if (isAdmin(uid)) keyboard.push([{ text: "🛠 অ্যাডমিন প্যানেল" }]);
  return { reply_markup: { keyboard, resize_keyboard: true } };
};
const MENU_BUTTONS = new Set(["🚀 রিস্টার্ট বট","🎮 কুপন সার্ভিস","🔢 BIN নাম্বার","💳 কার্ড মেক","🇺🇸 USA এড্রেস","🤖 AI অ্যাসিস্ট্যান্ট","🎯 কুইস্ট কমপ্লিট","💬 সাপোর্ট","📞 হোয়াটসঅ্যাপ","📖 নিয়মাবলী","🛠 অ্যাডমিন প্যানেল"]);

function adminPanel(chatId) {
  return bot.sendMessage(chatId, "🛠 <b>অ্যাডমিন কন্ট্রোল প্যানেল</b>\n\n━━━━━━━━━━━━━━━━━━\n<i>আপনি নিচের অপশনগুলো থেকে যেকোনো কিছু ম্যানেজ করতে পারেন।</i>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📊 পরিসংখ্যান", callback_data: "admin:stats" }, { text: "📣 ব্রডকাস্ট", callback_data: "admin:broadcast" }],
      [{ text: "🎮 কুপন ম্যানেজমেন্ট", callback_data: "admin:coupon_control" }, { text: "🛒 পেন্ডিং অর্ডার", callback_data: "list:orders" }],
      [{ text: "🎯 পেন্ডিং কুইস্ট", callback_data: "list:quests" }, { text: "🆘 সাপোর্ট ইনবক্স", callback_data: "list:support" }],
      [{ text: "👥 ইউজার লিস্ট", callback_data: "list:users" }, { text: "🚫 ব্যান/আনব্যান", callback_data: "admin:ban" }],
      [{ text: "🔢 BIN ম্যানেজমেন্ট", callback_data: "admin:bins" }, { text: "🇺🇸 USA এড্রেস", callback_data: "admin:us_addresses" }],
      [{ text: "🤖 AI API Key", callback_data: "admin:ai_keys" }, { text: "📝 টেক্সট এডিট", callback_data: "admin:texts" }],
      [{ text: "📦 ডেটাবেজ ব্যাকআপ", callback_data: "admin:backup" }, { text: "📜 অ্যাডমিন লগ", callback_data: "list:logs" }],
      [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "panel:close" }]
    ]}
  }).catch(() => {});
}

// ===== Start Command Handler =====
async function handleStart(msg) {
  if (!msg.from?.id) return;
  const uid = msg.from.id;
  if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
  
  const user = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
  if (user?.is_banned) return bot.sendMessage(uid, "🚫 আপনাকে বট থেকে ব্যান করা হয়েছে।").catch(() => {});

  ensureUser(msg.from);
  sessions.delete(uid);
  
  if (msg.message_id) bot.deleteMessage(uid, msg.message_id).catch(() => {});

  const startText = `🌟 <b>আসসালামু আলাইকুম, ${esc(msg.from.first_name || "বন্ধু")}!</b> 🌟\n\n` +
    `✨ <b>Play Point Quest Hub</b>-এ আপনাকে স্বাগতম!\n` +
    `আমরা দিচ্ছি ১০০% বিশ্বস্ত ও দ্রুত সার্ভিস।\n\n` +
    `👇 <i>নিচের মেনু থেকে আপনার পছন্দের সার্ভিসটি বেছে নিন।</i>`;

  bot.sendMessage(uid, startText, { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
}

bot.onText(/^\/start(@\w+)?$/, handleStart);
bot.onText(/^\/menu(@\w+)?$/, handleStart);

bot.onText(/^\/admin(@\w+)?$/, msg => {
  if (isAdmin(msg.from.id)) {
    bot.deleteMessage(msg.from.id, msg.message_id).catch(() => {});
    return adminPanel(msg.chat.id);
  }
});

bot.onText(/^\/backup(@\w+)?$/, async msg => {
  if (!isAdmin(msg.from.id)) return;
  bot.deleteMessage(msg.from.id, msg.message_id).catch(() => {});
  try {
    await bot.sendDocument(msg.chat.id, DB_FILE, { caption: "📦 <b>ডেটাবেজ ব্যাকআপ</b>", parse_mode: "HTML" });
  } catch (err) {
    logError(err);
    bot.sendMessage(msg.chat.id, "❌ ব্যাকআপ পাঠাতে সমস্যা হয়েছে।").catch(() => {});
  }
});

bot.onText(/^\/cancel(@\w+)?$/, msg => {
  bot.deleteMessage(msg.from.id, msg.message_id).catch(() => {});
  sessions.delete(msg.from.id);
  bot.sendMessage(msg.from.id, "✅ <b>প্রক্রিয়াটি বাতিল হয়েছে।</b>", { parse_mode: "HTML", ...getHome(msg.from.id) })
    .then(m => setTimeout(() => bot.deleteMessage(msg.from.id, m.message_id).catch(() => {}), 3000)).catch(() => {});
});

// ===== Message Handler =====
bot.on("message", async msg => {
  if (!msg.from?.id || msg.from.is_bot) return;
  const uid = msg.from.id;
  const rawText = msg.text ? msg.text.trim() : "";
  const text = toEnglishDigits(rawText);

  try {
    if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
    
    const dbUser = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
    if (dbUser?.is_banned && !isAdmin(uid)) return bot.sendMessage(uid, "🚫 আপনাকে ব্যান করা হয়েছে।").catch(() => {});
    
    ensureUser(msg.from);
    const session = sessions.get(uid);

    // Broadcast
    if (rawText.startsWith("/broadcast ") && isAdmin(uid)) {
      const bMsg = rawText.slice(11);
      if (!bMsg) return bot.sendMessage(uid, "⚠️ মেসেজটি খালি। ব্যবহার: <code>/broadcast আপনার মেসেজ</code>", { parse_mode: "HTML" }).catch(() => {});
      
      const users = db.prepare("SELECT id FROM users WHERE is_banned=0").all();
      const notif = await bot.sendMessage(uid, `⏳ <b>${users.length} জন ইউজারকে মেসেজ পাঠানো হচ্ছে...</b>`, { parse_mode: "HTML" }).catch(() => {});
      
      let count = 0;
      for (const u of users) {
        try {
          await bot.sendMessage(u.id, bMsg, { parse_mode: "HTML", ...getHome(u.id) });
          count++;
          await new Promise(r => setTimeout(r, 50));
        } catch (e) {}
      }
      if (notif) bot.deleteMessage(uid, notif.message_id).catch(() => {});
      return bot.sendMessage(uid, `✅ <b>সফলভাবে ${count} জনকে মেসেজ পাঠানো হয়েছে।</b>`, { parse_mode: "HTML" }).catch(() => {});
    }

    // Photo Handler
    if (msg.photo) {
      if (session?.step === "quest_screenshot") {
        session.screenshot = msg.photo[msg.photo.length - 1].file_id;
        session.step = "quest_gmail";
        return bot.sendMessage(uid, "✅ <b>স্ক্রিনশট গ্রহণ করা হয়েছে।</b>\n\n📧 <i>এখন আপনার Gmail অ্যাড্রেসটি দিন।</i>", { parse_mode: "HTML" }).catch(() => {});
      }
      if (session?.step === "support_msg") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        db.prepare("INSERT INTO support_tickets(uid, message) VALUES(?, ?)").run(uid, `[Photo] ${fileId}`);
        sendAdmin(`🆘 <b>নতুন সাপোর্ট টিকিট</b>\n👤 ইউজার: <code>${uid}</code>\n📷 ছবি পাঠানো হয়েছে`, {
          inline_keyboard: [[{ text: "💬 রিপ্লাই", callback_data: `support:reply:${uid}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]]
        });
        bot.sendPhoto(ADMIN_ID, fileId).catch(() => {});
        sessions.delete(uid);
        return bot.sendMessage(uid, "✅ <b>আপনার মেসেজটি এডমিনের কাছে পাঠানো হয়েছে।</b>", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      }
      if (session?.step === "admin_reply_support") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(session.targetUid, fileId, { caption: "💬 <b>Admin-এর রিপ্লাই</b>", parse_mode: "HTML" }).catch(() => {});
        db.prepare("UPDATE support_tickets SET status='CLOSED', reply=? WHERE uid=? AND status='OPEN'").run(`[Photo] ${fileId}`, session.targetUid);
        sessions.delete(uid);
        return bot.sendMessage(uid, "✅ <b>রিপ্লাই পাঠানো হয়েছে।</b>", { parse_mode: "HTML" }).catch(() => {});
      }
      return;
    }

    if (!msg.text) return;

    // Menu routes
    if (rawText === "🚀 রিস্টার্ট বট" || rawText === "🔄 Restart Bot" || text.toLowerCase() === "start" || text.toLowerCase() === "menu") {
      return handleStart(msg);
    }

    const isBinFormat = /^\.gen\s+\d{4,15}([\s\/]+\d{1,2}([\s\/]+\d{2,4})?)?$/.test(text);
    const inCardMake = sessions.get(uid)?.step === "card_make_bin";
    if (text.startsWith("/") && !(isBinFormat && inCardMake)) return;

    if (!MENU_BUTTONS.has(rawText)) {
      bot.deleteMessage(uid, msg.message_id).catch(() => {});
    }

    if (MENU_BUTTONS.has(rawText)) {
      sessions.delete(uid);
      if (rawText === "🛠 অ্যাডমিন প্যানেল") { if (isAdmin(uid)) return adminPanel(uid); return; }
      if (rawText === "🎯 কুইস্ট কমপ্লিট") {
        sessions.set(uid, { step: "quest_screenshot" });
        return bot.sendMessage(uid, "🎯 <b>কুইস্ট কমপ্লিট</b>\n\nকুইস্ট সম্পন্ন করতে ১০৳ ফি দিতে হবে।\n\n📸 অ্যাডমিনের নম্বরে ১০৳ পাঠিয়ে পেমেন্টের স্ক্রিনশট এখানে পাঠান।\n\n❌ <i>বাতিল করতে /cancel লিখুন।</i>", { parse_mode: "HTML" }).catch(() => {});
      }
      if (rawText === "🤖 AI অ্যাসিস্ট্যান্ট") {
        const keys = db.prepare("SELECT COUNT(*) as c FROM ai_keys").get().c;
        if (keys === 0) {
          return bot.sendMessage(uid, "⚠️ <b>AI সিস্টেম বর্তমানে বন্ধ আছে।</b>\n\nঅনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।", { parse_mode: "HTML", ...getHome(uid) })
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000)).catch(() => {});
        }
        sessions.set(uid, { step: "ai_prompt" });
        return bot.sendMessage(uid, "🤖 <b>AI অ্যাসিস্ট্যান্ট</b>\n\nআপনি কী জানতে চান? আপনার প্রশ্নটি লিখুন:\n\n❌ <i>বাতিল করতে /cancel লিখুন।</i>", { parse_mode: "HTML" }).catch(() => {});
      }
      if (rawText === "🎮 কুপন সার্ভিস") {
        return bot.sendMessage(uid, "🎮 <b>কুপন সার্ভিস</b>\n\n<i>আপনি কী করতে চান?</i>", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "🛒 কুপন কিনুন (Buy)", callback_data: "coupon_mode:buy" }],
            [{ text: "💰 কুপন বিক্রি করুন (Sell)", callback_data: "coupon_mode:sell" }],
            [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }]
          ]}
        }).catch(() => {});
      }
      if (rawText === "🔢 BIN নাম্বার") {
        const bins = db.prepare("SELECT * FROM bins ORDER BY id DESC LIMIT 30").all();
        if (!bins.length) {
          return bot.sendMessage(uid, "😔 <b>এখনো কোনো BIN আপলোড করা হয়নি।</b>", { parse_mode: "HTML", ...getHome(uid) })
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000)).catch(() => {});
        }
        const lines = bins.map(b => {
          let line = `🔢 <code>${esc(b.bin_number)}</code>`;
          if (b.bank_name) line += `\n┗ 🏦 ${esc(b.bank_name)}`;
          if (b.country) line += ` | 🌍 ${esc(b.country)}`;
          if (b.note) line += `\n📝 <i>${esc(b.note)}</i>`;
          return line;
        });
        return bot.sendMessage(uid, `🔢 <b>BIN নাম্বার সমূহ</b> (মোট: ${bins.length})\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n\n')}`, { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      }
      if (rawText === "💳 কার্ড মেক") {
        sessions.set(uid, { step: "card_make_bin" });
        return bot.sendMessage(uid,
          `💳 <b>কার্ড মেক</b>\n\nএকবারে ১০টি কার্ড তৈরি হবে।\n🎉 সম্পূর্ণ ফ্রি!\n\n` +
          `📝 <b>ফরম্যাট (উদাহরণ):</b>\n` +
          `<code>.gen 2345666</code> → শুধু BIN\n` +
          `<code>.gen 246666 12 34</code> → BIN/মাস/বছর\n\n` +
          `✏️ আপনার BIN পাঠান (বাতিল: /cancel):`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }
      if (rawText === "🇺🇸 USA এড্রেস") {
        const addr = db.prepare("SELECT * FROM us_addresses ORDER BY RANDOM() LIMIT 1").get();
        if (!addr) {
          return bot.sendMessage(uid, "😔 <b>এখনো কোনো USA Address আপলোড করা হয়নি।</b>", { parse_mode: "HTML", ...getHome(uid) })
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000)).catch(() => {});
        }
        return bot.sendMessage(uid, `🇺🇸 <b>USA ফেক এড্রেস</b>\n\n<blockquote expandable>${esc(addr.address_text)}</blockquote>\n\n📋 <i>এড্রেসটি কপি করতে ট্যাপ করুন।</i>`, { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      }
      if (rawText === "📞 হোয়াটসঅ্যাপ") {
        if (!ADMIN_WHATSAPP) return bot.sendMessage(uid, "⚠️ <b>WhatsApp নম্বর সেট করা নেই।</b>\n\nঅনুগ্রহ করে Support-এ মেসেজ দিন।", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
        const waUrl = `https://wa.me/${ADMIN_WHATSAPP.replace(/[^0-9]/g, '')}`;
        return bot.sendMessage(uid, `📞 <b>হোয়াটসঅ্যাপ সাপোর্ট</b>\n\nযেকোনো জরুরি প্রয়োজনে সরাসরি অ্যাডমিনের সাথে যোগাযোগ করুন।`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "💬 হোয়াটসঅ্যাপে মেসেজ দিন", url: waUrl }], [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }]] }
        }).catch(() => {});
      }
      if (rawText === "💬 সাপোর্ট") {
        sessions.set(uid, { step: "support_msg" });
        return bot.sendMessage(uid, `💬 <b>সাপোর্ট সেন্টার</b>\n\n${getSetting('support_text')}\n\n<i>আপনার সমস্যা বিস্তারিত লিখে বা ছবি পাঠিয়ে দিন (বাতিল: /cancel)।</i>`, { parse_mode: "HTML" }).catch(() => {});
      }
      if (rawText === "📖 নিয়মাবলী") {
        return bot.sendMessage(uid, getSetting('rules_text'), { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      }
    }

    // Fallback
    if (!session) {
      return bot.sendMessage(uid, "🤖 <b>আমি আপনার কথা বুঝতে পারিনি।</b>\n\n<i>নিচের মেনু থেকে অপশন বেছে নিন অথবা নতুন করে শুরু করতে 🚀 রিস্টার্ট বট চাপুন।</i>", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
    }

    // AI
    if (session?.step === "ai_prompt") {
      sessions.delete(uid);
      const typingMsg = await bot.sendMessage(uid, "⏳ <b>AI ভাবছে...</b>", { parse_mode: "HTML" }).catch(() => {});
      try {
        const keyRow = db.prepare("SELECT api_key FROM ai_keys ORDER BY RANDOM() LIMIT 1").get();
        if (!keyRow || !keyRow.api_key) {
           if (typingMsg) bot.deleteMessage(uid, typingMsg.message_id).catch(() => {});
           return bot.sendMessage(uid, "❌ <b>অ্যাডমিন প্যানেলে কোনো API Key সেট করা নেই।</b>", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
        }
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${keyRow.api_key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: rawText }] }] })
        });
        const data = await res.json();
        let aiReply = "দুঃখিত, আমি এই মুহূর্তে উত্তর দিতে পারছি না।";
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
           aiReply = data.candidates[0].content.parts[0].text;
        } else if (data.error) {
           aiReply = "API Key-তে সমস্যা আছে। অ্যাডমিনকে জানান।";
        }
        if (typingMsg) bot.deleteMessage(uid, typingMsg.message_id).catch(() => {});
        if (aiReply.length > 4000) aiReply = aiReply.substring(0, 3990) + "...";
        return bot.sendMessage(uid, `🤖 <b>AI উত্তর:</b>\n\n${esc(aiReply)}`, { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      } catch (err) {
        logError(err);
        if (typingMsg) bot.deleteMessage(uid, typingMsg.message_id).catch(() => {});
        return bot.sendMessage(uid, "❌ <b>সার্ভারে সমস্যা হচ্ছে।</b>\n\nঅনুগ্রহ করে একটু পর চেষ্টা করুন।", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      }
    }

    // Card Make
    if (session?.step === "card_make_bin") {
      const parsed = parseBinInput(text);
      if (!parsed) {
        return bot.sendMessage(uid, `❌ <b>ভুল ফরম্যাট।</b>\n\nউদাহরণ:\n<code>.gen 2345666</code>\n<code>.gen 246666 12 34</code>`, { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000)).catch(() => {});
      }
      sessions.delete(uid);
      const cards = [];
      const currentYY = new Date().getFullYear() % 100;
      for (let i = 0; i < 10; i++) {
        const num = generateCardNumber(parsed.bin);
        const mm = parsed.mm || String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
        const yy = parsed.yy || String(currentYY + Math.floor(Math.random() * 6) + 1).padStart(2, '0');
        const cvv = String(Math.floor(Math.random() * 900) + 100);
        cards.push(`${num}|${mm}|${yy}|${cvv}`);
      }
      logAdmin(`User ${uid} generated 10 cards from BIN ${parsed.bin}`);
      return bot.sendMessage(uid,
        `✅ <b>সফলভাবে ১০টি কার্ড তৈরি হয়েছে!</b>\n\n` +
        `📋 <b>ফরম্যাট:</b> <code>NUMBER|MM|YY|CVV</code>\n\n` +
        `<blockquote expandable>${cards.join('\n')}</blockquote>\n\n` +
        `⚠️ <i>কার্ডগুলো কপি করে সঠিকভাবে ব্যবহার করুন।</i>`,
        { parse_mode: "HTML", ...getHome(uid) }
      ).catch(() => {});
    }

    // Buy Flow
    if (session?.step === "buy_qty") {
      const qty = parseSmartInteger(text); 
      if (!qty || qty <= 0 || qty > 100) {
        return bot.sendMessage(uid, "⚠️ <b>সঠিক সংখ্যা লিখুন</b> (যেমন: 1, 2, 5)।", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      }
      const c = session.coupon;
      const total = session.price * qty;
      const waText = encodeURIComponent(`আসসালামু আলাইকুম, আমি ${qty}টি $${c} কুপন কিনতে চাই। (মোট দাম: ৳${total/100})`);
      const waUrl = ADMIN_WHATSAPP ? `https://wa.me/${ADMIN_WHATSAPP.replace(/[^0-9]/g, '')}?text=${waText}` : null;
      sessions.delete(uid);
      
      const msgText = `🛒 <b>কুপন কেনার বিবরণ</b>\n\n🎮 <b>কুপন:</b> $${c}\n📦 <b>পরিমাণ:</b> ${qty} টি\n💵 <b>মোট দাম:</b> <code>${fmt(total)}</code>\n\n👇 <b>কুপন কিনতে নিচের হোয়াটসঅ্যাপ বাটনে ক্লিক করে অ্যাডমিনকে মেসেজ দিন:</b>`;
      const inlineBtns = [];
      if (waUrl) inlineBtns.push([{ text: "📞 হোয়াটসঅ্যাপে মেসেজ দিন", url: waUrl }]);
      else inlineBtns.push([{ text: "⚠️ হোয়াটসঅ্যাপ নম্বর সেট করা নেই", callback_data: "msg:delete" }]);
      inlineBtns.push([{ text: "✅ হ্যাঁ, মেসেজ পাঠিয়েছি", callback_data: "msg:sent" }, { text: "🔙 মেইন মেনু", callback_data: "main_menu" }]);
      
      return bot.sendMessage(uid, msgText, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: inlineBtns } }).catch(() => {});
    }

    // Sell Flow
    if (session?.step === "sell_qty") {
      const qty = parseSmartInteger(text); 
      if (!qty || qty <= 0 || qty > 1000) {
        return bot.sendMessage(uid, "⚠️ <b>সঠিক সংখ্যা লিখুন</b> (যেমন: 1, 2, 5)।", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      }
      session.qty = qty; session.step = "sell_gmail";
      return bot.sendMessage(uid, `📧 <b>কুপনটি যে Gmail-এ রিডিম করা হয়েছে, সেই Gmail দিন:</b>`, { parse_mode: "HTML" }).catch(() => {});
    }
    if (session?.step === "sell_gmail") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return bot.sendMessage(uid, "⚠️ <b>সঠিক Gmail দিন।</b>", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      }
      session.gmail = text; session.step = "sell_pass";
      return bot.sendMessage(uid, `🔑 <b>Gmail-এর পাসওয়ার্ড দিন:</b>`, { parse_mode: "HTML" }).catch(() => {});
    }
    if (session?.step === "sell_pass") {
      const pass = text;
      const total = session.sellPrice * session.qty;
      const waText = encodeURIComponent(`আসসালামু আলাইকুম, আমি ${session.qty}টি $${session.coupon} কুপন বিক্রি করতে চাই।\n\nGmail: ${session.gmail}\nPass: ${pass}\nমোট পাবো: ৳${total/100}`);
      const waUrl = ADMIN_WHATSAPP ? `https://wa.me/${ADMIN_WHATSAPP.replace(/[^0-9]/g, '')}?text=${waText}` : null;
      
      const sellRes = db.prepare("INSERT INTO sell_requests(uid, coupon, qty, amount, gmail, password) VALUES(?,?,?,?,?,?)")
        .run(uid, session.coupon, session.qty, total, session.gmail, pass);
      sessions.delete(uid);
      
      const msgText = `💰 <b>কুপন বিক্রির বিবরণ</b>\n\n🎮 <b>কুপন:</b> $${session.coupon} (${session.qty} টি)\n💵 <b>পাবেন:</b> <code>${fmt(total)}</code>\n\n👇 <b>কুপন বিক্রি করতে নিচের হোয়াটসঅ্যাপ বাটনে ক্লিক করে অ্যাডমিনকে মেসেজ দিন:</b>`;
      const inlineBtns = [];
      if (waUrl) inlineBtns.push([{ text: "📞 হোয়াটসঅ্যাপে মেসেজ দিন", url: waUrl }]);
      else inlineBtns.push([{ text: "⚠️ হোয়াটসঅ্যাপ নম্বর সেট করা নেই", callback_data: "msg:delete" }]);
      inlineBtns.push([{ text: "✅ হ্যাঁ, মেসেজ পাঠিয়েছি", callback_data: "msg:sent" }, { text: "🔙 মেইন মেনু", callback_data: "main_menu" }]);
      
      sendAdmin(`💰 <b>নতুন কুপন বিক্রির রিকোয়েস্ট</b>\n👤 ইউজার: <code>${uid}</code>\n\n🎮 কুপন: $${session.coupon} × ${session.qty}\n💵 পেমেন্ট: <b>${fmt(total)}</b>\n\n📧 <b>Gmail:</b> <code>${esc(session.gmail)}</code>\n🔑 <b>Pass:</b> <code>${esc(pass)}</code>`, {
        inline_keyboard: [[{ text: "✅ অ্যাপ্রুভ", callback_data: `sell:approve:${sellRes.lastInsertRowid}` }, { text: "❌ রিজেক্ট", callback_data: `sell:reject:${sellRes.lastInsertRowid}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]]
      });
      return bot.sendMessage(uid, msgText, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: inlineBtns } }).catch(() => {});
    }

    // Quest Steps
    if (session?.step === "quest_gmail") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return bot.sendMessage(uid, "⚠️ <b>সঠিক Gmail দিন।</b>", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      }
      session.gmail = text; session.step = "quest_password";
      return bot.sendMessage(uid, "🔑 <b>Gmail-এর পাসওয়ার্ড দিন:</b>", { parse_mode: "HTML" }).catch(() => {});
    }
    if (session?.step === "quest_password") {
      session.password = text; session.step = "quest_contact";
      return bot.sendMessage(uid, "📞 <b>যোগাযোগের ফোন নম্বর বা ইমেইল দিন:</b>", { parse_mode: "HTML" }).catch(() => {});
    }
    if (session?.step === "quest_contact") {
      session.contact = text;
      const res = db.prepare(`INSERT INTO quests(uid, screenshot, gmail, password, contact) VALUES(?,?,?,?,?)`).run(uid, session.screenshot, session.gmail, session.password, session.contact);
      const questId = Number(res.lastInsertRowid);
      sessions.delete(uid);
      bot.sendMessage(uid, "✅ <b>কুইস্ট রিকোয়েস্ট গ্রহণ করা হয়েছে।</b>\n\n<i>আমাদের টিম শীঘ্রই আপনার কুইস্ট প্রসেস করবে।</i>", { parse_mode: "HTML", ...getHome(uid) })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000)).catch(() => {});
      bot.sendPhoto(ADMIN_ID, session.screenshot, {
        caption: `🎯 <b>নতুন কুইস্ট #${questId}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\n📧 ${esc(session.gmail)}\n🔑 ${esc(session.password)}\n📞 ${esc(session.contact)}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ অ্যাপ্রুভ", callback_data: `quest:approve:${questId}` }, { text: "❌ রিজেক্ট", callback_data: `quest:reject:${questId}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]] }
      }).catch(() => {});
      return;
    }

    // Support
    if (session?.step === "support_msg") {
      db.prepare("INSERT INTO support_tickets(uid, message) VALUES(?, ?)").run(uid, rawText);
      sendAdmin(`🆘 <b>নতুন সাপোর্ট টিকিট</b>\n👤 ইউজার: <code>${uid}</code>\n💬 ${esc(rawText)}`, { inline_keyboard: [[{ text: "💬 রিপ্লাই", callback_data: `support:reply:${uid}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]] });
      sessions.delete(uid);
      return bot.sendMessage(uid, "✅ <b>আপনার মেসেজটি এডমিনের কাছে পাঠানো হয়েছে।</b>", { parse_mode: "HTML", ...getHome(uid) })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000)).catch(() => {});
    }
    if (session?.step === "admin_reply_support" && isAdmin(uid)) {
      await safeNotify(session.targetUid, `💬 <b>Admin-এর রিপ্লাই:</b>\n\n${esc(rawText)}`, { parse_mode: "HTML", ...getHome(session.targetUid) });
      db.prepare("UPDATE support_tickets SET status='CLOSED', reply=? WHERE uid=? AND status='OPEN'").run(rawText, session.targetUid);
      sessions.delete(uid);
      return bot.sendMessage(uid, "✅ <b>রিপ্লাই পাঠানো হয়েছে।</b>", { parse_mode: "HTML" })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
    }

    // Broadcast (Inline)
    if (session?.step === "broadcast_msg" && isAdmin(uid)) {
      const users = db.prepare("SELECT id FROM users WHERE is_banned=0").all();
      let count = 0;
      let notif = await bot.sendMessage(uid, `⏳ <b>${users.length} জনকে পাঠানো হচ্ছে...</b>`, { parse_mode: "HTML" }).catch(() => {});
      for (const u of users) {
        const ok = await safeNotify(u.id, rawText, { parse_mode: "HTML", ...getHome(u.id) });
        if (ok) count++;
        await new Promise(r => setTimeout(r, 50));
      }
      sessions.delete(uid);
      logAdmin(`Broadcasted message to ${count} users`);
      if (notif) bot.deleteMessage(uid, notif.message_id).catch(() => {});
      return bot.sendMessage(uid, `✅ <b>সফলভাবে ${count} জনকে মেসেজ পাঠানো হয়েছে।</b>`, { parse_mode: "HTML" })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000)).catch(() => {});
    }

    // Admin Set Buy Price
    if (session?.step === "admin_set_buy_price" && isAdmin(uid)) {
      const priceText = rawText.trim(); // যেই লেখা দিবে তাই সেভ হবে
      if (!priceText) {
        return bot.sendMessage(uid, "⚠️ <b>সঠিক দাম বা লেখা দিন।</b>", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      }
      const numericPrice = parseSmartMoney(text) || 0; // হিসাবের জন্য নাম্বার আলাদা করে রাখা
      setSetting(`buy_price_${session.coupon}`, priceText);
      setSetting(`buy_price_val_${session.coupon}`, numericPrice);
      sessions.delete(uid);
      logAdmin(`Updated $${session.coupon} coupon buy price to ${priceText}`);
      const successMsg = await bot.sendMessage(uid, `✅ <b>$${session.coupon} কুপনের কেনার দাম সেট হয়েছে:</b> ${priceText}`, { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // Admin Set Sell Price
    if (session?.step === "admin_set_sell_price" && isAdmin(uid)) {
      const priceText = rawText.trim(); // যেই লেখা দিবে তাই সেভ হবে
      if (!priceText) {
        return bot.sendMessage(uid, "⚠️ <b>সঠিক দাম বা লেখা দিন।</b>", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      }
      const numericPrice = parseSmartMoney(text) || 0;
      setSetting(`sell_price_${session.coupon}`, priceText);
      setSetting(`sell_price_val_${session.coupon}`, numericPrice);
      sessions.delete(uid);
      logAdmin(`Updated $${session.coupon} coupon sell price to ${priceText}`);
      const successMsg = await bot.sendMessage(uid, `✅ <b>$${session.coupon} কুপনের বিক্রির দাম সেট হয়েছে:</b> ${priceText}`, { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // Admin Set Stock
    if (session?.step === "admin_set_stock" && isAdmin(uid)) {
      const stock = parseSmartInteger(text); 
      if (stock === null || stock < 0) {
        return bot.sendMessage(uid, "⚠️ <b>সঠিক সংখ্যা লিখুন।</b>", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      }
      setSetting(`stock_${session.coupon}`, stock);
      sessions.delete(uid);
      logAdmin(`Updated $${session.coupon} coupon stock to ${stock}`);
      const successMsg = await bot.sendMessage(uid, `✅ <b>$${session.coupon} কুপনের স্টক সেট হয়েছে:</b> ${stock}`, { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // Admin Add AI Key
    if (session?.step === "admin_add_ai_key" && isAdmin(uid)) {
      const key = text.trim();
      db.prepare("INSERT INTO ai_keys(api_key, added_by) VALUES(?,?)").run(key, uid);
      sessions.delete(uid);
      logAdmin(`Added new AI key`);
      const successMsg = await bot.sendMessage(uid, `✅ <b>নতুন AI API Key যুক্ত করা হয়েছে।</b>`, { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => { sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300); adminPanel(uid); }, 1000);
      return;
    }

    // Admin Add USA Address
    if (session?.step === "admin_add_us_addr" && isAdmin(uid)) {
      const lines = rawText.split("\n\n").map(l => l.trim()).filter(Boolean);
      let count = 0;
      db.transaction(() => { for (const line of lines) { db.prepare("INSERT INTO us_addresses(address_text, added_by) VALUES(?,?)").run(line, uid); count++; } })();
      sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, `✅ <b>${count}টি USA Address যোগ করা হয়েছে।</b>`, { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => { sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300); adminPanel(uid); }, 1000);
      return;
    }

    // Admin Ban
    if (session?.step === "admin_ban_uid" && isAdmin(uid)) {
      const target = parseSmartInteger(text);
      if (!target) return bot.sendMessage(uid, "❌ <b>সঠিক আইডি দিন।</b>", { parse_mode: "HTML" }).then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      const user = db.prepare("SELECT is_banned FROM users WHERE id=?").get(target);
      if (!user) return bot.sendMessage(uid, "❌ <b>ইউজার পাওয়া যায়নি।</b>", { parse_mode: "HTML" }).then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      const newBanStatus = user.is_banned ? 0 : 1;
      db.prepare("UPDATE users SET is_banned=? WHERE id=?").run(newBanStatus, target);
      sessions.delete(uid);
      logAdmin(`Toggled ban for user ${target} to ${newBanStatus}`);
      const successMsg = await bot.sendMessage(uid, `✅ <b>ইউজার ${target} এখন ${newBanStatus ? '🚫 ব্যান' : '✅ আনব্যান'} করা হয়েছে।</b>`, { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // Admin Edit Texts (রুলস ও সাপোর্ট)
    if (session?.step === "admin_text_rules" && isAdmin(uid)) {
      setSetting("rules_text", rawText); sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, "✅ <b>নিয়মাবলী আপডেট হয়েছে।</b>", { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }
    if (session?.step === "admin_text_support" && isAdmin(uid)) {
      setSetting("support_text", rawText); sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, "✅ <b>সাপোর্ট টেক্সট আপডেট হয়েছে।</b>", { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // Admin Add BINs
    if (session?.step === "admin_add_bins" && isAdmin(uid)) {
      const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean);
      let count = 0;
      db.transaction(() => {
        for (const line of lines) {
          const parts = line.split("|").map(s => s.trim());
          const binNumber = parts[0];
          if (!/^\d{4,15}$/.test(binNumber)) continue;
          db.prepare("INSERT INTO bins(bin_number, bank_name, country, note, added_by) VALUES(?,?,?,?,?)").run(binNumber, parts[1] || "", parts[2] || "", parts[3] || "", uid);
          count++;
        }
      })();
      sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, `✅ <b>${count}টি BIN যোগ করা হয়েছে।</b>`, { parse_mode: "HTML" }).catch(() => {});
      if (successMsg) setTimeout(() => { sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300); adminPanel(uid); }, 1000);
      return;
    }

  } catch (error) { logError(error); }
});

// ===== Callback Handler =====
bot.on("callback_query", async query => {
  if (!query.from?.id) return;
  const uid = query.from.id;
  const data = query.data || "";
  const msgId = query.message?.message_id;
  const chatId = query.message?.chat.id;

  const answer = (text = "", alert = false) => bot.answerCallbackQuery(query.id, { text, show_alert: alert }).catch(() => {});
  const deleteMsg = () => bot.deleteMessage(chatId, msgId).catch(() => {});

  try {
    if (data === "panel:close") { await answer("বন্ধ করা হয়েছে"); return deleteMsg(); }
    if (data === "msg:delete") { await answer("ডিলিট করা হয়েছে"); return deleteMsg(); }
    if (data === "msg:sent") { await answer("ধন্যবাদ! মেসেজটি ডিলিট করা হচ্ছে।"); return deleteMsg(); }
    if (data === "main_menu") {
      await answer(); deleteMsg();
      return bot.sendMessage(uid, "👇 <i>মেইন মেনু থেকে আপনার পছন্দের সার্ভিসটি বেছে নিন।</i>", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
    }

    if (data !== "check_join") {
      if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
    }

    if (data === "check_join") {
      if (await checkMembership(uid)) { 
        await answer("✅ ধন্যবাদ!"); 
        return bot.sendMessage(uid, "✨ <b>স্বাগতম!</b>\n\n<i>আপনি এখন বটের সমস্ত ফিচার ব্যবহার করতে পারবেন।</i>", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {}); 
      }
      return answer("❌ আপনি জয়েন করেননি।", true);
    }

    const dbUser = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
    if (dbUser?.is_banned && !isAdmin(uid)) return answer("🚫 আপনি ব্যানড।", true);
    ensureUser(query.from);

    // Coupon Mode
    if (data === "coupon_mode:buy") {
      const coupons = [4, 5, 10, 20, 25];
      const btns = []; let row = [];
      coupons.forEach(c => {
        if (getSetting(`buy_status_${c}`) === '1') {
          row.push({ text: `$${c}`, callback_data: `buy:coupon:${c}` });
          if (row.length === 2) { btns.push(row); row = []; }
        }
      });
      if (row.length > 0) btns.push(row);
      btns.push([{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]);
      
      await answer(); deleteMsg();
      if (btns.length === 1) return bot.sendMessage(uid, "😔 <b>বর্তমানে কোনো কুপন কেনা যাচ্ছে না।</b>", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      return bot.sendMessage(uid, "🛒 <b>আপনার পছন্দের কুপন নির্বাচন করুন:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } }).catch(() => {});
    }
    if (data === "coupon_mode:sell") {
      const coupons = [4, 5, 10, 20, 25];
      const btns = [];
      coupons.forEach(c => {
        const spText = getSetting(`sell_price_${c}`) || '0';
        if (getSetting(`sell_status_${c}`) === '1' && spText !== '0') {
          btns.push([{ text: `$${c} কুপন — রেট: ${spText}`, callback_data: `sell:coupon:${c}` }]);
        }
      });
      btns.push([{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]);
      
      await answer(); deleteMsg();
      if (btns.length === 1) return bot.sendMessage(uid, "😔 <b>এই মুহূর্তে কোনো কুপন কেনা হচ্ছে না।</b>", { parse_mode: "HTML", ...getHome(uid) }).catch(() => {});
      return bot.sendMessage(uid, "💰 <b>কোন কুপন বিক্রি করতে চান?</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } }).catch(() => {});
    }
    if (data === "coupon_mode:back") {
      await answer(); deleteMsg();
      return bot.sendMessage(uid, "🎮 <b>কুপন সার্ভিস</b>\n\n<i>আপনি কী করতে চান?</i>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "🛒 কুপন কিনুন (Buy)", callback_data: "coupon_mode:buy" }],
          [{ text: "💰 কুপন বিক্রি করুন (Sell)", callback_data: "coupon_mode:sell" }],
          [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }]
        ]}
      }).catch(() => {});
    }

    // Buy/Sell Coupon
    if (data.startsWith("buy:coupon:")) {
      const coupon = Number(data.split(":")[2]);
      const priceText = getSetting(`buy_price_${coupon}`) || '0';
      const priceVal = Number(getSetting(`buy_price_val_${coupon}`)) || 0;
      sessions.set(uid, { step: "buy_qty", coupon: coupon, price: priceVal, displayPrice: priceText });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `🎮 <b>$${coupon} কুপন</b>\n\nদাম: <b>${priceText}</b>\n\n<i>আপনি কতগুলো কুপন কিনতে চান? (শুধু সংখ্যা লিখুন)</i>`, { parse_mode: "HTML" }).catch(() => {});
    }
    if (data.startsWith("sell:coupon:")) {
      const c = Number(data.split(":")[2]);
      const spText = getSetting(`sell_price_${c}`) || '0';
      const spVal = Number(getSetting(`sell_price_val_${c}`)) || 0;
      if (spVal <= 0 && spText === '0') return answer("এই কুপন এখন কেনা হচ্ছে না।", true);
      sessions.set(uid, { step: "sell_qty", coupon: c, sellPrice: spVal, displaySellPrice: spText });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `💰 <b>$${c} কুপন বিক্রি</b>\n\nপ্রতি কুপনের রেট: <b>${spText}</b>\n\n<i>কতটি বিক্রি করতে চান? (শুধু সংখ্যা লিখুন)</i>`, { parse_mode: "HTML" }).catch(() => {});
    }

    // ==========================================
    // ADMIN CALLBACKS
    // ==========================================
    if (!isAdmin(uid)) return answer("শুধু Admin", true);

    if (data === "admin:backup") {
      await answer(); deleteMsg();
      try { await bot.sendDocument(chatId, DB_FILE, { caption: "📦 <b>ডেটাবেজ ব্যাকআপ</b>", parse_mode: "HTML" }).catch(() => {}); }
      catch (err) { logError(err); bot.sendMessage(chatId, "❌ ব্যাকআপ পাঠাতে সমস্যা হয়েছে।").catch(() => {}); }
      return;
    }

    if (data === "admin:coupon_control") {
      await answer(); deleteMsg();
      const btns = [4,5,10,20,25].map(c => {
        const b = getSetting(`buy_status_${c}`) === '1' ? '🟢' : '🔴';
        const s = getSetting(`sell_status_${c}`) === '1' ? '🟢' : '🔴';
        return [{ text: `🎮 $${c} | কেনা: ${b} | বিক্রি: ${s}`, callback_data: `admin:coupon_manage:${c}` }];
      });
      btns.push([{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]);
      return bot.sendMessage(uid, "🎮 <b>কুপন ম্যানেজমেন্ট</b>\n\n<i>যেকোনো কুপনে ক্লিক করে সেটি ম্যানেজ করুন।</i>", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } }).catch(() => {});
    }
    
    if (data.startsWith("admin:coupon_manage:")) {
      const c = Number(data.split(":")[2]);
      const bStat = getSetting(`buy_status_${c}`) === '1' ? '🟢 চালু' : '🔴 বন্ধ';
      const sStat = getSetting(`sell_status_${c}`) === '1' ? '🟢 চালু' : '🔴 বন্ধ';
      const bPrice = getSetting(`buy_price_${c}`) || '0';
      const sPrice = getSetting(`sell_price_${c}`) || '0';
      
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `🎮 <b>$${c} কুপন ম্যানেজমেন্ট</b>\n\n📥 <b>কেনা (Buy):</b> ${bStat}\n💵 <b>কেনার দাম:</b> <code>${bPrice}</code>\n\n📤 <b>বিক্রি (Sell):</b> ${sStat}\n💰 <b>বিক্রির দাম:</b> <code>${sPrice}</code>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: `📥 কেনা ${bStat}`, callback_data: `admin:toggle_buy:${c}` }, { text: "💵 কেনার দাম", callback_data: `admin:set_buy_price:${c}` }],
          [{ text: `📤 বিক্রি ${sStat}`, callback_data: `admin:toggle_sell:${c}` }, { text: "💰 বিক্রির দাম", callback_data: `admin:set_sell_price:${c}` }],
          [{ text: "🔙 পেছনে", callback_data: "admin:coupon_control" }, { text: "🔙 মেইন মেনু", callback_data: "main_menu" }]
        ]}
      }).catch(() => {});
    }
    
    if (data.startsWith("admin:toggle_buy:")) {
      const c = Number(data.split(":")[2]);
      const current = getSetting(`buy_status_${c}`);
      setSetting(`buy_status_${c}`, current === '1' ? '0' : '1');
      await answer(current === '1' ? "কেনা বন্ধ করা হয়েছে" : "কেনা চালু করা হয়েছে");
      
      const bStat = getSetting(`buy_status_${c}`) === '1' ? '🟢 চালু' : '🔴 বন্ধ';
      const sStat = getSetting(`sell_status_${c}`) === '1' ? '🟢 চালু' : '🔴 বন্ধ';
      const bPrice = getSetting(`buy_price_${c}`) || '0';
      const sPrice = getSetting(`sell_price_${c}`) || '0';
      return bot.editMessageText(`🎮 <b>$${c} কুপন ম্যানেজমেন্ট</b>\n\n📥 <b>কেনা (Buy):</b> ${bStat}\n💵 <b>কেনার দাম:</b> <code>${bPrice}</code>\n\n📤 <b>বিক্রি (Sell):</b> ${sStat}\n💰 <b>বিক্রির দাম:</b> <code>${sPrice}</code>`, {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: `📥 কেনা ${bStat}`, callback_data: `admin:toggle_buy:${c}` }, { text: "💵 কেনার দাম", callback_data: `admin:set_buy_price:${c}` }],
          [{ text: `📤 বিক্রি ${sStat}`, callback_data: `admin:toggle_sell:${c}` }, { text: "💰 বিক্রির দাম", callback_data: `admin:set_sell_price:${c}` }],
          [{ text: "🔙 পেছনে", callback_data: "admin:coupon_control" }, { text: "🔙 মেইন মেনু", callback_data: "main_menu" }]
        ]}
      }).catch(() => {});
    }

    if (data.startsWith("admin:toggle_sell:")) {
      const c = Number(data.split(":")[2]);
      const current = getSetting(`sell_status_${c}`);
      setSetting(`sell_status_${c}`, current === '1' ? '0' : '1');
      await answer(current === '1' ? "বিক্রি বন্ধ করা হয়েছে" : "বিক্রি চালু করা হয়েছে");
      
      const bStat = getSetting(`buy_status_${c}`) === '1' ? '🟢 চালু' : '🔴 বন্ধ';
      const sStat = getSetting(`sell_status_${c}`) === '1' ? '🟢 চালু' : '🔴 বন্ধ';
      const bPrice = getSetting(`buy_price_${c}`) || '0';
      const sPrice = getSetting(`sell_price_${c}`) || '0';
      return bot.editMessageText(`🎮 <b>$${c} কুপন ম্যানেজমেন্ট</b>\n\n📥 <b>কেনা (Buy):</b> ${bStat}\n💵 <b>কেনার দাম:</b> <code>${bPrice}</code>\n\n📤 <b>বিক্রি (Sell):</b> ${sStat}\n💰 <b>বিক্রির দাম:</b> <code>${sPrice}</code>`, {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: `📥 কেনা ${bStat}`, callback_data: `admin:toggle_buy:${c}` }, { text: "💵 কেনার দাম", callback_data: `admin:set_buy_price:${c}` }],
          [{ text: `📤 বিক্রি ${sStat}`, callback_data: `admin:toggle_sell:${c}` }, { text: "💰 বিক্রির দাম", callback_data: `admin:set_sell_price:${c}` }],
          [{ text: "🔙 পেছনে", callback_data: "admin:coupon_control" }, { text: "🔙 মেইন মেনু", callback_data: "main_menu" }]
        ]}
      }).catch(() => {});
    }

    if (data.startsWith("admin:set_buy_price:")) {
      const c = Number(data.split(":")[2]);
      const pMsg = await bot.sendMessage(uid, `💵 <b>$${c} কুপনের নতুন কেনার দাম বা নোট লিখুন (যেমন: ১০০ টাকা, 100tk):</b>`, { parse_mode: "HTML" }).catch(() => {});
      if (pMsg) sessions.set(uid, { step: "admin_set_buy_price", coupon: c, lastPromptId: pMsg.message_id });
      await answer(); deleteMsg(); return;
    }
    if (data.startsWith("admin:set_sell_price:")) {
      const c = Number(data.split(":")[2]);
      const pMsg = await bot.sendMessage(uid, `💰 <b>$${c} কুপনের নতুন বিক্রির দাম বা নোট লিখুন (যেমন: ১০০ টাকা, 100tk):</b>`, { parse_mode: "HTML" }).catch(() => {});
      if (pMsg) sessions.set(uid, { step: "admin_set_sell_price", coupon: c, lastPromptId: pMsg.message_id });
      await answer(); deleteMsg(); return;
    }

    if (data === "admin:ai_keys") {
      const keys = db.prepare("SELECT id, api_key FROM ai_keys ORDER BY id DESC").all();
      await answer(); deleteMsg();
      let txt = `🤖 <b>AI API কী সমূহ</b>\n\nমোট Key: ${keys.length}\n\n`;
      if (keys.length) keys.forEach(k => { txt += `🔑 <code>${esc(k.api_key.substring(0, 10))}...${esc(k.api_key.slice(-4))}</code>\n`; });
      return bot.sendMessage(uid, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "➕ নতুন কী যুক্ত করুন", callback_data: "ai_key:add" }], [{ text: "🗑 সব ডিলিট করুন", callback_data: "ai_key:delall" }], [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {});
    }
    if (data === "ai_key:add") {
      const pMsg = await bot.sendMessage(uid, "🤖 <b>নতুন API Key যুক্ত করুন</b>\n\nআপনার API Key (Gemini/OpenAI) লিখুন:", { parse_mode: "HTML" }).catch(() => {});
      if (pMsg) sessions.set(uid, { step: "admin_add_ai_key", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg(); return;
    }
    if (data === "ai_key:delall") { db.prepare("DELETE FROM ai_keys").run(); await answer("সব কী ডিলিট হয়েছে"); return deleteMsg(); }

    if (data === "admin:bins") {
      const c = db.prepare("SELECT COUNT(*) AS n FROM bins").get().n;
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `🔢 <b>BIN ম্যানেজমেন্ট</b>\n\n📊 মোট BIN: <code>${c}</code>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "➕ নতুন BIN যুক্ত করুন", callback_data: "bin:add" }], [{ text: "📋 সব BIN দেখুন", callback_data: "bin:view" }], [{ text: "🗑 সব ডিলিট করুন", callback_data: "bin:delall" }], [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {});
    }
    if (data === "bin:add") {
      const pMsg = await bot.sendMessage(uid, `➕ <b>নতুন BIN যুক্ত করুন</b>\n\nপ্রতি লাইনে একটি BIN:\n<code>BIN</code> অথবা <code>BIN | Bank | Country | Note</code>\n\nউদাহরণ:\n<code>2345666</code>\n<code>246666 | Chase | US | Visa Signature</code>`, { parse_mode: "HTML" }).catch(() => {});
      if (pMsg) sessions.set(uid, { step: "admin_add_bins", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg(); return;
    }
    if (data === "bin:view") {
      const bins = db.prepare("SELECT * FROM bins ORDER BY id DESC LIMIT 30").all();
      await answer(); deleteMsg();
      if (!bins.length) return bot.sendMessage(uid, "কোনো BIN নেই।").then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      for (const b of bins) {
        let txt = `#${b.id} <code>${esc(b.bin_number)}</code>`;
        if (b.bank_name) txt += ` | 🏦 ${esc(b.bank_name)}`;
        if (b.country) txt += ` | 🌍 ${esc(b.country)}`;
        if (b.note) txt += `\n📝 <i>${esc(b.note)}</i>`;
        bot.sendMessage(uid, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🗑 ডিলিট", callback_data: `bin:del:${b.id}` }], [{ text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {});
      }
      return;
    }
    if (data === "bin:delall") { const c = db.prepare("DELETE FROM bins").run().changes; await answer(`${c} টি BIN ডিলিট হয়েছে`); return deleteMsg(); }
    if (data.startsWith("bin:del:")) { db.prepare("DELETE FROM bins WHERE id=?").run(Number(data.split(":")[2])); await answer("ডিলিট হয়েছে"); return deleteMsg(); }

    if (data === "admin:us_addresses") {
      const c = db.prepare("SELECT COUNT(*) AS n FROM us_addresses").get().n;
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `🇺🇸 <b>USA এড্রেস ম্যানেজমেন্ট</b>\n\n📊 মোট Address: <code>${c}</code>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "➕ নতুন এড্রেস যুক্ত করুন", callback_data: "us_addr:add" }], [{ text: "🗑 সব ডিলিট করুন", callback_data: "us_addr:delall" }], [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {});
    }
    if (data === "us_addr:add") {
      const pMsg = await bot.sendMessage(uid, `➕ <b>USA এড্রেস যুক্ত করুন</b>\n\n<i>আপনি একসাথে একাধিক এড্রেস দিতে পারেন। প্রতিটা এড্রেসের মাঝে একটি খালি লাইন (Enter) দিন।</i>\n\nউদাহরণ:\nJohn Doe\n123 Main St, New York, NY 10001\n\nJane Smith\n456 Oak Ave, Los Angeles, CA 90001`, { parse_mode: "HTML" }).catch(() => {});
      if (pMsg) sessions.set(uid, { step: "admin_add_us_addr", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg(); return;
    }
    if (data === "us_addr:delall") { const c = db.prepare("DELETE FROM us_addresses").run().changes; await answer(`${c} টি এড্রেস ডিলিট হয়েছে`); return deleteMsg(); }

    if (data.startsWith("sell:approve:") || data.startsWith("sell:reject:")) {
      const [, action, rid] = data.split(":");
      const res = db.transaction(() => {
        const s = db.prepare("SELECT * FROM sell_requests WHERE id=? AND status='PENDING'").get(rid);
        if (!s) return { err: 1 };
        if (action === "approve") { const curStock = Number(getSetting(`stock_${s.coupon}`)); setSetting(`stock_${s.coupon}`, curStock + s.qty); }
        db.prepare("UPDATE sell_requests SET status=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(action === "approve" ? "APPROVED" : "REJECTED", uid, rid);
        return { s };
      })();
      if (res.err) return answer("রিভিউ করা হয়েছে", true);
      await answer("সম্পন্ন"); logAdmin(`Sell #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Sell #${rid} অ্যাপ্রুভড</b>` : `❌ <b>Sell #${rid} রিজেক্টেড</b>`);
      safeNotify(res.s.uid, action === "approve" ? `✅ <b>আপনার কুপন বিক্রির রিকোয়েস্ট অ্যাপ্রুভড।</b>\n\n💵 এডমিন আপনার দেওয়া নাম্বারে <b>৳${(res.s.amount/100).toFixed(2)}</b> পাঠিয়ে দিবে।` : `❌ <b>আপনার কুপন বিক্রির রিকোয়েস্ট রিজেক্টেড।</b>`, { parse_mode: "HTML", ...getHome(res.s.uid) });
      return;
    }

    if (data === "admin:stats") {
      const users = db.prepare("SELECT COUNT(*) c FROM users").get().c;
      const ord = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='COMPLETED'").get().c;
      const qst = db.prepare("SELECT COUNT(*) c FROM quests WHERE status='COMPLETED'").get().c;
      const sell = db.prepare("SELECT COUNT(*) c FROM sell_requests WHERE status='APPROVED'").get().c;
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `📊 <b>বট পরিসংখ্যান</b>\n\n👥 ইউজার: ${users}\n🛒 অর্ডার: ${ord}\n🎯 কুইস্ট: ${qst}\n💰 কুপন বিক্রি: ${sell}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 পেছনে", callback_data: "panel:back" }], [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {});
    }
    if (data === "admin:broadcast") { sessions.set(uid, { step: "broadcast_msg" }); await answer(); deleteMsg(); return bot.sendMessage(uid, "📣 <b>ব্রডকাস্ট মেসেজ</b>\n\n<i>সব ইউজারকে যে মেসেজটি পাঠাতে চান সেটি লিখুন (বাতিল: /cancel):</i>\n\n💡 <i>টিপস: সরাসরি চ্যাটে <code>/broadcast আপনার মেসেজ</code> লিখেও পাঠাতে পারেন।</i>", { parse_mode: "HTML" }).catch(() => {}); }
    if (data === "list:users") {
      const users = db.prepare("SELECT id, name, username FROM users ORDER BY id DESC LIMIT 20").all();
      let txt = `👥 <b>সাম্প্রতিক ইউজার (Last 20)</b>\n\n`;
      users.forEach(u => { txt += `<code>${u.id}</code> - ${esc(u.name)} (@${esc(u.username || 'n/a')})\n`; });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {});
    }
    if (data === "admin:ban") { const pMsg = await bot.sendMessage(uid, "যে ইউজারকে ব্যান/আনব্যান করবেন তার Telegram ID দিন:", { parse_mode: "HTML" }).catch(() => {}); if (pMsg) sessions.set(uid, { step: "admin_ban_uid", lastPromptId: pMsg.message_id }); await answer(); deleteMsg(); return; }
    if (data === "admin:texts") { await answer(); deleteMsg(); return bot.sendMessage(uid, "📝 <b>কোন টেক্সট এডিট করবেন?</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📖 নিয়মাবলী", callback_data: "admin:text:rules" }], [{ text: "💬 সাপোর্ট", callback_data: "admin:text:support" }], [{ text: "🔙 মেইন মেনু", callback_data: "main_menu" }, { text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {}); }
    if (data === "admin:text:rules") { const pMsg = await bot.sendMessage(uid, "নতুন নিয়মাবলী লিখুন:").catch(() => {}); if (pMsg) sessions.set(uid, { step: "admin_text_rules", lastPromptId: pMsg.message_id }); await answer(); deleteMsg(); return; }
    if (data === "admin:text:support") { const pMsg = await bot.sendMessage(uid, "নতুন সাপোর্ট টেক্সট লিখুন:").catch(() => {}); if (pMsg) sessions.set(uid, { step: "admin_text_support", lastPromptId: pMsg.message_id }); await answer(); deleteMsg(); return; }

    if (data === "list:logs") {
      const logs = db.prepare("SELECT * FROM admin_logs ORDER BY id DESC LIMIT 10").all();
      let txt = `📜 <b>অ্যাডমিন লগ</b>\n\n`;
      logs.forEach(l => { txt += `⏰ ${l.created_at}\n📝 ${esc(l.action)}\n\n`; });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ বন্ধ করুন", callback_data: "msg:delete" }]] } }).catch(() => {});
    }
    if (data === "list:support") {
      const tickets = db.prepare("SELECT * FROM support_tickets WHERE status='OPEN' ORDER BY id DESC LIMIT 10").all();
      if (!tickets.length) return answer("কোনো ওপেন টিকিট নেই", true);
      await answer(); deleteMsg();
      for (const t of tickets) {
        bot.sendMessage(uid, `🆘 <b>টিকিট #${t.id}</b>\nইউজার: <code>${t.uid}</code>\n💬 ${esc(t.message)}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "রিপ্লাই", callback_data: `support:reply:${t.uid}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]] } }).catch(() => {});
      } return;
    }
    if (data.startsWith("support:reply:")) { const target = Number(data.split(":")[2]); const pMsg = await bot.sendMessage(uid, `ইউজার ${target} কে রিপ্লাই লিখুন:`).catch(() => {}); if (pMsg) sessions.set(uid, { step: "admin_reply_support", targetUid: target, lastPromptId: pMsg.message_id }); await answer(); deleteMsg(); return; }

    if (data.startsWith("order:")) {
      const [, action, rid] = data.split(":");
      if (action === "complete") {
        const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='PROCESSING'").get(rid);
        if (!o) return answer("প্রসেসিং এ নেই", true);
        db.prepare("UPDATE orders SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=?").run(rid);
        await answer("সম্পন্ন"); logAdmin(`Order #${rid} completed`);
        editAndAutoDelete(chatId, msgId, `✅ <b>Order #${rid} সম্পন্ন হয়েছে</b>`);
        safeNotify(o.uid, `✅ <b>আপনার Order #${rid} সম্পন্ন হয়েছে!</b>`, { parse_mode: "HTML", ...getHome(o.uid) });
        return;
      }
      const res = db.transaction(() => {
        const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='PENDING'").get(rid);
        if (!o) return { err: 1 };
        if (action === "approve") { db.prepare("UPDATE orders SET status='PROCESSING', reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(rid); } 
        else { const currentStock = Number(getSetting(`stock_${o.coupon}`)); setSetting(`stock_${o.coupon}`, currentStock + (o.qty || 1)); db.prepare("UPDATE orders SET status='REJECTED', reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(rid); }
        return { o };
      })();
      if (res.err) return answer("রিভিউ করা হয়েছে", true);
      await answer("সম্পন্ন"); logAdmin(`Order #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Order #${rid} → প্রসেসিং</b>` : `❌ <b>Order #${rid} রিজেক্টেড</b>`);
      if (action === "approve") {
        bot.sendMessage(chatId, `🔄 <b>Order #${rid} [প্রসেসিং]</b>\nইউজার: ${res.o.uid}\n<i>কাজ শেষ হলে Complete চাপুন।</i>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ সম্পন্ন করুন", callback_data: `order:complete:${rid}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]] } }).catch(() => {});
      }
      safeNotify(res.o.uid, action === "approve" ? `✅ <b>আপনার অর্ডার #${rid} প্রসেসিং এ আছে।</b>` : `❌ <b>আপনার অর্ডার #${rid} বাতিল হয়েছে।</b>`, { parse_mode: "HTML", ...getHome(res.o.uid) });
      return;
    }

    if (data.startsWith("quest:")) {
      const [, action, rid] = data.split(":");
      if (action === "complete") {
        const q = db.prepare("SELECT * FROM quests WHERE id=? AND status='PROCESSING'").get(rid);
        if (!q) return answer("প্রসেসিং এ নেই", true);
        db.prepare("UPDATE quests SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=?").run(rid);
        await answer("সম্পন্ন"); logAdmin(`Quest #${rid} completed`);
        editAndAutoDelete(chatId, msgId, `✅ <b>Quest #${rid} সম্পন্ন হয়েছে</b>`);
        safeNotify(q.uid, `✅ <b>আপনার Quest #${rid} সম্পন্ন হয়েছে!</b>`, { parse_mode: "HTML", ...getHome(q.uid) });
        return;
      }
      const res = db.transaction(() => {
        const q = db.prepare("SELECT * FROM quests WHERE id=? AND status='PENDING'").get(rid);
        if (!q) return { err: 1 };
        db.prepare("UPDATE quests SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(action === "approve" ? "PROCESSING" : "REJECTED", uid, rid);
        return { q };
      })();
      if (res.err) return answer("রিভিউ করা হয়েছে", true);
      await answer("সম্পন্ন"); logAdmin(`Quest #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Quest #${rid} → প্রসেসিং</b>` : `❌ <b>Quest #${rid} রিজেক্টেড</b>`);
      if (action === "approve") {
        bot.sendMessage(chatId, `🔄 <b>Quest #${rid} [প্রসেসিং]</b>\nইউজার: ${res.q.uid}\n<i>কাজ শেষ হলে Complete চাপুন।</i>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ সম্পন্ন করুন", callback_data: `quest:complete:${rid}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]] } }).catch(() => {});
      }
      safeNotify(res.q.uid, action === "approve" ? `✅ <b>আপনার Quest #${rid} প্রসেসিং এ আছে।</b>` : `❌ <b>আপনার Quest #${rid} বাতিল হয়েছে।</b>`, { parse_mode: "HTML", ...getHome(res.q.uid) });
      return;
    }

    if (data === "list:orders") {
      const rows = db.prepare("SELECT * FROM orders WHERE status='PENDING' LIMIT 10").all();
      await answer(); deleteMsg();
      if (!rows.length) return bot.sendMessage(uid, "পেন্ডিং অর্ডার নেই।").then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      rows.forEach(r => bot.sendMessage(uid, `🛒 <b>অর্ডার #${r.id}</b>\nইউজার: <code>${r.uid}</code>\nকুপন: $${r.coupon} (${r.qty} পিস)\nদাম: ${fmt(r.amount)}\n${r.delivery_method ? `${r.delivery_method}: ${r.delivery_info}` : ''}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ অ্যাপ্রুভ", callback_data: `order:approve:${r.id}` }, { text: "❌ রিজেক্ট", callback_data: `order:reject:${r.id}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]] } }).catch(() => {}));
      return;
    }
    if (data === "list:quests") {
      const rows = db.prepare("SELECT * FROM quests WHERE status='PENDING' LIMIT 10").all();
      await answer(); deleteMsg();
      if (!rows.length) return bot.sendMessage(uid, "পেন্ডিং কুইস্ট নেই।").then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000)).catch(() => {});
      rows.forEach(r => {
        bot.sendPhoto(uid, r.screenshot, { caption: `🎯 <b>কুইস্ট #${r.id}</b>\nইউজার: <code>${r.uid}</code>\nGmail: ${r.gmail}\nPass: ${r.password}`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ অ্যাপ্রুভ", callback_data: `quest:approve:${r.id}` }, { text: "❌ রিজেক্ট", callback_data: `quest:reject:${r.id}` }], [{ text: "🗑 ডিলিট", callback_data: "msg:delete" }]] } }).catch(() => {});
      });
      return;
    }

    if (data === "panel:back") { await answer(); return deleteMsg().then(() => adminPanel(uid)); }

  } catch (error) { logError(error); answer("Error", true); }
});

// ===== Startup =====
bot.on("polling_error", e => console.error("Polling error:", e?.message || e));

bot.getMe().then(async (info) => {
  console.log(`✅ BOT CONNECTED: @${info.username}`);
  
  const adminMsg = `🚀 <b>বট সফলভাবে চালু হয়েছে!</b>\n\n` +
    `✨ <b>সব ফিচার (১-১০২) একসাথে যুক্ত করা হয়েছে।</b>\n\n` +
    `⏳ সমস্ত ইউজারকে নোটিফিকেশন পাঠানো হচ্ছে...`;

  bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: "HTML" }).then(m => setTimeout(() => bot.deleteMessage(ADMIN_ID, m.message_id).catch(() => {}), 15000)).catch(() => {});

  const users = db.prepare("SELECT id FROM users").all();
  const updateMsg = `🌟 <b>বট নতুন আপডেট পেয়েছে!</b> 🌟\n\n` +
    `✨ <b>নতুন সুবিধা:</b>\n` +
    `• বট এখন আরও দ্রুত এবং নির্ভরযোগ্য।\n\n` +
    `👇 <i>যেকোনো সমস্যায় 🚀 রিস্টার্ট বট চাপুন।</i>`;

  let count = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.id, updateMsg, { parse_mode: "HTML", ...getHome(u.id) });
      count++;
      await new Promise(r => setTimeout(r, 40)); 
    } catch (e) {} 
  }
  console.log(`✅ Broadcast sent to ${count} users.`);
});