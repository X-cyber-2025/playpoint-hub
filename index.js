// PLAY POINT QUEST HUB — Complete Updated & Fixed Bot Code

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");

const { BOT_TOKEN, ADMIN_CHAT_ID, SUPPORT_USERNAME = "", BKASH_NUMBER = "", NAGAD_NUMBER = "", ADMIN_WHATSAPP = "" } = process.env;
const ADMIN_ID = Number(ADMIN_CHAT_ID);
const REQUIRED_CHANNEL = "@google_play_point_01";

if (!BOT_TOKEN || !Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  console.error("ERROR: Set BOT_TOKEN and numeric ADMIN_CHAT_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new Database(process.env.DB_FILE || "./quest_hub.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ===== Database Setup =====
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), is_banned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, method TEXT NOT NULL CHECK(method IN ('bKash','Nagad')),
  amount INTEGER NOT NULL CHECK(amount > 0), trx TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS deposit_trx_unique ON deposits(method, trx);
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, coupon INTEGER NOT NULL CHECK(coupon IN (4,5,10,20,25)),
  price INTEGER, status TEXT NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','SENT','CONFIRMED','DECLINED','ORDERED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(uid) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, price_id INTEGER NOT NULL UNIQUE, coupon INTEGER NOT NULL,
  qty INTEGER DEFAULT 1, amount INTEGER NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')),
  delivery_method TEXT, delivery_info TEXT, reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT, completed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id), FOREIGN KEY(price_id) REFERENCES prices(id)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('DEPOSIT','PURCHASE','ADJUSTMENT')),
  amount INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(uid) REFERENCES users(id)
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
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT,
  FOREIGN KEY(uid) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS bins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bin_number TEXT NOT NULL, bank_name TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS us_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address_text TEXT NOT NULL,
  added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// ===== Migrations =====
try { db.exec("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0;"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN qty INTEGER DEFAULT 1;"); } catch(e) {}

const defaultSettings = [
  ['rules_text', '📖 <b>RULES</b>\n\n1. সঠিক Transaction ID জমা দিন।\n2. Admin যাচাই করার পরই ব্যালেন্স যোগ হবে।\n3. PIN, OTP বা পাসওয়ার্ড কারও সাথে শেয়ার করবেন না।\n4. Coupon-এর দাম Admin নিশ্চিত করবেন।\n5. অর্ডার অনুমোদনের আগে ব্যালেন্স কাটা হবে না।'],
  ['support_text', '💬 Support-এর জন্য Admin-কে মেসেজ করুন।'],
  ['price_4', '0'], ['stock_4', '0'], ['price_5', '0'], ['stock_5', '0'],
  ['price_10', '0'], ['stock_10', '0'], ['price_20', '0'], ['stock_20', '0'], ['price_25', '0'], ['stock_25', '0'],
  ['sell_price_4', '0'], ['sell_price_5', '0'], ['sell_price_10', '0'], ['sell_price_20', '0'], ['sell_price_25', '0'],
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
const balanceOf = uid => db.prepare("SELECT balance FROM users WHERE id=?").get(uid)?.balance ?? 0;
const getSetting = key => db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
const setSetting = (key, value) => db.prepare("UPDATE settings SET value=? WHERE key=?").run(value, key);
const logAdmin = (action) => db.prepare("INSERT INTO admin_logs(admin_id, action) VALUES(?,?)").run(ADMIN_ID, action);

function ensureUser(user) {
  db.prepare(`INSERT INTO users(id,name,username) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username`)
    .run(user.id, user.first_name || "", user.username || "");
}
async function safeNotify(chatId, text, options) {
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

function parseMoney(text) {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return null;
  const v = Number(text);
  if (!Number.isFinite(v) || v <= 0 || v > 100000) return null;
  return toPaisa(v);
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
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).split('/').filter(Boolean);
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
    reply_markup: { inline_keyboard: [[{ text: "📢 Join Channel", url: "https://t.me/google_play_point_01" }], [{ text: "✅ Check Again", callback_data: "check_join" }]] }
  });
}

// ===== Keyboards =====
const getHome = (uid) => {
  const keyboard = [
    ["🚀 Start / Restart", "💰 My Balance"],
    ["🎮 COD Coupons", "🔢 BIN Numbers"],
    ["💳 Card Make", "🇺🇸 USA Fake Address"],
    ["🎯 Quest Complete", "📜 Transactions"],
    ["💬 Support", "📖 Rules"],
    ["➕ Add Balance"]
  ];
  if (isAdmin(uid)) keyboard.push(["🛠 Admin Menu"]);
  return { reply_markup: { keyboard, resize_keyboard: true } };
};
const MENU_BUTTONS = new Set(["🚀 Start / Restart","💰 My Balance","➕ Add Balance","🎮 COD Coupons","🔢 BIN Numbers","💳 Card Make","🇺🇸 USA Fake Address","🎯 Quest Complete","📜 Transactions","💬 Support","📖 Rules","🔄 Restart Bot","🛠 Admin Menu"]);

function adminPanel(chatId) {
  return bot.sendMessage(chatId, "🛠 <b>ADMIN CONTROL PANEL</b>\n\nআপনি নিচের অপশনগুলো থেকে যেকোনো কিছু ম্যানেজ করতে পারেন।", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📊 Statistics", callback_data: "admin:stats" }, { text: "📣 Broadcast", callback_data: "admin:broadcast" }],
      [{ text: "📥 Deposits", callback_data: "list:deposits" }, { text: "💬 Price Requests", callback_data: "list:prices" }],
      [{ text: "🛒 Pending Orders", callback_data: "list:orders" }, { text: "🔄 In Progress Orders", callback_data: "list:in_progress_orders" }],
      [{ text: "🎯 Pending Quests", callback_data: "list:quests" }, { text: "🔄 In Progress Quests", callback_data: "list:in_progress_quests" }],
      [{ text: "🆘 Support Inbox", callback_data: "list:support" }, { text: "👥 All Users", callback_data: "list:users" }],
      [{ text: "💵 Set Prices", callback_data: "admin:set_prices" }, { text: "📦 Set Stocks", callback_data: "admin:set_stocks" }],
      [{ text: "💰 Sell Rates", callback_data: "admin:set_sell_prices" }, { text: "📥 Sell Requests", callback_data: "list:sell_requests" }],
      [{ text: "🔢 BIN Management", callback_data: "admin:bins" }, { text: "🇺🇸 USA Address", callback_data: "admin:us_addresses" }],
      [{ text: "🚫 Ban/Unban", callback_data: "admin:ban" }, { text: "📝 Edit Texts", callback_data: "admin:texts" }],
      [{ text: "📜 Admin Logs", callback_data: "list:logs" }, { text: "❌ Close Panel", callback_data: "panel:close" }]
    ]}
  });
}

// ===== Start Command Handler =====
async function handleStart(msg) {
  if (!msg.from?.id) return;
  const uid = msg.from.id;
  if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
  
  const user = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
  if (user?.is_banned) return bot.sendMessage(uid, "🚫 আপনাকে বট থেকে ব্যান করা হয়েছে।");

  ensureUser(msg.from);
  sessions.delete(uid);
  
  bot.deleteMessage(uid, msg.message_id).catch(() => {});

  const startText = `✨ <b>আসসালামু আলাইকুম, ${esc(msg.from.first_name || "বন্ধু")}!</b>\n\n` +
    `আমাদের প্রিমিয়াম বটে আপনাকে স্বাগতম। এখানে আপনি গুগল প্লে কার্ড, কুপন এবং অন্যান্য সার্ভিস উপভোগ করতে পারবেন।\n\n` +
    `💳 <b>আপনার বর্তমান ব্যালেন্স:</b> <code>${fmt(balanceOf(uid))}</code>\n\n` +
    `👇 <i>নিচের মেনু থেকে আপনার পছন্দের সার্ভিসটি বেছে নিন।</i>`;

  bot.sendMessage(uid, startText, { parse_mode: "HTML", ...getHome(uid) });
}

bot.onText(/^\/start(@\w+)?$/, handleStart);
bot.onText(/^\/admin(@\w+)?$/, msg => {
  if (isAdmin(msg.from.id)) {
    bot.deleteMessage(msg.from.id, msg.message_id).catch(() => {});
    return adminPanel(msg.chat.id);
  }
});
bot.onText(/^\/cancel(@\w+)?$/, msg => {
  bot.deleteMessage(msg.from.id, msg.message_id).catch(() => {});
  sessions.delete(msg.from.id);
  bot.sendMessage(msg.from.id, "✅ প্রক্রিয়াটি বাতিল হয়েছে।", getHome(msg.from.id))
    .then(m => setTimeout(() => bot.deleteMessage(msg.from.id, m.message_id).catch(() => {}), 3000));
});

// ===== Message Handler =====
bot.on("message", async msg => {
  if (!msg.from?.id || msg.from.is_bot) return;
  const uid = msg.from.id;
  const text = msg.text ? msg.text.trim() : "";

  try {
    if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
    
    const dbUser = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
    if (dbUser?.is_banned && !isAdmin(uid)) return bot.sendMessage(uid, "🚫 আপনাকে ব্যান করা হয়েছে।");
    
    ensureUser(msg.from);
    const session = sessions.get(uid);

    // Photo Handler
    if (msg.photo) {
      if (session?.step === "quest_screenshot") {
        session.screenshot = msg.photo[msg.photo.length - 1].file_id;
        session.step = "quest_gmail";
        return bot.sendMessage(uid, "✅ স্ক্রিনশট গ্রহণ করা হয়েছে।\n\n📧 <b>এখন আপনার Gmail অ্যাড্রেসটি দিন।</b>", { parse_mode: "HTML" });
      }
      if (session?.step === "support_msg") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        db.prepare("INSERT INTO support_tickets(uid, message) VALUES(?, ?)").run(uid, `[Photo] ${fileId}`);
        sendAdmin(`🆘 <b>Support Ticket</b>\n👤 User: <code>${uid}</code>\n📷 ছবি পাঠানো হয়েছে`, {
          inline_keyboard: [[{ text: "💬 Reply", callback_data: `support:reply:${uid}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]]
        });
        bot.sendPhoto(ADMIN_ID, fileId);
        sessions.delete(uid);
        return bot.sendMessage(uid, "✅ আপনার মেসেজটি এডমিনের কাছে পাঠানো হয়েছে।", getHome(uid));
      }
      if (session?.step === "admin_reply_support") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(session.targetUid, fileId, { caption: "💬 Admin-এর রিপ্লাই" });
        db.prepare("UPDATE support_tickets SET status='CLOSED', reply=? WHERE uid=? AND status='OPEN'").run(`[Photo] ${fileId}`, session.targetUid);
        sessions.delete(uid);
        return bot.sendMessage(uid, "✅ রিপ্লাই পাঠানো হয়েছে।");
      }
      return;
    }

    if (!msg.text) return;

    // Handle "Start / Restart" from keyboard
    if (text === "🚀 Start / Restart" || text === "🔄 Restart Bot" || text.toLowerCase() === "start") {
      return handleStart(msg);
    }

    // Allow BIN format through when in card_make_bin step
    const isBinFormat = /^\/\d{4,15}(\/\d{1,2}(\/\d{2,4})?)?$/.test(text);
    const inCardMake = sessions.get(uid)?.step === "card_make_bin";
    if (text.startsWith("/") && !(isBinFormat && inCardMake)) return;

    // Delete user's messages (except menu buttons)
    if (!MENU_BUTTONS.has(text)) {
      bot.deleteMessage(uid, msg.message_id).catch(() => {});
    }

    // Menu buttons routing
    if (MENU_BUTTONS.has(text)) {
      sessions.delete(uid);
      if (text === "🛠 Admin Menu") { if (isAdmin(uid)) return adminPanel(uid); return; }
      if (text === "💰 My Balance") {
        return bot.sendMessage(uid, `💳 <b>আপনার বর্তমান ব্যালেন্স:</b> <code>${fmt(balanceOf(uid))}</code>`, { parse_mode: "HTML", ...getHome(uid) })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
      }
      if (text === "➕ Add Balance") {
        return bot.sendMessage(uid, "💳 <b>পেমেন্ট মাধ্যম বেছে নিন:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔴 bKash", callback_data: "deposit:method:bKash" }], [{ text: "🟠 Nagad", callback_data: "deposit:method:Nagad" }], [{ text: "❌ Close", callback_data: "msg:delete" }]] } });
      }
      if (text === "🎯 Quest Complete") {
        sessions.set(uid, { step: "quest_screenshot" });
        return bot.sendMessage(uid, "🎯 <b>Quest Complete</b>\n\nকুইস্ট সম্পন্ন করতে ১০৳ ফি দিতে হবে।\n\n📸 অ্যাডমিনের নম্বরে ১০৳ পাঠিয়ে পেমেন্টের স্ক্রিনশট এখানে পাঠান।", { parse_mode: "HTML" });
      }
      if (text === "🎮 COD Coupons") {
        return bot.sendMessage(uid, "🎮 <b>COD Coupons</b>\n\nআপনি কী করতে চান?", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "🛒 কিনুন (Buy)", callback_data: "coupon_mode:buy" }],
            [{ text: "💰 বিক্রি করুন (Sell)", callback_data: "coupon_mode:sell" }],
            [{ text: "❌ Close", callback_data: "msg:delete" }]
          ]}
        });
      }
      if (text === "🔢 BIN Numbers") {
        const bins = db.prepare("SELECT * FROM bins ORDER BY id DESC LIMIT 30").all();
        if (!bins.length) {
          return bot.sendMessage(uid, "😔 এখনো কোনো BIN আপলোড করা হয়নি।", getHome(uid))
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
        }
        const lines = bins.map(b => {
          let line = `🔢 <code>${esc(b.bin_number)}</code>`;
          if (b.bank_name) line += `\n🏦 ${esc(b.bank_name)}`;
          if (b.country) line += ` | 🌍 ${esc(b.country)}`;
          if (b.note) line += `\n📝 ${esc(b.note)}`;
          return line;
        });
        return bot.sendMessage(uid, `🔢 <b>BIN Numbers</b> (মোট: ${bins.length})\n\n${lines.join('\n\n')}`, { parse_mode: "HTML", ...getHome(uid) });
      }
      if (text === "💳 Card Make") {
        const price = Number(getSetting('card_make_price'));
        const priceText = price > 0 ? `💰 মূল্য: <b>${fmt(price)}</b> (১০টি কার্ড)` : `🎉 সম্পূর্ণ ফ্রি!`;
        sessions.set(uid, { step: "card_make_bin" });
        return bot.sendMessage(uid,
          `💳 <b>Card Make</b>\n\nএকবারে ১০টি কার্ড তৈরি হবে।\n${priceText}\n\n` +
          `📝 <b>ফরম্যাট (উদাহরণ):</b>\n` +
          `<code>/2345666</code> → শুধু BIN\n` +
          `<code>/246666/12/34</code> → BIN/মাস/বছর\n\n` +
          `✏️ আপনার BIN পাঠান (বাতিল: /cancel):`,
          { parse_mode: "HTML" }
        );
      }
      if (text === "🇺🇸 USA Fake Address") {
        const addr = db.prepare("SELECT * FROM us_addresses ORDER BY RANDOM() LIMIT 1").get();
        if (!addr) {
          return bot.sendMessage(uid, "😔 এখনো কোনো USA Address আপলোড করা হয়নি।", getHome(uid))
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
        }
        return bot.sendMessage(uid, `🇺🇸 <b>USA Fake Address</b>\n\n<blockquote>${esc(addr.address_text)}</blockquote>`, { parse_mode: "HTML", ...getHome(uid) });
      }
      if (text === "📜 Transactions") {
        const rows = db.prepare(`SELECT type, amount, note, created_at FROM transactions WHERE uid=? ORDER BY id DESC LIMIT 10`).all(uid);
        if (!rows.length) return bot.sendMessage(uid, "📭 কোনো ট্রানজেকশন পাওয়া যায়নি।", getHome(uid))
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
        const lines = rows.map(r => `${r.type === 'DEPOSIT' ? '🟢' : '🔴'} <b>${r.type}:</b> ${fmt(r.amount)}\n📝 ${r.note}\n⏰ ${r.created_at}`);
        return bot.sendMessage(uid, `📜 <b>আপনার সাম্প্রতিক ট্রানজেকশন</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", ...getHome(uid) });
      }
      if (text === "💬 Support") {
        sessions.set(uid, { step: "support_msg" });
        return bot.sendMessage(uid, `💬 <b>সাপোর্ট সেন্টার</b>\n\n${getSetting('support_text')}\n\nআপনার সমস্যা বিস্তারিত লিখে বা ছবি পাঠিয়ে দিন (বাতিল: /cancel)।`, { parse_mode: "HTML" });
      }
      if (text === "📖 Rules") {
        return bot.sendMessage(uid, getSetting('rules_text'), { parse_mode: "HTML", ...getHome(uid) });
      }
    }

    // Fallback for unknown text (prevents needing /start)
    if (!session) {
      return bot.sendMessage(uid, "🤖 আমি আপনার কথা বুঝতে পারিনি। নিচের মেনু থেকে অপশন বেছে নিন অথবা নতুন করে শুরু করতে 🚀 Start / Restart চাপুন।", getHome(uid));
    }

    // === Card Make BIN step ===
    if (session?.step === "card_make_bin") {
      const parsed = parseBinInput(text);
      if (!parsed) {
        return bot.sendMessage(uid, `❌ ভুল ফরম্যাট।\n\nউদাহরণ:\n<code>/2345666</code>\n<code>/246666/12/34</code>`, { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
      }
      const price = Number(getSetting('card_make_price'));
      if (price > 0 && balanceOf(uid) < price) {
        sessions.delete(uid);
        return bot.sendMessage(uid, `❌ ব্যালেন্স যথেষ্ট নয়।\nপ্রয়োজন: ${fmt(price)}\nআপনার আছে: ${fmt(balanceOf(uid))}`, getHome(uid))
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 6000));
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
      if (price > 0) {
        db.transaction(() => {
          db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(price, uid);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(uid, "PURCHASE", -price, `CM-${Date.now()}-${uid}`, `Card Make: ${parsed.bin}`);
        })();
      }
      logAdmin(`User ${uid} generated 10 cards from BIN ${parsed.bin}`);
      
      return bot.sendMessage(uid,
        `✅ <b>সফলভাবে ১০টি কার্ড তৈরি হয়েছে!</b>\n\n` +
        `📋 <b>ফরম্যাট:</b> <code>NUMBER|MM|YY|CVV</code>\n\n` +
        `<blockquote>${cards.join('\n')}</blockquote>\n\n` +
        `⚠️ <i>কার্ডগুলো কপি করে সঠিকভাবে ব্যবহার করুন।</i>`,
        { parse_mode: "HTML", ...getHome(uid) }
      );
    }

    // === Sell Quantity ===
    if (session?.step === "sell_qty") {
      const qty = parseInt(text);
      if (!qty || qty <= 0 || qty > 1000) {
        return bot.sendMessage(uid, "সঠিক সংখ্যা লিখুন (যেমন: 1, 2, 5)।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      const total = session.sellPrice * qty;
      const sellRes = db.prepare("INSERT INTO sell_requests(uid, coupon, qty, amount) VALUES(?,?,?,?)").run(uid, session.coupon, qty, total);
      const sellId = Number(sellRes.lastInsertRowid);
      sessions.delete(uid);
      bot.sendMessage(uid, `✅ <b>Sell Request #${sellId} জমা হয়েছে।</b>\n\n🎮 $${session.coupon} × ${qty}\n💵 পাবেন: <b>${fmt(total)}</b>\n\n⏳ <i>Admin approve করলে ব্যালেন্স যোগ হবে।</i>`, { parse_mode: "HTML", ...getHome(uid) })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 8000));
      return sendAdmin(`💰 <b>NEW SELL REQUEST #${sellId}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\n🎮 $${session.coupon} × ${qty}\n💵 Pay: <b>${fmt(total)}</b>\n\n⚠️ Approve করলে stock +${qty} হবে।`, {
        inline_keyboard: [[{ text: "✅ Approve", callback_data: `sell:approve:${sellId}` }, { text: "❌ Reject", callback_data: `sell:reject:${sellId}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]]
      });
    }

    // --- Deposit Steps ---
    if (session?.step === "deposit_amount") {
      const amount = parseMoney(text);
      if (!amount || amount < 1000) {
        return bot.sendMessage(uid, "সঠিক পরিমাণ লিখুন (মিনিমাম ১০৳)।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      session.amount = amount; session.step = "deposit_trx";
      return bot.sendMessage(uid, `💳 <b>${session.method}</b> পেমেন্টের <b>TRX ID</b> লিখুন:`, { parse_mode: "HTML" });
    }
    if (session?.step === "deposit_trx") {
      if (text.length < 5) {
        return bot.sendMessage(uid, "সঠিক TRX ID দিন (কমপক্ষে ৫ অক্ষর)।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      try {
        const inserted = db.prepare("INSERT INTO deposits(uid,method,amount,trx) VALUES(?,?,?,?)").run(uid, session.method, session.amount, text);
        const depositId = Number(inserted.lastInsertRowid);
        sendAdmin(`💳 <b>DEPOSIT #${depositId}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\nমাধ্যম: ${session.method}\nপরিমাণ: <b>${fmt(session.amount)}</b>\nTRX: <code>${esc(text)}</code>`, {
          inline_keyboard: [[{ text: "✅ Approve", callback_data: `deposit:approve:${depositId}` }, { text: "❌ Reject", callback_data: `deposit:reject:${depositId}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]]
        });
        bot.sendMessage(uid, `✅ <b>Deposit Request #${depositId} সফলভাবে জমা হয়েছে।</b>\n\n⏳ এডমিন যাচাই করে ব্যালেন্স যোগ করে দিবে।`, { parse_mode: "HTML", ...getHome(uid) })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
      } catch (error) {
        bot.sendMessage(uid, "❌ এই TRX ID আগে জমা হয়েছে।", getHome(uid))
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      sessions.delete(uid); return;
    }

    // --- Quest Steps ---
    if (session?.step === "quest_gmail") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return bot.sendMessage(uid, "সঠিক Gmail দিন।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      session.gmail = text; session.step = "quest_password";
      return bot.sendMessage(uid, "🔑 <b>Gmail-এর পাসওয়ার্ড দিন:</b>", { parse_mode: "HTML" });
    }
    if (session?.step === "quest_password") {
      session.password = text; session.step = "quest_contact";
      return bot.sendMessage(uid, "📞 <b>যোগাযোগের ফোন নম্বর বা ইমেইল দিন:</b>", { parse_mode: "HTML" });
    }
    if (session?.step === "quest_contact") {
      session.contact = text;
      const res = db.prepare(`INSERT INTO quests(uid, screenshot, gmail, password, contact) VALUES(?,?,?,?,?)`).run(uid, session.screenshot, session.gmail, session.password, session.contact);
      const questId = Number(res.lastInsertRowid);
      sessions.delete(uid);
      bot.sendMessage(uid, "✅ <b>Quest Request গ্রহণ করা হয়েছে।</b>\n\nআমাদের টিম শীঘ্রই আপনার কুইস্ট প্রসেস করবে।", { parse_mode: "HTML", ...getHome(uid) })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
      bot.sendPhoto(ADMIN_ID, session.screenshot, {
        caption: `🎯 <b>NEW QUEST #${questId}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\n📧 ${esc(session.gmail)}\n🔑 ${esc(session.password)}\n📞 ${esc(session.contact)}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `quest:approve:${questId}` }, { text: "❌ Reject", callback_data: `quest:reject:${questId}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
      });
      return;
    }

    // --- Coupon Quantity (Buy mode) ---
    if (session?.step === "coupon_qty") {
      const qty = parseInt(text);
      if (!qty || qty <= 0) {
        return bot.sendMessage(uid, "সঠিক সংখ্যা লিখুন (যেমন: 1, 2, 5)।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      const stock = Number(getSetting(`stock_${session.coupon}`));
      if (qty > stock) {
        return bot.sendMessage(uid, `❌ দুঃখিত, আমাদের কাছে মাত্র ${stock}টি কুপন আছে।`)
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 4000));
      }
      const price = Number(getSetting(`price_${session.coupon}`));
      const total = price * qty;
      sessions.delete(uid);
      const msgText = `🧾 <b>Coupon Summary</b>\n\n🎮 কুপন: $${session.coupon} (${qty} টি)\n💵 মোট দাম: <b>${fmt(total)}</b>\n\n<i>আপনি কিভাবে কিনতে চান?</i>`;
      const replyMarkup = {
        inline_keyboard: [
          [{ text: "🤖 বটের ব্যালেন্স থেকে কিনুন", callback_data: `buy:bot:${session.coupon}:${qty}:${total}` }],
          [{ text: "📞 সরাসরি অ্যাডমিনের থেকে কিনুন", callback_data: `buy:admin:${session.coupon}:${qty}:${total}` }],
          [{ text: "❌ Cancel", callback_data: "msg:delete" }]
        ]
      };
      return bot.sendMessage(uid, msgText, { parse_mode: "HTML", reply_markup: replyMarkup });
    }

    // --- Order Delivery Steps ---
    if (session?.step === "order_gameid") {
      const result = db.transaction(() => {
        const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(session.priceId, uid);
        if (!req || balanceOf(uid) < req.price) return { error: "ERR" };
        db.prepare(`UPDATE prices SET status='CONFIRMED' WHERE id=?`).run(session.priceId);
        const ins = db.prepare("INSERT INTO orders(uid, price_id, coupon, qty, amount, delivery_method, delivery_info) VALUES(?,?,?,?,?,?,?)").run(uid, session.priceId, req.coupon, 1, req.price, "GAME_ID", text);
        return { id: Number(ins.lastInsertRowid), coupon: req.coupon, price: req.price };
      })();
      sessions.delete(uid);
      if (result.error) return bot.sendMessage(uid, "সমস্যা হয়েছে বা ব্যালেন্স নেই।", getHome(uid));
      bot.sendMessage(uid, `🧾 <b>Order #${result.id} পেন্ডিং এ আছে।</b>`, { parse_mode: "HTML", ...getHome(uid) })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
      return sendAdmin(`🛒 <b>NEW ORDER #${result.id}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\nCoupon: $${result.coupon} (1 pcs)\nদাম: <b>${fmt(result.price)}</b>\n🎮 Game ID: <code>${esc(text)}</code>`, {
        inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${result.id}` }, { text: "❌ Reject", callback_data: `order:reject:${result.id}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]]
      });
    }
    if (session?.step === "order_gmail_email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return bot.sendMessage(uid, "সঠিক Gmail দিন।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      session.gmail = text; session.step = "order_gmail_password";
      return bot.sendMessage(uid, "🔑 <b>Gmail-এর পাসওয়ার্ড দিন:</b>", { parse_mode: "HTML" });
    }
    if (session?.step === "order_gmail_password") {
      const info = `Gmail: ${session.gmail} | Pass: ${text}`;
      const result = db.transaction(() => {
        const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(session.priceId, uid);
        if (!req || balanceOf(uid) < req.price) return { error: "ERR" };
        db.prepare(`UPDATE prices SET status='CONFIRMED' WHERE id=?`).run(session.priceId);
        const ins = db.prepare("INSERT INTO orders(uid, price_id, coupon, qty, amount, delivery_method, delivery_info) VALUES(?,?,?,?,?,?,?)").run(uid, session.priceId, req.coupon, 1, req.price, "GMAIL", info);
        return { id: Number(ins.lastInsertRowid), coupon: req.coupon, price: req.price };
      })();
      sessions.delete(uid);
      if (result.error) return bot.sendMessage(uid, "সমস্যা হয়েছে বা ব্যালেন্স নেই।", getHome(uid));
      bot.sendMessage(uid, `🧾 <b>Order #${result.id} পেন্ডিং এ আছে।</b>`, { parse_mode: "HTML", ...getHome(uid) })
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
      return sendAdmin(`🛒 <b>NEW ORDER #${result.id}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\nCoupon: $${result.coupon} (1 pcs)\nদাম: <b>${fmt(result.price)}</b>\n📧 ${esc(info)}`, {
        inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${result.id}` }, { text: "❌ Reject", callback_data: `order:reject:${result.id}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]]
      });
    }

    // --- Support ---
    if (session?.step === "support_msg") {
      db.prepare("INSERT INTO support_tickets(uid, message) VALUES(?, ?)").run(uid, text);
      sendAdmin(`🆘 <b>Support Ticket</b>\n👤 User: <code>${uid}</code>\n💬 ${esc(text)}`, { inline_keyboard: [[{ text: "💬 Reply", callback_data: `support:reply:${uid}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] });
      sessions.delete(uid);
      return bot.sendMessage(uid, "✅ আপনার মেসেজটি এডমিনের কাছে পাঠানো হয়েছে।", getHome(uid))
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
    }
    if (session?.step === "admin_reply_support" && isAdmin(uid)) {
      await safeNotify(session.targetUid, `💬 <b>Admin-এর রিপ্লাই:</b>\n\n${esc(text)}`, { parse_mode: "HTML" });
      db.prepare("UPDATE support_tickets SET status='CLOSED', reply=? WHERE uid=? AND status='OPEN'").run(text, session.targetUid);
      sessions.delete(uid);
      return bot.sendMessage(uid, "✅ রিপ্লাই পাঠানো হয়েছে।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
    }

    // --- Broadcast ---
    if (session?.step === "broadcast_msg" && isAdmin(uid)) {
      const users = db.prepare("SELECT id FROM users WHERE is_banned=0").all();
      let count = 0;
      let notif = await bot.sendMessage(uid, `⏳ ${users.length} জনকে পাঠানো হচ্ছে...`);
      for (const u of users) {
        const ok = await safeNotify(u.id, text, { parse_mode: "HTML" });
        if (ok) count++;
        await new Promise(r => setTimeout(r, 50));
      }
      sessions.delete(uid);
      logAdmin(`Broadcasted message to ${count} users`);
      bot.deleteMessage(uid, notif.message_id).catch(() => {});
      return bot.sendMessage(uid, `✅ সফলভাবে ${count} জনকে মেসেজ পাঠানো হয়েছে।`)
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
    }

    // --- Admin Set Price (Buy) ---
    if (session?.step === "admin_set_price" && isAdmin(uid)) {
      let price;
      if (text === "0") { price = 0; }
      else {
        price = parseMoney(text);
        if (!price) {
          return bot.sendMessage(uid, "সঠিক দাম লিখুন। (0 দিলে রিকোয়েস্ট সিস্টেম চালু হবে)")
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
        }
      }
      setSetting(`price_${session.coupon}`, price);
      sessions.delete(uid);
      logAdmin(`Updated $${session.coupon} coupon price to ${fmt(price)}`);
      const successMsg = await bot.sendMessage(uid, `✅ $${session.coupon} কুপনের দাম সেট হয়েছে: ${price > 0 ? fmt(price) : 'রিকোয়েস্ট মোড'}`);
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // --- Admin Set Stock ---
    if (session?.step === "admin_set_stock" && isAdmin(uid)) {
      const stock = Number(text);
      if (!Number.isInteger(stock) || stock < 0) {
        return bot.sendMessage(uid, "সঠিক সংখ্যা লিখুন।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      setSetting(`stock_${session.coupon}`, stock);
      sessions.delete(uid);
      logAdmin(`Updated $${session.coupon} coupon stock to ${stock}`);
      const successMsg = await bot.sendMessage(uid, `✅ $${session.coupon} কুপনের স্টক সেট হয়েছে: ${stock}`);
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // --- Admin Set Sell Price ---
    if (session?.step === "admin_set_sell_price" && isAdmin(uid)) {
      let price;
      if (text === "0") { price = 0; }
      else {
        price = parseMoney(text);
        if (!price) {
          return bot.sendMessage(uid, "সঠিক দাম লিখুন। (0 = কেনা বন্ধ)")
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
        }
      }
      setSetting(`sell_price_${session.coupon}`, price);
      sessions.delete(uid);
      logAdmin(`Updated $${session.coupon} sell price to ${fmt(price)}`);
      const successMsg = await bot.sendMessage(uid, `✅ $${session.coupon} কুপনের Buy Rate সেট হয়েছে: ${price > 0 ? fmt(price) : 'বন্ধ'}`);
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // --- Admin Set Card Make Price ---
    if (session?.step === "admin_set_card_price" && isAdmin(uid)) {
      let price;
      if (text === "0") { price = 0; }
      else {
        price = parseMoney(text);
        if (!price) {
          return bot.sendMessage(uid, "সঠিক দাম লিখুন। (0 = ফ্রি)")
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
        }
      }
      setSetting('card_make_price', price);
      sessions.delete(uid);
      logAdmin(`Updated card make price to ${fmt(price)}`);
      const successMsg = await bot.sendMessage(uid, `✅ Card Make Price সেট হয়েছে: ${price > 0 ? fmt(price) : 'ফ্রি'}`);
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // --- Admin Add USA Address ---
    if (session?.step === "admin_add_us_addr" && isAdmin(uid)) {
      const lines = text.split("\n\n").map(l => l.trim()).filter(Boolean);
      let count = 0;
      db.transaction(() => {
        for (const line of lines) {
          db.prepare("INSERT INTO us_addresses(address_text, added_by) VALUES(?,?)").run(line, uid);
          count++;
        }
      })();
      sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, `✅ ${count}টি USA Address যোগ করা হয়েছে।`);
      setTimeout(() => { sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300); adminPanel(uid); }, 1000);
      return;
    }

    // --- Admin Ban ---
    if (session?.step === "admin_ban_uid" && isAdmin(uid)) {
      const target = Number(text);
      const user = db.prepare("SELECT is_banned FROM users WHERE id=?").get(target);
      if (!user) {
        sessions.delete(uid);
        return bot.sendMessage(uid, "❌ ইউজার পাওয়া যায়নি।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      const newBanStatus = user.is_banned ? 0 : 1;
      db.prepare("UPDATE users SET is_banned=? WHERE id=?").run(newBanStatus, target);
      sessions.delete(uid);
      logAdmin(`Toggled ban for user ${target} to ${newBanStatus}`);
      const successMsg = await bot.sendMessage(uid, `✅ ইউজার ${target} এখন ${newBanStatus ? '🚫 Ban' : '✅ Unban'} করা হয়েছে।`);
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // --- Admin Edit Texts ---
    if (session?.step === "admin_text_rules" && isAdmin(uid)) {
      setSetting("rules_text", text); sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, "✅ Rules আপডেট হয়েছে।");
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }
    if (session?.step === "admin_text_support" && isAdmin(uid)) {
      setSetting("support_text", text); sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, "✅ Support Text আপডেট হয়েছে।");
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

    // --- Admin Add BINs ---
    if (session?.step === "admin_add_bins" && isAdmin(uid)) {
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      let count = 0;
      db.transaction(() => {
        for (const line of lines) {
          const parts = line.split("|").map(s => s.trim());
          const binNumber = parts[0];
          if (!/^\d{4,15}$/.test(binNumber)) continue;
          db.prepare("INSERT INTO bins(bin_number, bank_name, country, note, added_by) VALUES(?,?,?,?,?)")
            .run(binNumber, parts[1] || "", parts[2] || "", parts[3] || "", uid);
          count++;
        }
      })();
      sessions.delete(uid);
      const successMsg = await bot.sendMessage(uid, `✅ ${count}টি BIN যোগ করা হয়েছে।`);
      setTimeout(() => { sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300); adminPanel(uid); }, 1000);
      return;
    }

    // --- Admin Adjust Balance ---
    if (session?.step === "admin_adjust_uid" && isAdmin(uid)) {
      const target = Number(text);
      if (!db.prepare("SELECT id FROM users WHERE id=?").get(target)) {
        sessions.delete(uid);
        return bot.sendMessage(uid, "❌ ইউজার পাওয়া যায়নি।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      const promptMsg = await bot.sendMessage(uid, `বর্তমান ব্যালেন্স: ${fmt(balanceOf(target))}\n\nকত টাকা যোগ/বিয়োগ করবেন? (বিয়োগে মাইনাস দিন)`);
      sessions.set(uid, { step: "admin_adjust_amount", targetUid: target, lastPromptId: promptMsg.message_id });
      setTimeout(() => sequentialDelete(uid, [session.lastPromptId, msg.message_id], 300), 500);
      return;
    }
    if (session?.step === "admin_adjust_amount" && isAdmin(uid)) {
      const amount = toPaisa(Number(text));
      if (isNaN(amount)) {
        return bot.sendMessage(uid, "সঠিক সংখ্যা দিন।")
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      }
      const target = session.targetUid;
      const res = db.transaction(() => {
        const current = balanceOf(target);
        if (current + amount < 0) return { error: "NEG" };
        db.prepare("UPDATE users SET balance=? WHERE id=?").run(current + amount, target);
        db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(target, "ADJUSTMENT", amount, `ADJ-${Date.now()}`, `Admin adjustment`);
        return { nw: current + amount };
      })();
      sessions.delete(uid);
      if (res.error) return bot.sendMessage(uid, "❌ ব্যালেন্স ০ এর নিচে যাবে না।");
      logAdmin(`Adjusted balance of user ${target} by ${fmt(amount)}`);
      const successMsg = await bot.sendMessage(uid, `✅ ব্যালেন্স আপডেট হয়েছে: ${fmt(res.nw)}`);
      safeNotify(target, `⚠️ অ্যাডমিন আপনার ব্যালেন্স আপডেট করেছেন। নতুন ব্যালেন্স: ${fmt(res.nw)}`);
      setTimeout(() => sequentialDelete(uid, [successMsg.message_id, session.lastPromptId, msg.message_id], 300), 1000);
      return;
    }

  } catch (error) { console.error(error); }
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
    if (data === "panel:close") { await answer("Closed"); return deleteMsg(); }
    if (data === "msg:delete") { await answer("Deleted"); return deleteMsg(); }

    if (data !== "check_join") {
      if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
    }

    if (data === "check_join") {
      if (await checkMembership(uid)) { 
        await answer("✅ ধন্যবাদ!"); 
        return bot.sendMessage(uid, "✨ <b>স্বাগতম!</b> আপনি এখন বটের সমস্ত ফিচার ব্যবহার করতে পারবেন।", { parse_mode: "HTML", ...getHome(uid) }); 
      }
      return answer("❌ আপনি জয়েন করেননি।", true);
    }

    const dbUser = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
    if (dbUser?.is_banned && !isAdmin(uid)) return answer("🚫 আপনি ব্যানড।", true);
    ensureUser(query.from);

    // === User Actions ===
    if (data.startsWith("deposit:method:")) {
      const method = data.split(":")[2];
      sessions.set(uid, { step: "deposit_amount", method });
      const num = method === "bKash" ? BKASH_NUMBER : NAGAD_NUMBER;
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `💳 <b>${method} ডিপোজিট</b>\n\n${num ? `📞 <b>নম্বর:</b> <code>${num}</code>\n\n` : ''}টাকা পাঠিয়ে কত টাকা পাঠিয়েছেন তা লিখুন:`, { parse_mode: "HTML" });
    }

    // === Coupon Mode Selection ===
    if (data === "coupon_mode:buy") {
      const menu = { reply_markup: { inline_keyboard: [
        [{ text: "$4 Coupon", callback_data: "coupon:4" }, { text: "$5 Coupon", callback_data: "coupon:5" }],
        [{ text: "$10 Coupon", callback_data: "coupon:10" }, { text: "$20 Coupon", callback_data: "coupon:20" }],
        [{ text: "$25 Coupon", callback_data: "coupon:25" }],
        [{ text: "🔙 Back", callback_data: "coupon_mode:back" }, { text: "❌ Close", callback_data: "msg:delete" }]
      ] } };
      await answer(); deleteMsg();
      return bot.sendMessage(uid, "🛒 <b>আপনার পছন্দের Coupon নির্বাচন করুন:</b>", { parse_mode: "HTML", ...menu });
    }
    if (data === "coupon_mode:sell") {
      const btns = [4,5,10,20,25].map(c => {
        const sp = Number(getSetting(`sell_price_${c}`));
        if (sp <= 0) return null;
        return [{ text: `$${c} Coupon — রেট: ৳${(sp/100).toFixed(2)}`, callback_data: `sell:coupon:${c}` }];
      }).filter(Boolean);
      btns.push([{ text: "🔙 Back", callback_data: "coupon_mode:back" }, { text: "❌ Close", callback_data: "msg:delete" }]);
      await answer(); deleteMsg();
      if (btns.length === 1) return bot.sendMessage(uid, "😔 <b>এই মুহূর্তে কোনো কুপন কেনা হচ্ছে না।</b>", { parse_mode: "HTML", ...getHome(uid) });
      return bot.sendMessage(uid, "💰 <b>কোন কুপন বিক্রি করতে চান?</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } });
    }
    if (data === "coupon_mode:back") {
      await answer(); deleteMsg();
      return bot.sendMessage(uid, "🎮 <b>COD Coupons</b>\n\nআপনি কী করতে চান?", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "🛒 কিনুন (Buy)", callback_data: "coupon_mode:buy" }],
          [{ text: "💰 বিক্রি করুন (Sell)", callback_data: "coupon_mode:sell" }],
          [{ text: "❌ Close", callback_data: "msg:delete" }]
        ]}
      });
    }

    // === Sell Coupon Selection ===
    if (data.startsWith("sell:coupon:")) {
      const c = Number(data.split(":")[2]);
      const sp = Number(getSetting(`sell_price_${c}`));
      if (sp <= 0) return answer("এই কুপন এখন কেনা হচ্ছে না।", true);
      sessions.set(uid, { step: "sell_qty", coupon: c, sellPrice: sp });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `💰 <b>$${c} কুপন বিক্রি</b>\n\nপ্রতি কুপনের রেট: <b>৳${(sp/100).toFixed(2)}</b>\n\nকতটি বিক্রি করতে চান?`, { parse_mode: "HTML" });
    }

    // === Buy Coupon ===
    if (data.startsWith("coupon:")) {
      const coupon = Number(data.split(":")[1]);
      const stock = Number(getSetting(`stock_${coupon}`));
      const price = Number(getSetting(`price_${coupon}`));
      if (stock <= 0) return answer("❌ এই কুপনটি স্টক আউট!", true);
      if (price === 0) {
        const existing = db.prepare(`SELECT id FROM prices WHERE uid=? AND coupon=? AND status IN ('WAITING','SENT','CONFIRMED')`).get(uid, coupon);
        if (existing) return answer("আপনার আগের রিকোয়েস্ট পেন্ডিং এ আছে।", true);
        const res = db.prepare("INSERT INTO prices(uid,coupon) VALUES(?,?)").run(uid, coupon);
        await answer("Request sent"); deleteMsg();
        sendAdmin(`💬 <b>PRICE REQUEST</b>\nUser: <code>${uid}</code>\nCoupon: $${coupon}`, {
          inline_keyboard: [[{ text: "Reply Price", callback_data: `price:reply:${res.lastInsertRowid}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]]
        });
        return bot.sendMessage(uid, "✅ <b>দাম জানতে রিকোয়েস্ট পাঠানো হয়েছে।</b> এডমিন শীঘ্রই রিপ্লাই দেবে।", { parse_mode: "HTML" })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
      }
      sessions.set(uid, { step: "coupon_qty", coupon: coupon });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `🎮 <b>$${coupon} কুপন</b> (স্টক: ${stock})\n\nআপনি কতগুলো কুপন নিতে চান? (শুধু সংখ্যা লিখুন)`, { parse_mode: "HTML" });
    }

    // === Buy Options ===
    if (data.startsWith("buy:")) {
      const [, source, coupon, qty, total] = data.split(":");
      const cQty = parseInt(qty);
      const cTotal = parseInt(total);

      if (source === "admin") {
        if (!ADMIN_WHATSAPP) return answer("Admin WhatsApp number not set!", true);
        const waText = encodeURIComponent(`আসসালামু আলাইকুম, আমি বট থেকে ${qty}টি $${coupon} কুপন কিনতে চাই। (মোট দাম: ৳${cTotal/100})`);
        const waUrl = `https://wa.me/${ADMIN_WHATSAPP.replace(/[^0-9]/g, '')}?text=${waText}`;
        await answer(); deleteMsg();
        return bot.sendMessage(uid, `📞 <b>সরাসরি কিনতে নিচের বাটনে ক্লিক করে WhatsApp এ মেসেজ দিন:</b>`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "💬 WhatsApp-এ মেসেজ দিন", url: waUrl }]] }
        });
      }

      if (source === "bot") {
        if (balanceOf(uid) < cTotal) {
          await answer("ব্যালেন্স যথেষ্ট নয়!", true);
          return bot.sendMessage(uid, `❌ <b>আপনার ব্যালেন্স যথেষ্ট নয়।</b>\n\nপ্রয়োজন: ${fmt(cTotal)}\nআপনার আছে: ${fmt(balanceOf(uid))}`, { parse_mode: "HTML" })
            .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
        }
        const result = db.transaction(() => {
          const currentStock = Number(getSetting(`stock_${coupon}`));
          if (currentStock < cQty) return { error: "STOCK" };
          setSetting(`stock_${coupon}`, currentStock - cQty);
          const priceRes = db.prepare("INSERT INTO prices(uid,coupon,price,status) VALUES(?,?,?,'ORDERED')").run(uid, coupon, cTotal);
          const priceId = priceRes.lastInsertRowid;
          const ordRes = db.prepare("INSERT INTO orders(uid, price_id, coupon, qty, amount) VALUES(?,?,?,?,?)").run(uid, priceId, coupon, cQty, cTotal);
          return { orderId: ordRes.lastInsertRowid };
        })();
        if (result.error) return answer("স্টক শেষ!", true);
        await answer("Order placed!"); deleteMsg();
        bot.sendMessage(uid, `🧾 <b>আপনার Order #${result.orderId} প্লেস হয়েছে।</b>\n\n⏳ এডমিন এপ্রুভ করলে ডেলিভারি দেওয়া হবে।`, { parse_mode: "HTML", ...getHome(uid) })
          .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 5000));
        return sendAdmin(`🛒 <b>NEW COUPON ORDER #${result.orderId}</b>\n👤 ${esc(displayName(query.from))}\n🆔 <code>${uid}</code>\nCoupon: $${coupon} (${cQty} pcs)\nমোট দাম: <b>${fmt(cTotal)}</b>`, {
          inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${result.orderId}` }, { text: "❌ Reject", callback_data: `order:reject:${result.orderId}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]]
        });
      }
    }

    if (data.startsWith("price:confirm:")) {
      const reqId = Number(data.split(":")[2]);
      const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(reqId, uid);
      if (!req) return answer("Request expired", true);
      if (balanceOf(uid) < req.price) return answer("ব্যালেন্স নেই।", true);
      await answer(); deleteMsg();
      sessions.set(uid, { step: "order_delivery_method", priceId: req.id });
      return bot.sendMessage(uid, "🚚 <b>ডেলিভারি মাধ্যম বেছে নিন:</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🎮 Game ID", callback_data: `delivery:gameid:${req.id}` }], [{ text: "📧 Gmail", callback_data: `delivery:gmail:${req.id}` }], [{ text: "Cancel", callback_data: `msg:delete` }]] }
      });
    }

    if (data.startsWith("delivery:")) {
      const [, type, id] = data.split(":");
      const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(Number(id), uid);
      if (!req) return answer("Expired", true);
      sessions.set(uid, { step: type === "gameid" ? "order_gameid" : "order_gmail_email", priceId: req.id });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, type === "gameid" ? "🎮 <b>আপনার Game ID দিন:</b>" : "📧 <b>আপনার Gmail দিন:</b>", { parse_mode: "HTML" });
    }

    // ==========================================
    // ADMIN CALLBACKS
    // ==========================================
    if (!isAdmin(uid)) return answer("শুধু Admin", true);

    if (data === "admin:bins") {
      const c = db.prepare("SELECT COUNT(*) AS n FROM bins").get().n;
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `🔢 <b>BIN Management</b>\n\n📊 মোট BIN: <code>${c}</code>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "➕ Add BINs", callback_data: "bin:add" }],
          [{ text: "📋 View All BINs", callback_data: "bin:view" }],
          [{ text: "🗑 Delete All BINs", callback_data: "bin:delall" }],
          [{ text: "💵 Card Make Price", callback_data: "bin:set_price" }],
          [{ text: "❌ Close", callback_data: "msg:delete" }]
        ]}
      });
    }
    if (data === "bin:add") {
      const pMsg = await bot.sendMessage(uid,
        `➕ <b>BIN যোগ করুন</b>\n\nপ্রতি লাইনে একটি BIN:\n<code>BIN</code> অথবা <code>BIN | Bank | Country | Note</code>\n\n` +
        `উদাহরণ:\n<code>2345666</code>\n<code>246666 | Chase | US | Visa Signature</code>`,
        { parse_mode: "HTML" }
      );
      sessions.set(uid, { step: "admin_add_bins", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }
    if (data === "bin:view") {
      const bins = db.prepare("SELECT * FROM bins ORDER BY id DESC LIMIT 30").all();
      await answer(); deleteMsg();
      if (!bins.length) return bot.sendMessage(uid, "কোনো BIN নেই।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      for (const b of bins) {
        let txt = `#${b.id} <code>${esc(b.bin_number)}</code>`;
        if (b.bank_name) txt += ` | 🏦 ${esc(b.bank_name)}`;
        if (b.country) txt += ` | 🌍 ${esc(b.country)}`;
        if (b.note) txt += `\n📝 ${esc(b.note)}`;
        bot.sendMessage(uid, txt, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🗑 Delete", callback_data: `bin:del:${b.id}` }], [{ text: "❌ Close", callback_data: "msg:delete" }]] }
        });
      }
      return;
    }
    if (data === "bin:delall") {
      const c = db.prepare("DELETE FROM bins").run().changes;
      await answer(`Deleted ${c} BINs`);
      return deleteMsg();
    }
    if (data.startsWith("bin:del:")) {
      const bid = Number(data.split(":")[2]);
      db.prepare("DELETE FROM bins WHERE id=?").run(bid);
      await answer("Deleted");
      return deleteMsg();
    }
    if (data === "bin:set_price") {
      const p = Number(getSetting('card_make_price'));
      const pMsg = await bot.sendMessage(uid, `💵 বর্তমান Card Make Price: <b>${p > 0 ? fmt(p) : 'ফ্রি'}</b>\n\nনতুন দাম লিখুন (0 = ফ্রি):`, { parse_mode: "HTML" });
      sessions.set(uid, { step: "admin_set_card_price", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }

    if (data === "admin:us_addresses") {
      const c = db.prepare("SELECT COUNT(*) AS n FROM us_addresses").get().n;
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `🇺🇸 <b>USA Address Management</b>\n\n📊 মোট Address: <code>${c}</code>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "➕ Add Address", callback_data: "us_addr:add" }],
          [{ text: "🗑 Delete All", callback_data: "us_addr:delall" }],
          [{ text: "❌ Close", callback_data: "msg:delete" }]
        ]}
      });
    }
    if (data === "us_addr:add") {
      const pMsg = await bot.sendMessage(uid, `➕ <b>Add USA Address</b>\n\nআপনি একসাথে একাধিক এড্রেস দিতে পারেন। প্রতিটা এড্রেসের মাঝে একটি খালি লাইন (Enter) দিন।\n\nউদাহরণ:\nJohn Doe\n123 Main St, New York, NY 10001\n\nJane Smith\n456 Oak Ave, Los Angeles, CA 90001`, { parse_mode: "HTML" });
      sessions.set(uid, { step: "admin_add_us_addr", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }
    if (data === "us_addr:delall") {
      const c = db.prepare("DELETE FROM us_addresses").run().changes;
      await answer(`Deleted ${c} Addresses`);
      return deleteMsg();
    }

    if (data === "list:sell_requests") {
      const rows = db.prepare("SELECT * FROM sell_requests WHERE status='PENDING' LIMIT 10").all();
      await answer(); deleteMsg();
      if (!rows.length) return bot.sendMessage(uid, "Pending Sell Request নেই।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      rows.forEach(r => bot.sendMessage(uid, `💰 <b>Sell Request #${r.id}</b>\nUser: <code>${r.uid}</code>\nCoupon: $${r.coupon} × ${r.qty}\nপেমেন্ট: ${fmt(r.amount)}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `sell:approve:${r.id}` }, { text: "❌ Reject", callback_data: `sell:reject:${r.id}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
      }));
      return;
    }
    if (data.startsWith("sell:approve:") || data.startsWith("sell:reject:")) {
      const [, action, rid] = data.split(":");
      const res = db.transaction(() => {
        const s = db.prepare("SELECT * FROM sell_requests WHERE id=? AND status='PENDING'").get(rid);
        if (!s) return { err: 1 };
        if (action === "approve") {
          const curStock = Number(getSetting(`stock_${s.coupon}`));
          setSetting(`stock_${s.coupon}`, curStock + s.qty);
          db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(s.amount, s.uid);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(s.uid, "DEPOSIT", s.amount, `SELL-${rid}`, `Sold $${s.coupon} x${s.qty}`);
        }
        db.prepare("UPDATE sell_requests SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(action === "approve" ? "APPROVED" : "REJECTED", uid, rid);
        return { s };
      })();
      if (res.err) return answer("Already reviewed", true);
      await answer("Done"); logAdmin(`Sell #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Sell #${rid} APPROVED</b>` : `❌ <b>Sell #${rid} REJECTED</b>`);
      safeNotify(res.s.uid, action === "approve" ? `✅ আপনার Sell #${rid} অ্যাপ্রুভড।\n💰 নতুন ব্যালেন্স: ${fmt(balanceOf(res.s.uid))}` : `❌ আপনার Sell #${rid} রিজেক্টেড।`);
      return;
    }
    if (data === "admin:set_sell_prices") {
      await answer(); deleteMsg();
      const btns = [4,5,10,20,25].map(c => {
        const sp = Number(getSetting(`sell_price_${c}`));
        return [{ text: `$${c} — ${sp > 0 ? '৳' + (sp/100).toFixed(2) : 'বন্ধ'}`, callback_data: `admin:sell_price_set:${c}` }];
      });
      btns.push([{ text: "❌ Close", callback_data: "msg:delete" }]);
      return bot.sendMessage(uid, "💰 <b>কোন কুপনের Buy Rate সেট করবেন?</b>\n\n(0 = কেনা বন্ধ)", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } });
    }
    if (data.startsWith("admin:sell_price_set:")) {
      const c = Number(data.split(":")[2]);
      const pMsg = await bot.sendMessage(uid, `$${c} কুপনের Buy Rate (প্রতি কুপনে কত ৳ দিবেন)? (0 = বন্ধ):`);
      sessions.set(uid, { step: "admin_set_sell_price", coupon: c, lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }

    if (data === "admin:stats") {
      const users = db.prepare("SELECT COUNT(*) c FROM users").get().c;
      const dep = db.prepare("SELECT COUNT(*) c, SUM(amount) s FROM deposits WHERE status='APPROVED'").get();
      const ord = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='COMPLETED'").get().c;
      const qst = db.prepare("SELECT COUNT(*) c FROM quests WHERE status='COMPLETED'").get().c;
      const sell = db.prepare("SELECT COUNT(*) c FROM sell_requests WHERE status='APPROVED'").get().c;
      await answer(); deleteMsg();
      return bot.sendMessage(uid, `📊 <b>Bot Statistics</b>\n\n👥 Users: ${users}\n💳 Deposits: ${dep.c} (${fmt(dep.s || 0)})\n🛒 Orders: ${ord}\n🎯 Quests: ${qst}\n💰 Sells: ${sell}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "panel:back" }], [{ text: "❌ Close", callback_data: "msg:delete" }]] } });
    }
    if (data === "admin:broadcast") {
      sessions.set(uid, { step: "broadcast_msg" }); await answer(); deleteMsg();
      return bot.sendMessage(uid, "📣 সব ইউজারকে যে মেসেজটি পাঠাতে চান সেটি লিখুন (বাতিল: /cancel):");
    }
    if (data === "list:users") {
      const users = db.prepare("SELECT id, name, username, balance FROM users ORDER BY id DESC LIMIT 20").all();
      let txt = `👥 <b>Recent Users (Last 20)</b>\n\n`;
      users.forEach(u => { txt += `<code>${u.id}</code> - ${esc(u.name)} (@${esc(u.username || 'n/a')}) - ${fmt(u.balance)}\n`; });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Close", callback_data: "msg:delete" }]] } });
    }
    if (data === "admin:ban") {
      const pMsg = await bot.sendMessage(uid, "যে ইউজারকে Ban/Unban করবেন তার Telegram ID দিন:");
      sessions.set(uid, { step: "admin_ban_uid", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }
    if (data === "admin:texts") {
      await answer(); deleteMsg();
      return bot.sendMessage(uid, "কোন টেক্সট এডিট করবেন?", { reply_markup: { inline_keyboard: [[{ text: "📖 Rules", callback_data: "admin:text:rules" }], [{ text: "💬 Support", callback_data: "admin:text:support" }], [{ text: "❌ Close", callback_data: "msg:delete" }]] } });
    }
    if (data === "admin:text:rules") {
      const pMsg = await bot.sendMessage(uid, "নতুন Rules লিখুন:");
      sessions.set(uid, { step: "admin_text_rules", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg(); return;
    }
    if (data === "admin:text:support") {
      const pMsg = await bot.sendMessage(uid, "নতুন Support Text লিখুন:");
      sessions.set(uid, { step: "admin_text_support", lastPromptId: pMsg.message_id });
      await answer(); deleteMsg(); return;
    }
    if (data === "admin:set_prices") {
      await answer(); deleteMsg();
      const btns = [4,5,10,20,25].map(c => {
        const p = Number(getSetting(`price_${c}`));
        return [{ text: `$${c} (${p ? fmt(p) : 'Request'})`, callback_data: `admin:price_set:${c}` }];
      });
      btns.push([{ text: "❌ Close", callback_data: "msg:delete" }]);
      return bot.sendMessage(uid, "💵 <b>কোন কুপনের দাম সেট করবেন?</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } });
    }
    if (data.startsWith("admin:price_set:")) {
      const c = Number(data.split(":")[2]);
      const pMsg = await bot.sendMessage(uid, `$${c} কুপনের নতুন দাম (BDT)? (0 = রিকোয়েস্ট মোড):`);
      sessions.set(uid, { step: "admin_set_price", coupon: c, lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }
    if (data === "admin:set_stocks") {
      await answer(); deleteMsg();
      const btns = [4,5,10,20,25].map(c => {
        const s = Number(getSetting(`stock_${c}`));
        return [{ text: `$${c} (Stock: ${s})`, callback_data: `admin:stock_set:${c}` }];
      });
      btns.push([{ text: "❌ Close", callback_data: "msg:delete" }]);
      return bot.sendMessage(uid, "📦 <b>কোন কুপনের স্টক সেট করবেন?</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } });
    }
    if (data.startsWith("admin:stock_set:")) {
      const c = Number(data.split(":")[2]);
      const pMsg = await bot.sendMessage(uid, `$${c} কুপনের নতুন স্টক (সংখ্যা):`);
      sessions.set(uid, { step: "admin_set_stock", coupon: c, lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }

    if (data === "list:logs") {
      const logs = db.prepare("SELECT * FROM admin_logs ORDER BY id DESC LIMIT 10").all();
      let txt = `📜 <b>Admin Logs</b>\n\n`;
      logs.forEach(l => { txt += `⏰ ${l.created_at}\n📝 ${esc(l.action)}\n\n`; });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, txt, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Close", callback_data: "msg:delete" }]] } });
    }
    if (data === "list:support") {
      const tickets = db.prepare("SELECT * FROM support_tickets WHERE status='OPEN' ORDER BY id DESC LIMIT 10").all();
      if (!tickets.length) return answer("No open tickets", true);
      await answer(); deleteMsg();
      for (const t of tickets) {
        bot.sendMessage(uid, `🆘 <b>Ticket #${t.id}</b>\nUser: <code>${t.uid}</code>\n💬 ${esc(t.message)}`, {
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Reply", callback_data: `support:reply:${t.uid}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
        });
      } return;
    }
    if (data.startsWith("support:reply:")) {
      const target = Number(data.split(":")[2]);
      const pMsg = await bot.sendMessage(uid, `ইউজার ${target} কে রিপ্লাই লিখুন:`);
      sessions.set(uid, { step: "admin_reply_support", targetUid: target, lastPromptId: pMsg.message_id });
      await answer(); deleteMsg();
      return;
    }
    if (data.startsWith("price:reply:")) {
      const rid = Number(data.split(":")[2]);
      const pMsg = await bot.sendMessage(uid, `Price request #${rid}\nBDT দাম লিখুন:`);
      sessions.set(uid, { step: "admin_price", requestId: rid, priceMsgId: msgId, priceChatId: chatId, lastPromptId: pMsg.message_id });
      await answer();
      return;
    }

    if (data.startsWith("deposit:")) {
      const [, action, rid] = data.split(":");
      const res = db.transaction(() => {
        const d = db.prepare("SELECT * FROM deposits WHERE id=? AND status='PENDING'").get(rid);
        if (!d) return { err: 1 };
        db.prepare("UPDATE deposits SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(action === "approve" ? "APPROVED" : "REJECTED", uid, rid);
        if (action === "approve") {
          db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(d.amount, d.uid);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(d.uid, "DEPOSIT", d.amount, `DEP-${rid}`, `Deposit approved`);
        }
        return { d };
      })();
      if (res.err) return answer("Already reviewed", true);
      await answer("Done"); logAdmin(`Deposit #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Deposit #${rid} APPROVED</b>` : `❌ <b>Deposit #${rid} REJECTED</b>`);
      safeNotify(res.d.uid, action === "approve" ? `✅ ডিপোজিট #${rid} অ্যাপ্রুভড। নতুন ব্যালেন্স: ${fmt(balanceOf(res.d.uid))}` : `❌ ডিপোজিট #${rid} রিজেক্টেড।`);
      return;
    }

    if (data.startsWith("order:")) {
      const [, action, rid] = data.split(":");
      if (action === "complete") {
        const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='PROCESSING'").get(rid);
        if (!o) return answer("Not processing", true);
        db.prepare("UPDATE orders SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=?").run(rid);
        await answer("Done"); logAdmin(`Order #${rid} completed`);
        editAndAutoDelete(chatId, msgId, `✅ <b>Order #${rid} COMPLETED</b>`);
        safeNotify(o.uid, `✅ আপনার Order #${rid} সম্পন্ন হয়েছে!`);
        return;
      }
      const res = db.transaction(() => {
        const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='PENDING'").get(rid);
        if (!o) return { err: 1 };
        if (action === "approve") {
          const upd = db.prepare("UPDATE users SET balance=balance-? WHERE id=? AND balance>=?").run(o.amount, o.uid, o.amount);
          if (upd.changes === 0) return { err: 2 };
          db.prepare("UPDATE orders SET status='PROCESSING', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(uid, rid);
          db.prepare("UPDATE prices SET status='ORDERED' WHERE id=?").run(o.price_id);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(o.uid, "PURCHASE", -o.amount, `ORD-${rid}`, `Coupon purchase`);
        } else {
          const currentStock = Number(getSetting(`stock_${o.coupon}`));
          setSetting(`stock_${o.coupon}`, currentStock + (o.qty || 1));
          db.prepare("UPDATE orders SET status='REJECTED', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(uid, rid);
        }
        return { o };
      })();
      if (res.err === 2) return answer("❌ ইউজারের ব্যালেন্স যথেষ্ট নয়!", true);
      if (res.err) return answer("Already reviewed", true);
      await answer("Done"); logAdmin(`Order #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Order #${rid} → PROCESSING</b>` : `❌ <b>Order #${rid} REJECTED</b>`);
      if (action === "approve") {
        bot.sendMessage(chatId, `🔄 <b>Order #${rid} [PROCESSING]</b>\nUser: ${res.o.uid}\nকাজ শেষ হলে Complete চাপুন।`, {
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete", callback_data: `order:complete:${rid}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
        });
      }
      safeNotify(res.o.uid, action === "approve" ? `✅ আপনার অর্ডার #${rid} প্রসেসিং এ আছে।` : `❌ আপনার অর্ডার #${rid} বাতিল হয়েছে। (স্টক ফেরত দেওয়া হয়েছে)`);
      return;
    }

    if (data.startsWith("quest:")) {
      const [, action, rid] = data.split(":");
      if (action === "complete") {
        const q = db.prepare("SELECT * FROM quests WHERE id=? AND status='PROCESSING'").get(rid);
        if (!q) return answer("Not processing", true);
        db.prepare("UPDATE quests SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=?").run(rid);
        await answer("Done"); logAdmin(`Quest #${rid} completed`);
        editAndAutoDelete(chatId, msgId, `✅ <b>Quest #${rid} COMPLETED</b>`);
        safeNotify(q.uid, `✅ আপনার Quest #${rid} সম্পন্ন হয়েছে!`);
        return;
      }
      const res = db.transaction(() => {
        const q = db.prepare("SELECT * FROM quests WHERE id=? AND status='PENDING'").get(rid);
        if (!q) return { err: 1 };
        db.prepare("UPDATE quests SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(action === "approve" ? "PROCESSING" : "REJECTED", uid, rid);
        return { q };
      })();
      if (res.err) return answer("Already reviewed", true);
      await answer("Done"); logAdmin(`Quest #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Quest #${rid} → PROCESSING</b>` : `❌ <b>Quest #${rid} REJECTED</b>`);
      if (action === "approve") {
        bot.sendMessage(chatId, `🔄 <b>Quest #${rid} [PROCESSING]</b>\nUser: ${res.q.uid}\nকাজ শেষ হলে Complete চাপুন।`, {
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete", callback_data: `quest:complete:${rid}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
        });
      }
      safeNotify(res.q.uid, action === "approve" ? `✅ আপনার Quest #${rid} প্রসেসিং এ আছে।` : `❌ আপনার Quest #${rid} বাতিল হয়েছে।`);
      return;
    }

    if (data === "list:deposits") {
      const rows = db.prepare("SELECT * FROM deposits WHERE status='PENDING' LIMIT 10").all();
      await answer(); deleteMsg();
      if (!rows.length) return bot.sendMessage(uid, "Pending Deposit নেই।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      rows.forEach(r => bot.sendMessage(uid, `💳 <b>Deposit #${r.id}</b>\nUser: <code>${r.uid}</code>\n${r.method}: ${fmt(r.amount)}\nTRX: ${r.trx}`, {
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `deposit:approve:${r.id}` }, { text: "❌ Reject", callback_data: `deposit:reject:${r.id}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
      }));
      return;
    }
    if (data === "list:orders") {
      const rows = db.prepare("SELECT * FROM orders WHERE status='PENDING' LIMIT 10").all();
      await answer(); deleteMsg();
      if (!rows.length) return bot.sendMessage(uid, "Pending Order নেই।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      rows.forEach(r => bot.sendMessage(uid, `🛒 <b>Order #${r.id}</b>\nUser: <code>${r.uid}</code>\nCoupon: $${r.coupon} (${r.qty} pcs)\nদাম: ${fmt(r.amount)}\n${r.delivery_method ? `${r.delivery_method}: ${r.delivery_info}` : ''}`, {
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${r.id}` }, { text: "❌ Reject", callback_data: `order:reject:${r.id}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
      }));
      return;
    }
    if (data === "list:quests") {
      const rows = db.prepare("SELECT * FROM quests WHERE status='PENDING' LIMIT 10").all();
      await answer(); deleteMsg();
      if (!rows.length) return bot.sendMessage(uid, "Pending Quest নেই।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      rows.forEach(r => {
        bot.sendPhoto(uid, r.screenshot, {
          caption: `🎯 <b>Quest #${r.id}</b>\nUser: <code>${r.uid}</code>\nGmail: ${r.gmail}\nPass: ${r.password}`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `quest:approve:${r.id}` }, { text: "❌ Reject", callback_data: `quest:reject:${r.id}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
        });
      });
      return;
    }
    if (data === "list:in_progress_orders" || data === "list:in_progress_quests") {
      const table = data.includes("orders") ? "orders" : "quests";
      const rows = db.prepare(`SELECT * FROM ${table} WHERE status='PROCESSING' LIMIT 10`).all();
      await answer(); deleteMsg();
      if (!rows.length) return bot.sendMessage(uid, "In-Progress নেই।")
        .then(m => setTimeout(() => bot.deleteMessage(uid, m.message_id).catch(() => {}), 3000));
      rows.forEach(r => bot.sendMessage(uid, `🔄 <b>${table.slice(0,-1).toUpperCase()} #${r.id}</b>\nUser: <code>${r.uid}</code>`, {
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete", callback_data: `${table.slice(0,-1)}:complete:${r.id}` }], [{ text: "🗑 Delete", callback_data: "msg:delete" }]] }
      }));
      return;
    }

    if (data === "panel:back") { await answer(); return deleteMsg().then(() => adminPanel(uid)); }

  } catch (error) { console.error("Callback Error:", error); answer("Error", true); }
});

// ===== Error Handling & Bot Startup Broadcast =====
bot.on("polling_error", e => console.error("Polling error:", e?.message || e));

bot.getMe().then(async (info) => {
  console.log(`✅ BOT CONNECTED: @${info.username}`);
  
  const adminMsg = `🚀 <b>বট সফলভাবে আপডেট হয়েছে!</b>\n\n` +
    `✨ <b>নতুন ফিচার:</b>\n` +
    `• 🚀 Start / Restart বাটন যুক্ত হয়েছে\n` +
    `• 🇺🇸 USA Fake Address মেনু যুক্ত হয়েছে\n` +
    `• কুপন রেট ডিসপ্লে ফিক্স করা হয়েছে\n` +
    `• HTML Parse Error ফিক্স করা হয়েছে\n\n` +
    `⏳ সমস্ত ইউজারকে অটো-নোটিফিকেশন পাঠানো হচ্ছে...`;

  bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: "HTML" }).then(m => setTimeout(() => bot.deleteMessage(ADMIN_ID, m.message_id).catch(() => {}), 15000));

  // Broadcast to all users on restart
  const users = db.prepare("SELECT id FROM users").all();
  const updateMsg = `🚀 <b>বট নতুন আপডেট পেয়েছে!</b>\n\n` +
    `✨ <b>নতুন ফিচার:</b>\n` +
    `• 🇺🇸 USA Fake Address যুক্ত হয়েছে\n` +
    `• কুপন রেট ও ডিজাইন ফিক্স\n` +
    `• বট এখন আগের চেয়ে দ্রুত কাজ করবে\n\n` +
    `👇 <i>যেকোনো সমস্যায় 🚀 Start / Restart চাপুন। বার বার /start লিখতে হবে না!</i>`;

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