// PLAY POINT QUEST HUB — Complete Telegram Bot Code

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");

const { BOT_TOKEN, ADMIN_CHAT_ID, SUPPORT_USERNAME = "", BKASH_NUMBER = "", NAGAD_NUMBER = "" } = process.env;
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
  amount INTEGER NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')),
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
CREATE TABLE IF NOT EXISTS master_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_code TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','CLAIMED')), claimed_by INTEGER, claimed_at TEXT,
  added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(claimed_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, action TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, message TEXT, reply TEXT, status TEXT DEFAULT 'OPEN', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, replied_at TEXT
);
`);

// ===== Database Migrations (Safety for old DBs) =====
try { db.exec("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0;"); } catch(e) {}
const defaultSettings = [
  ['rules_text', '📖 <b>RULES</b>\n\n1. সঠিক Transaction ID জমা দিন।\n2. Admin যাচাই করার পরই ব্যালেন্স যোগ হবে।\n3. PIN, OTP বা পাসওয়ার্ড কারও সাথে শেয়ার করবেন না।\n4. Coupon-এর দাম Admin নিশ্চিত করবেন।\n5. অর্ডার অনুমোদনের আগে ব্যালেন্স কাটা হবে না।'],
  ['support_text', '💬 Support-এর জন্য Admin-কে মেসেজ করুন।'],
  ['price_4', '0'], ['stock_4', '0'], ['price_5', '0'], ['stock_5', '0'],
  ['price_10', '0'], ['stock_10', '0'], ['price_20', '0'], ['stock_20', '0'], ['price_25', '0'], ['stock_25', '0']
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
  catch (err) { console.error(`Notify ${chatId} failed:`, err.message); return false; }
}
function sendAdmin(text, reply_markup) {
  return safeNotify(ADMIN_ID, text, { parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) });
}
function parseMoney(text) {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return null;
  const v = Number(text);
  if (!Number.isFinite(v) || v <= 0 || v > 100000) return null;
  return toPaisa(v);
}

// Auto Delete Logic (5 seconds)
async function editAndAutoDelete(chatId, messageId, newText, delayMs = 5000, editOptions = {}) {
  try {
    await bot.editMessageText(newText, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", ...editOptions });
  } catch (e) {} // Ignore edit errors (e.g. if message has photo)
  setTimeout(() => { bot.deleteMessage(chatId, messageId).catch(() => {}); }, delayMs);
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
  return bot.sendMessage(chatId, "⚠️ বট ব্যবহার করতে হলে আপনাকে আমাদের চ্যানেলে জয়েন করতে হবে।", {
    reply_markup: { inline_keyboard: [[{ text: "📢 Join Channel", url: "https://t.me/google_play_point_01" }], [{ text: "✅ Check Again", callback_data: "check_join" }]] }
  });
}

// ===== Keyboards =====
const getHome = (uid) => {
  const keyboard = [["💰 My Balance", "➕ Add Balance"], ["🎮 COD Coupons", "🎁 Free Master Card"], ["🎯 Quest Complete", "📜 Transactions"], ["💬 Support", "📖 Rules"], ["🔄 Restart Bot"]];
  if (isAdmin(uid)) keyboard.push(["🛠 Admin Menu"]);
  return { reply_markup: { keyboard, resize_keyboard: true } };
};
const MENU_BUTTONS = new Set(["💰 My Balance","➕ Add Balance","🎮 COD Coupons","🎁 Free Master Card","🎯 Quest Complete","📜 Transactions","💬 Support","📖 Rules","🔄 Restart Bot","🛠 Admin Menu"]);

// Admin Panel (New Layout + Close Button)
function adminPanel(chatId) {
  return bot.sendMessage(chatId, "🛠 <b>ADMIN PANEL</b>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📊 Statistics", callback_data: "admin:stats" }, { text: "📣 Broadcast", callback_data: "admin:broadcast" }],
      [{ text: "📥 Deposits", callback_data: "list:deposits" }, { text: "💬 Price Requests", callback_data: "list:prices" }],
      [{ text: "🛒 Pending Orders", callback_data: "list:orders" }, { text: "🔄 In Progress Orders", callback_data: "list:in_progress_orders" }],
      [{ text: "✅ Completed Orders", callback_data: "list:completed_orders" }, { text: "🎯 Pending Quests", callback_data: "list:quests" }],
      [{ text: "🔄 In Progress Quests", callback_data: "list:in_progress_quests" }, { text: "🆘 Support Inbox", callback_data: "list:support" }],
      [{ text: "⚙️ Fixed Prices", callback_data: "admin:prices" }, { text: "🎁 Card Management", callback_data: "admin:cards" }],
      [{ text: "👥 All Users", callback_data: "list:users" }, { text: "🚫 Ban/Unban", callback_data: "admin:ban" }],
      [{ text: "📝 Edit Texts", callback_data: "admin:texts" }, { text: "📜 Admin Logs", callback_data: "list:logs" }],
      [{ text: "❌ Close Panel", callback_data: "panel:close" }]
    ]}
  });
}

// ===== Bot Commands =====
bot.onText(/^\/start(@\w+)?$/, async msg => {
  if (!msg.from?.id) return;
  const uid = msg.from.id;
  if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
  
  const user = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
  if (user?.is_banned) return bot.sendMessage(uid, "🚫 আপনাকে বট থেকে ব্যান করা হয়েছে।");

  ensureUser(msg.from);
  sessions.delete(uid);
  bot.sendMessage(msg.chat.id, `আসসালামু আলাইকুম, ${esc(msg.from.first_name || "বন্ধু")}!\n\n💰 আপনার ব্যালেন্স: <b>${fmt(balanceOf(uid))}</b>`, { parse_mode: "HTML", ...getHome(uid) });
});

bot.onText(/^\/admin(@\w+)?$/, msg => {
  if (isAdmin(msg.from.id)) return adminPanel(msg.chat.id);
});

bot.onText(/^\/cancel(@\w+)?$/, msg => {
  sessions.delete(msg.from.id);
  bot.sendMessage(msg.from.id, "প্রক্রিয়াটি বাতিল হয়েছে।", getHome(msg.from.id));
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

    // Photo Handler (Quest or Support)
    if (msg.photo) {
      if (session?.step === "quest_screenshot") {
        session.screenshot = msg.photo[msg.photo.length - 1].file_id;
        session.step = "quest_gmail";
        return bot.sendMessage(uid, "✅ স্ক্রিনশট গ্রহণ করা হয়েছে।\n\nএখন আপনার Gmail দিন।");
      }
      if (session?.step === "support_msg") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        db.prepare("INSERT INTO support_tickets(uid, message) VALUES(?, ?)").run(uid, `[Photo] ${fileId}`);
        sendAdmin(`🆘 <b>Support Ticket</b>\n👤 User: <code>${uid}</code>\n📷 ছবি পাঠানো হয়েছে`, {
          inline_keyboard: [[{ text: "💬 Reply", callback_data: `support:reply:${uid}` }]]
        });
        bot.sendPhoto(ADMIN_ID, fileId);
        sessions.delete(uid);
        return bot.sendMessage(uid, "✅ আপনার মেসেজ পাঠানো হয়েছে।", getHome(uid));
      }
      if (session?.step === "admin_reply_support") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(session.targetUid, fileId, { caption: "💬 Admin-এর রিপ্লাই" });
        db.prepare("UPDATE support_tickets SET status='CLOSED', reply=? WHERE uid=? AND status='OPEN'").run(`[Photo] ${fileId}`, session.targetUid);
        sessions.delete(uid);
        return bot.sendMessage(uid, "✅ রিপ্লাই পাঠানো হয়েছে।");
      }
      return;
    }

    if (!msg.text || msg.text.startsWith("/")) return;

    // Menu Buttons
    if (MENU_BUTTONS.has(text)) {
      sessions.delete(uid);
      if (text === "🛠 Admin Menu") { if (isAdmin(uid)) return adminPanel(uid); return; }
      if (text === "🔄 Restart Bot") return bot.sendMessage(uid, `🔄 রিস্টার্ট হয়েছে।\n💰 ব্যালেন্স: ${fmt(balanceOf(uid))}`, getHome(uid));
      if (text === "💰 My Balance") return bot.sendMessage(uid, `💰 আপনার ব্যালেন্স: ${fmt(balanceOf(uid))}`, getHome(uid));
      if (text === "➕ Add Balance") {
        return bot.sendMessage(uid, "পেমেন্টের মাধ্যম বেছে নিন।", { reply_markup: { inline_keyboard: [[{ text: "bKash", callback_data: "deposit:method:bKash" }], [{ text: "Nagad", callback_data: "deposit:method:Nagad" }]] }});
      }
      if (text === "🎯 Quest Complete") {
        sessions.set(uid, { step: "quest_screenshot" });
        return bot.sendMessage(uid, "🎯 <b>Quest Complete</b>\n\nকুইস্ট সম্পন্ন করতে ১০৳ ফি দিতে হবে।\n\nঅ্যাডমিনের নম্বরে ১০৳ পাঠিয়ে পেমেন্টের স্ক্রিনশট এখানে পাঠান।", { parse_mode: "HTML" });
      }
      if (text === "🎁 Free Master Card") {
        const claimed = db.prepare("SELECT * FROM master_cards WHERE claimed_by=? ORDER BY claimed_at DESC LIMIT 1").get(uid);
        if (claimed) return bot.sendMessage(uid, `🎁 আপনি ইতিমধ্যে কার্ড নিয়েছেন:\n🎫 <code>${esc(claimed.card_code)}</code>`, { parse_mode: "HTML", ...getHome(uid) });
        const avail = db.prepare("SELECT COUNT(*) AS c FROM master_cards WHERE status='AVAILABLE'").get();
        if (!avail.c) return bot.sendMessage(uid, "😔 স্টকে কার্ড নেই।", getHome(uid));

        const result = db.transaction(() => {
          const card = db.prepare("SELECT * FROM master_cards WHERE status='AVAILABLE' ORDER BY id LIMIT 1").get();
          if (!card) return { error: "OOS" };
          db.prepare("UPDATE master_cards SET status='CLAIMED', claimed_by=?, claimed_at=CURRENT_TIMESTAMP WHERE id=? AND status='AVAILABLE'").run(uid, card.id);
          return { card };
        })();
        if (result.error) return bot.sendMessage(uid, "😔 কার্ডটি এইমাত্র কেউ নিয়ে নিয়েছে।", getHome(uid));
        return bot.sendMessage(uid, `🎉 <b>অভিনন্দন!</b>\n\n🎫 কার্ড: <code>${esc(result.card.card_code)}</code>\n${result.card.note ? `📝 নোট: ${esc(result.card.note)}` : ''}`, { parse_mode: "HTML", ...getHome(uid) });
      }
      if (text === "🎮 COD Coupons") {
        const menu = { reply_markup: { inline_keyboard: [[{ text: "$4 Coupon", callback_data: "coupon:4" }, { text: "$5 Coupon", callback_data: "coupon:5" }], [{ text: "$10 Coupon", callback_data: "coupon:10" }, { text: "$20 Coupon", callback_data: "coupon:20" }], [{ text: "$25 Coupon", callback_data: "coupon:25" }]] } };
        return bot.sendMessage(uid, "আপনার পছন্দের Coupon নির্বাচন করুন।", menu);
      }
      if (text === "📜 Transactions") {
        const rows = db.prepare(`SELECT type, amount, note, created_at FROM transactions WHERE uid=? ORDER BY id DESC LIMIT 10`).all(uid);
        if (!rows.length) return bot.sendMessage(uid, "কোনো Transaction নেই।", getHome(uid));
        const lines = rows.map(r => `${r.type}: ${fmt(r.amount)}\n${r.note}\n${r.created_at}`);
        return bot.sendMessage(uid, `📜 <b>Transactions</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", ...getHome(uid) });
      }
      if (text === "💬 Support") {
        sessions.set(uid, { step: "support_msg" });
        return bot.sendMessage(uid, `${getSetting('support_text')}\n\nআপনার সমস্যা বিস্তারিত লিখে বা ছবি পাঠিয়ে দিন (বাতিল: /cancel)।`);
      }
      if (text === "📖 Rules") {
        return bot.sendMessage(uid, getSetting('rules_text'), { parse_mode: "HTML", ...getHome(uid) });
      }
    }

    // --- Deposit Steps ---
    if (session?.step === "deposit_amount") {
      const amount = parseMoney(text);
      if (!amount || amount < 1000) return bot.sendMessage(uid, "সঠিক পরিমাণ লিখুন (মিনিমাম ১০৳)।");
      session.amount = amount; session.step = "deposit_trx";
      return bot.sendMessage(uid, `${session.method} পেমেন্টের TRX ID লিখুন।`);
    }
    if (session?.step === "deposit_trx") {
      if (text.length < 5) return bot.sendMessage(uid, "সঠিক TRX ID দিন।");
      try {
        const inserted = db.prepare("INSERT INTO deposits(uid,method,amount,trx) VALUES(?,?,?,?)").run(uid, session.method, session.amount, text);
        const depositId = Number(inserted.lastInsertRowid);
        sendAdmin(`💳 <b>DEPOSIT #${depositId}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\nমাধ্যম: ${session.method}\nপরিমাণ: <b>${fmt(session.amount)}</b>\nTRX: <code>${esc(text)}</code>`, {
          inline_keyboard: [[{ text: "✅ Approve", callback_data: `deposit:approve:${depositId}` }, { text: "❌ Reject", callback_data: `deposit:reject:${depositId}` }, { text: "🗑 Delete", callback_data: `msg:delete` }]]
        });
        bot.sendMessage(uid, `✅ Deposit Request #${depositId} জমা হয়েছে।`, getHome(uid));
      } catch (error) { bot.sendMessage(uid, "এই TRX ID আগে জমা হয়েছে।", getHome(uid)); }
      sessions.delete(uid); return;
    }

    // --- Quest Steps ---
    if (session?.step === "quest_gmail") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return bot.sendMessage(uid, "সঠিক Gmail দিন।");
      session.gmail = text; session.step = "quest_password";
      return bot.sendMessage(uid, "Gmail-এর পাসওয়ার্ড দিন।");
    }
    if (session?.step === "quest_password") {
      session.password = text; session.step = "quest_contact";
      return bot.sendMessage(uid, "যোগাযোগের ফোন নম্বর বা ইমেইল দিন।");
    }
    if (session?.step === "quest_contact") {
      session.contact = text;
      const res = db.prepare(`INSERT INTO quests(uid, screenshot, gmail, password, contact) VALUES(?,?,?,?,?)`).run(uid, session.screenshot, session.gmail, session.password, session.contact);
      const questId = Number(res.lastInsertRowid);
      sessions.delete(uid);
      bot.sendMessage(uid, "✅ Quest Request গ্রহণ করা হয়েছে।", getHome(uid));
      sendAdmin(`🎯 <b>NEW QUEST #${questId}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\n📧 ${esc(session.gmail)}\n🔑 ${esc(session.password)}\n📞 ${esc(session.contact)}`, {
        inline_keyboard: [[{ text: "✅ Approve", callback_data: `quest:approve:${questId}` }, { text: "❌ Reject", callback_data: `quest:reject:${questId}` }, { text: "🗑 Delete", callback_data: `msg:delete` }]]
      });
      return bot.sendPhoto(ADMIN_ID, session.screenshot, { caption: `Quest #${questId} Screenshot` });
    }

    // --- Order Delivery ---
    if (session?.step === "order_gameid") {
      const result = db.transaction(() => {
        const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(session.priceId, uid);
        if (!req || balanceOf(uid) < req.price) return { error: "ERR" };
        db.prepare(`UPDATE prices SET status='CONFIRMED' WHERE id=?`).run(session.priceId);
        const ins = db.prepare("INSERT INTO orders(uid, price_id, coupon, amount, delivery_method, delivery_info) VALUES(?,?,?,?,?,?)").run(uid, session.priceId, req.coupon, req.price, "GAME_ID", text);
        return { id: Number(ins.lastInsertRowid), coupon: req.coupon, price: req.price };
      })();
      sessions.delete(uid);
      if (result.error) return bot.sendMessage(uid, "সমস্যা হয়েছে বা ব্যালেন্স নেই।", getHome(uid));
      bot.sendMessage(uid, `🧾 Order #${result.id} পেন্ডিং এ আছে।`, getHome(uid));
      return sendAdmin(`🛒 <b>NEW ORDER #${result.id}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\nCoupon: $${result.coupon}\nদাম: <b>${fmt(result.price)}</b>\n🎮 Game ID: <code>${esc(text)}</code>`, {
        inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${result.id}` }, { text: "❌ Reject", callback_data: `order:reject:${result.id}` }, { text: "🗑 Delete", callback_data: `msg:delete` }]]
      });
    }
    if (session?.step === "order_gmail_email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return bot.sendMessage(uid, "সঠিক Gmail দিন।");
      session.gmail = text; session.step = "order_gmail_password";
      return bot.sendMessage(uid, "Gmail-এর পাসওয়ার্ড দিন।");
    }
    if (session?.step === "order_gmail_password") {
      const info = `Gmail: ${session.gmail} | Pass: ${text}`;
      const result = db.transaction(() => {
        const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(session.priceId, uid);
        if (!req || balanceOf(uid) < req.price) return { error: "ERR" };
        db.prepare(`UPDATE prices SET status='CONFIRMED' WHERE id=?`).run(session.priceId);
        const ins = db.prepare("INSERT INTO orders(uid, price_id, coupon, amount, delivery_method, delivery_info) VALUES(?,?,?,?,?,?)").run(uid, session.priceId, req.coupon, req.price, "GMAIL", info);
        return { id: Number(ins.lastInsertRowid), coupon: req.coupon, price: req.price };
      })();
      sessions.delete(uid);
      if (result.error) return bot.sendMessage(uid, "সমস্যা হয়েছে বা ব্যালেন্স নেই।", getHome(uid));
      bot.sendMessage(uid, `🧾 Order #${result.id} পেন্ডিং এ আছে।`, getHome(uid));
      return sendAdmin(`🛒 <b>NEW ORDER #${result.id}</b>\n👤 ${esc(displayName(msg.from))}\n🆔 <code>${uid}</code>\nCoupon: $${result.coupon}\nদাম: <b>${fmt(result.price)}</b>\n📧 ${esc(info)}`, {
        inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${result.id}` }, { text: "❌ Reject", callback_data: `order:reject:${result.id}` }, { text: "🗑 Delete", callback_data: `msg:delete` }]]
      });
    }

    // --- Admin Steps ---
    if (session?.step === "support_msg") {
      db.prepare("INSERT INTO support_tickets(uid, message) VALUES(?, ?)").run(uid, text);
      sendAdmin(`🆘 <b>Support Ticket</b>\n👤 User: <code>${uid}</code>\n💬 ${esc(text)}`, { inline_keyboard: [[{ text: "💬 Reply", callback_data: `support:reply:${uid}` }]] });
      sessions.delete(uid);
      return bot.sendMessage(uid, "✅ আপনার মেসেজ পাঠানো হয়েছে।", getHome(uid));
    }

    if (session?.step === "admin_reply_support" && isAdmin(uid)) {
      await safeNotify(session.targetUid, `💬 <b>Admin-এর রিপ্লাই:</b>\n\n${esc(text)}`, { parse_mode: "HTML" });
      db.prepare("UPDATE support_tickets SET status='CLOSED', reply=? WHERE uid=? AND status='OPEN'").run(text, session.targetUid);
      sessions.delete(uid);
      return bot.sendMessage(uid, "✅ রিপ্লাই পাঠানো হয়েছে।");
    }

    if (session?.step === "broadcast_msg" && isAdmin(uid)) {
      const users = db.prepare("SELECT id FROM users WHERE is_banned=0").all();
      let count = 0;
      bot.sendMessage(uid, `⏳ ${users.length} জনকে পাঠানো হচ্ছে...`);
      for (const u of users) {
        const ok = await safeNotify(u.id, text, { parse_mode: "HTML" });
        if (ok) count++;
      }
      sessions.delete(uid);
      logAdmin(`Broadcasted message to ${count} users`);
      return bot.sendMessage(uid, `✅ সফলভাবে ${count} জনকে মেসেজ পাঠানো হয়েছে।`);
    }

    if (session?.step === "admin_set_price" && isAdmin(uid)) {
      const price = parseMoney(text);
      if (!price) return bot.sendMessage(uid, "সঠিক দাম লিখুন। (0 দিলে রিকোয়েস্ট সিস্টেম চালু হবে)");
      setSetting(`price_${session.coupon}`, price);
      session.step = "admin_set_stock";
      return bot.sendMessage(uid, `$${session.coupon} Coupon এর দাম সেট হয়েছে: ${fmt(price)}\n\nএখন স্টক কত সেট করতে চান? (সংখ্যা লিখুন, যেমন: 10)`);
    }
    if (session?.step === "admin_set_stock" && isAdmin(uid)) {
      const stock = Number(text);
      if (!Number.isInteger(stock) || stock < 0) return bot.sendMessage(uid, "সঠিক সংখ্যা লিখুন।");
      setSetting(`stock_${session.coupon}`, stock);
      sessions.delete(uid);
      logAdmin(`Updated $${session.coupon} coupon price to ${fmt(getSetting('price_'+session.coupon))} and stock to ${stock}`);
      return bot.sendMessage(uid, `✅ $${session.coupon} Coupon আপডেট হয়েছে।\nস্টক: ${stock}`);
    }

    if (session?.step === "admin_ban_uid" && isAdmin(uid)) {
      const target = Number(text);
      const user = db.prepare("SELECT is_banned FROM users WHERE id=?").get(target);
      if (!user) { sessions.delete(uid); return bot.sendMessage(uid, "❌ ইউজার পাওয়া যায়নি।"); }
      const newBanStatus = user.is_banned ? 0 : 1;
      db.prepare("UPDATE users SET is_banned=? WHERE id=?").run(newBanStatus, target);
      sessions.delete(uid);
      logAdmin(`Toggled ban for user ${target} to ${newBanStatus}`);
      return bot.sendMessage(uid, `✅ ইউজার ${target} এখন ${newBanStatus ? '🚫 Ban' : '✅ Unban'} করা হয়েছে।`);
    }

    if (session?.step === "admin_text_rules" && isAdmin(uid)) {
      setSetting("rules_text", text); sessions.delete(uid);
      return bot.sendMessage(uid, "✅ Rules আপডেট হয়েছে।");
    }
    if (session?.step === "admin_text_support" && isAdmin(uid)) {
      setSetting("support_text", text); sessions.delete(uid);
      return bot.sendMessage(uid, "✅ Support Text আপডেট হয়েছে।");
    }

    if (session?.step === "admin_add_card_code" && isAdmin(uid)) {
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      let count = 0;
      db.transaction(() => {
        for (const line of lines) {
          const [code, note] = line.split("|").map(s => s.trim());
          db.prepare("INSERT INTO master_cards(card_code, note, added_by) VALUES(?,?,?)").run(code, note || "", uid);
          count++;
        }
      })();
      sessions.delete(uid);
      return bot.sendMessage(uid, `✅ ${count}টি কার্ড যোগ করা হয়েছে।`).then(() => adminPanel(uid));
    }

    if (session?.step === "admin_adjust_uid" && isAdmin(uid)) {
      const target = Number(text);
      if (!db.prepare("SELECT id FROM users WHERE id=?").get(target)) { sessions.delete(uid); return bot.sendMessage(uid, "❌ ইউজার পাওয়া যায়নি।"); }
      session.targetUid = target; session.step = "admin_adjust_amount";
      return bot.sendMessage(uid, `বর্তমান ব্যালেন্স: ${fmt(balanceOf(target))}\n\nকত টাকা যোগ/বিয়োগ করবেন? (বিয়োগে মাইনাস দিন)`);
    }
    if (session?.step === "admin_adjust_amount" && isAdmin(uid)) {
      const amount = toPaisa(Number(text));
      if (isNaN(amount)) return bot.sendMessage(uid, "সঠিক সংখ্যা দিন।");
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
      await bot.sendMessage(uid, `✅ ব্যালেন্স আপডেট হয়েছে: ${fmt(res.nw)}`);
      return safeNotify(target, `⚠️ অ্যাডমিন আপনার ব্যালেন্স আপডেট করেছেন। নতুন ব্যালেন্স: ${fmt(res.nw)}`);
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
      if (await checkMembership(uid)) { await answer("✅ ধন্যবাদ!"); return bot.sendMessage(uid, "স্বাগতম! /start দিন।", getHome(uid)); }
      return answer("❌ আপনি জয়েন করেননি।", true);
    }

    const dbUser = db.prepare("SELECT is_banned FROM users WHERE id=?").get(uid);
    if (dbUser?.is_banned && !isAdmin(uid)) return answer("🚫 আপনি ব্যানড।", true);

    ensureUser(query.from);

    // --- User Actions ---
    if (data.startsWith("deposit:method:")) {
      const method = data.split(":")[2];
      sessions.set(uid, { step: "deposit_amount", method });
      const num = method === "bKash" ? BKASH_NUMBER : NAGAD_NUMBER;
      await answer(); return deleteMsg();
      return bot.sendMessage(uid, `${method} দিয়ে কত টাকা জমা করেছেন?\n${num ? `নম্বর: ${num}` : ''}`, { parse_mode: "HTML" });
    }

    if (data.startsWith("coupon:")) {
      const coupon = Number(data.split(":")[1]);
      const stock = Number(getSetting(`stock_${coupon}`));
      const price = Number(getSetting(`price_${coupon}`));
      
      if (stock <= 0) return answer("❌ এই কুপনটি স্টক আউট!", true);
      
      const existing = db.prepare(`SELECT id FROM prices WHERE uid=? AND coupon=? AND status IN ('WAITING','SENT','CONFIRMED')`).get(uid, coupon);
      if (existing) return answer("আপনার আগের রিকোয়েস্ট পেন্ডিং এ আছে।", true);

      if (price > 0) { // Fixed price flow
        const res = db.prepare("INSERT INTO prices(uid,coupon,price,status) VALUES(?,?,?,'SENT')").run(uid, coupon, price);
        db.prepare(`UPDATE settings SET value = CAST(value AS INTEGER) - 1 WHERE key=?`).run(`stock_${coupon}`); // Deduct stock
        await answer();
        return bot.sendMessage(uid, `💵 <b>Fixed Price</b>\nCoupon: $${coupon}\nদাম: <b>${fmt(price)}</b>\n\nকিনতে Confirm চাপুন।`, {
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: `price:confirm:${res.lastInsertRowid}` }, { text: "❌ Cancel", callback_data: `msg:delete` }]] }
        });
      } else { // Request flow
        const res = db.prepare("INSERT INTO prices(uid,coupon) VALUES(?,?)").run(uid, coupon);
        await answer("Request sent");
        sendAdmin(`💬 <b>PRICE REQUEST</b>\nUser: <code>${uid}</code>\nCoupon: $${coupon}`, {
          inline_keyboard: [[{ text: "Reply Price", callback_data: `price:reply:${res.lastInsertRowid}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]]
        });
        return bot.sendMessage(uid, "✅ দাম জানতে রিকোয়েস্ট পাঠানো হয়েছে।");
      }
    }

    if (data.startsWith("price:confirm:")) {
      const reqId = Number(data.split(":")[2]);
      const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(reqId, uid);
      if (!req) return answer("Request expired", true);
      if (balanceOf(uid) < req.price) return answer("ব্যালেন্স নেই।", true);

      await answer(); deleteMsg();
      sessions.set(uid, { step: "order_delivery_method", priceId: req.id });
      return bot.sendMessage(uid, "ডেলিভারি মাধ্যম বেছে নিন:", { reply_markup: { inline_keyboard: [[{ text: "🎮 Game ID", callback_data: `delivery:gameid:${req.id}` }], [{ text: "📧 Gmail", callback_data: `delivery:gmail:${req.id}` }], [{ text: "Cancel", callback_data: `msg:delete` }]] } });
    }

    if (data.startsWith("delivery:")) {
      const [, type, id] = data.split(":");
      const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(Number(id), uid);
      if (!req) return answer("Expired", true);
      sessions.set(uid, { step: type === "gameid" ? "order_gameid" : "order_gmail_email", priceId: req.id });
      await answer(); deleteMsg();
      return bot.sendMessage(uid, type === "gameid" ? "🎮 আপনার Game ID দিন:" : "📧 আপনার Gmail দিন:");
    }

    // --- Admin Actions ---
    if (!isAdmin(uid)) return answer("শুধু Admin", true);

    if (data === "admin:stats") {
      const users = db.prepare("SELECT COUNT(*) c FROM users").get().c;
      const dep = db.prepare("SELECT COUNT(*) c, SUM(amount) s FROM deposits WHERE status='APPROVED'").get();
      const ord = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='COMPLETED'").get().c;
      const qst = db.prepare("SELECT COUNT(*) c FROM quests WHERE status='COMPLETED'").get().c;
      await answer();
      return bot.sendMessage(uid, `📊 <b>Bot Statistics</b>\n\n👥 Total Users: ${users}\n💳 Deposits: ${dep.c} (${fmt(dep.s || 0)})\n🛒 Orders: ${ord}\n🎯 Quests: ${qst}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "panel:back" }]] } });
    }

    if (data === "admin:broadcast") {
      sessions.set(uid, { step: "broadcast_msg" }); await answer();
      return bot.sendMessage(uid, "📣 সব ইউজারকে যে মেসেজটি পাঠাতে চান সেটি লিখুন (বাতিল: /cancel):");
    }

    if (data === "list:users") {
      const users = db.prepare("SELECT id, name, username, balance FROM users ORDER BY id DESC LIMIT 20").all();
      let txt = `👥 <b>Recent Users (Last 20)</b>\n\n`;
      users.forEach(u => { txt += `<code>${u.id}</code> - ${esc(u.name)} (@${esc(u.username || 'n/a')}) - ${fmt(u.balance)}\n`; });
      await answer(); return bot.sendMessage(uid, txt, { parse_mode: "HTML" });
    }

    if (data === "admin:ban") {
      sessions.set(uid, { step: "admin_ban_uid" }); await answer();
      return bot.sendMessage(uid, "যে ইউজারকে Ban/Unban করবেন তার Telegram ID দিন:");
    }
    
    if (data === "admin:texts") {
      await answer();
      return bot.sendMessage(uid, "কোন টেক্সট এডিট করবেন?", { reply_markup: { inline_keyboard: [[{ text: "📖 Rules", callback_data: "admin:text:rules" }], [{ text: "💬 Support", callback_data: "admin:text:support" }]] } });
    }
    if (data === "admin:text:rules") { sessions.set(uid, { step: "admin_text_rules" }); await answer(); return bot.sendMessage(uid, "নতুন Rules লিখুন:"); }
    if (data === "admin:text:support") { sessions.set(uid, { step: "admin_text_support" }); await answer(); return bot.sendMessage(uid, "নতুন Support Text লিখুন:"); }

    if (data === "admin:prices") {
      await answer();
      const btns = [4,5,10,20,25].map(c => {
        const p = Number(getSetting(`price_${c}`)); const s = Number(getSetting(`stock_${c}`));
        return [{ text: `$${c} (Price: ${p ? fmt(p) : 'Req'} | Stock: ${s})`, callback_data: `admin:setprice:${c}` }];
      });
      return bot.sendMessage(uid, "⚙️ <b>Fixed Prices & Stock</b>\nযেকোনো কুপনে ক্লিক করে দাম ও স্টক আপডেট করুন।", { parse_mode: "HTML", reply_markup: { inline_keyboard: btns } });
    }
    if (data.startsWith("admin:setprice:")) {
      const c = Number(data.split(":")[2]);
      sessions.set(uid, { step: "admin_set_price", coupon: c }); await answer();
      return bot.sendMessage(uid, `$${c} কুপনের নতুন দাম কত BDT? (0 দিলে ইউজার রিকোয়েস্ট পাঠাবে):`);
    }

    if (data === "admin:cards") {
      await answer();
      return bot.sendMessage(uid, "🎁 <b>Card Management</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "➕ Add Cards", callback_data: "list:add_cards" }], [{ text: "📦 View Available", callback_data: "list:view_cards" }], [{ text: "🗑 Delete All Available", callback_data: "admin:delallcards" }]] } });
    }

    if (data === "admin:delallcards") {
      const c = db.prepare("DELETE FROM master_cards WHERE status='AVAILABLE'").run().changes;
      await answer(`Deleted ${c} cards`); return deleteMsg();
    }

    if (data === "list:add_cards") {
      sessions.set(uid, { step: "admin_add_card_code" }); await answer();
      return bot.sendMessage(uid, "🎁 কার্ড ফরম্যাট: <code>CODE | NOTE</code>\n\nযেমন:\nCARD-111 | USA Only\nCARD-222 | UK Only\n\n(প্রতি লাইনে একটি করে দিন)", { parse_mode: "HTML" });
    }

    if (data === "list:view_cards") {
      const cards = db.prepare("SELECT * FROM master_cards WHERE status='AVAILABLE' LIMIT 20").all();
      if (!cards.length) return answer("কোনো কার্ড নেই", true);
      await answer();
      for (const c of cards) {
        bot.sendMessage(uid, `#${c.id} <code>${esc(c.card_code)}</code>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🗑 Remove", callback_data: `card:remove:${c.id}` }]] } });
      } return;
    }

    if (data.startsWith("card:remove:")) {
      const cid = Number(data.split(":")[2]);
      db.prepare("DELETE FROM master_cards WHERE id=? AND status='AVAILABLE'").run(cid);
      await answer("রিমুভ হয়েছে"); return deleteMsg();
    }

    if (data === "list:logs") {
      const logs = db.prepare("SELECT * FROM admin_logs ORDER BY id DESC LIMIT 20").all();
      let txt = `📜 <b>Admin Logs</b>\n\n`;
      logs.forEach(l => { txt += `⏰ ${l.created_at}\n📝 ${esc(l.action)}\n\n`; });
      await answer(); return bot.sendMessage(uid, txt, { parse_mode: "HTML" });
    }

    if (data === "list:support") {
      const tickets = db.prepare("SELECT * FROM support_tickets WHERE status='OPEN' ORDER BY id DESC LIMIT 10").all();
      if (!tickets.length) return answer("No open tickets", true);
      await answer();
      for (const t of tickets) {
        bot.sendMessage(uid, `🆘 <b>Ticket #${t.id}</b>\nUser: <code>${t.uid}</code>\n💬 ${esc(t.message)}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Reply", callback_data: `support:reply:${t.uid}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]] } });
      } return;
    }

    if (data.startsWith("support:reply:")) {
      const target = Number(data.split(":")[2]);
      sessions.set(uid, { step: "admin_reply_support", targetUid: target }); await answer(); deleteMsg();
      return bot.sendMessage(uid, `ইউজার ${target} কে রিপ্লাই লিখুন:`);
    }

    if (data.startsWith("price:reply:")) {
      const rid = Number(data.split(":")[2]);
      sessions.set(uid, { step: "admin_price", requestId: rid, priceMsgId: msgId, priceChatId: chatId }); await answer();
      return bot.sendMessage(uid, `Price request #${rid}\nBDT দাম লিখুন:`);
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
        safeNotify(o.uid, `✅ আপনার Order #${rid} সম্পন্ন হয়েছে!`);
        return;
      }
      const res = db.transaction(() => {
        const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='PENDING'").get(rid);
        if (!o) return { err: 1 };
        if (action === "approve") {
          db.prepare("UPDATE users SET balance=balance-? WHERE id=? AND balance>=?").run(o.amount, o.uid, o.amount);
          db.prepare("UPDATE orders SET status='PROCESSING', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(uid, rid);
          db.prepare("UPDATE prices SET status='ORDERED' WHERE id=?").run(o.price_id);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(o.uid, "PURCHASE", -o.amount, `ORD-${rid}`, `Coupon purchase`);
        } else {
          db.prepare("UPDATE orders SET status='REJECTED', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(uid, rid);
        }
        return { o };
      })();
      if (res.err) return answer("Already reviewed", true);
      await answer("Done"); logAdmin(`Order #${rid} ${action}`);
      editAndAutoDelete(chatId, msgId, action === "approve" ? `✅ <b>Order #${rid} → PROCESSING</b>` : `❌ <b>Order #${rid} REJECTED</b>`);
      
      if (action === "approve") {
        bot.sendMessage(chatId, `🔄 <b>Order #${rid} [PROCESSING]</b>\nUser: ${res.o.uid}\nকাজ শেষ হলে Complete চাপুন।`, {
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete", callback_data: `order:complete:${rid}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]] }
        });
      }
      safeNotify(res.o.uid, action === "approve" ? `✅ আপনার অর্ডার #${rid} প্রসেসিং এ আছে।` : `❌ আপনার অর্ডার #${rid} বাতিল হয়েছে।`);
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
        safeNotify(q.uid, `✅ আপনার Quest #${rid} সম্পন্ন হয়েছে!`);
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
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete", callback_data: `quest:complete:${rid}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]] }
        });
      }
      safeNotify(res.q.uid, action === "approve" ? `✅ আপনার Quest #${rid} প্রসেসিং এ আছে।` : `❌ আপনার Quest #${rid} বাতিল হয়েছে।`);
      return;
    }

    if (data === "list:deposits") {
      const rows = db.prepare("SELECT * FROM deposits WHERE status='PENDING' LIMIT 10").all();
      await answer();
      if (!rows.length) return bot.sendMessage(uid, "Pending Deposit নেই।");
      rows.forEach(r => bot.sendMessage(uid, `💳 <b>Deposit #${r.id}</b>\nUser: <code>${r.uid}</code>\n${r.method}: ${fmt(r.amount)}\nTRX: ${r.trx}`, {
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `deposit:approve:${r.id}` }, { text: "❌ Reject", callback_data: `deposit:reject:${r.id}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]] }
      }));
      return;
    }

    if (data === "list:orders") {
      const rows = db.prepare("SELECT * FROM orders WHERE status='PENDING' LIMIT 10").all();
      await answer();
      if (!rows.length) return bot.sendMessage(uid, "Pending Order নেই।");
      rows.forEach(r => bot.sendMessage(uid, `🛒 <b>Order #${r.id}</b>\nUser: <code>${r.uid}</code>\nCoupon: $${r.coupon}\n${r.delivery_method}: ${r.delivery_info}`, {
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${r.id}` }, { text: "❌ Reject", callback_data: `order:reject:${r.id}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]] }
      }));
      return;
    }

    if (data === "list:quests") {
      const rows = db.prepare("SELECT * FROM quests WHERE status='PENDING' LIMIT 10").all();
      await answer();
      if (!rows.length) return bot.sendMessage(uid, "Pending Quest নেই।");
      rows.forEach(r => {
        bot.sendMessage(uid, `🎯 <b>Quest #${r.id}</b>\nUser: <code>${r.uid}</code>\nGmail: ${r.gmail}\nPass: ${r.password}`, {
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `quest:approve:${r.id}` }, { text: "❌ Reject", callback_data: `quest:reject:${r.id}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]] }
        });
        bot.sendPhoto(uid, r.screenshot, { caption: `Quest #${r.id} Screenshot` });
      });
      return;
    }
    
    if (data === "list:in_progress_orders" || data === "list:in_progress_quests") {
      const table = data.includes("orders") ? "orders" : "quests";
      const rows = db.prepare(`SELECT * FROM ${table} WHERE status='PROCESSING' LIMIT 10`).all();
      await answer();
      if (!rows.length) return bot.sendMessage(uid, "In-Progress নেই।");
      rows.forEach(r => bot.sendMessage(uid, `🔄 <b>${table.slice(0,-1).toUpperCase()} #${r.id}</b>\nUser: <code>${r.uid}</code>`, {
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete", callback_data: `${table.slice(0,-1)}:complete:${r.id}` }], [{ text: "🗑 Delete", callback_data: `msg:delete` }]] }
      }));
      return;
    }

    if (data === "panel:back") { await answer(); return deleteMsg().then(() => adminPanel(uid)); }

  } catch (error) { console.error("Callback Error:", error); answer("Error", true); }
});

// ===== Error Handling =====
bot.on("polling_error", e => console.error("Polling error:", e?.message || e));
bot.getMe().then(info => {
  console.log(`✅ BOT CONNECTED: @${info.username}`);
  bot.sendMessage(ADMIN_ID, `✅ <b>বট কানেক্টেড!</b>\n\n🆕 নতুন আপডেট:\n• Admin Panel ক্লিন ও ক্লোজ বাটন\n• এপ্রুভ/রিজেক্ট মেসেজ ৫ সেকেন্ডে ডিলিট\n• ফিক্সড প্রাইস ও স্টক\n• সাপোর্ট ইনবক্স\n• ব্রডকাস্ট ও স্ট্যাটস`, { parse_mode: "HTML" });
});