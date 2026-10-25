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

// ===== Database (schema unchanged) =====
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, method TEXT NOT NULL CHECK(method IN ('bKash','Nagad')), amount INTEGER NOT NULL CHECK(amount > 0), trx TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')), reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id));
CREATE UNIQUE INDEX IF NOT EXISTS deposit_trx_unique ON deposits(method, trx);
CREATE TABLE IF NOT EXISTS prices (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, coupon INTEGER NOT NULL CHECK(coupon IN (4,5,10,20,25)), price INTEGER, status TEXT NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','SENT','CONFIRMED','DECLINED','ORDERED')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(uid) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, price_id INTEGER NOT NULL UNIQUE, coupon INTEGER NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')), delivery_method TEXT, delivery_info TEXT, reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, completed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id), FOREIGN KEY(price_id) REFERENCES prices(id));
CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('DEPOSIT','PURCHASE','ADJUSTMENT')), amount INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(uid) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS quests (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, screenshot TEXT NOT NULL, gmail TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')), reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, completed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS master_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, card_code TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','CLAIMED')), claimed_by INTEGER, claimed_at TEXT, added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(claimed_by) REFERENCES users(id));
`);

// ===== Migrations (same as before) =====
(function migrateOrders() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get()?.sql || '';
  if (!sql || (sql.includes('PROCESSING') && sql.includes('delivery_method'))) return;
  console.log("Migrating orders...");
  const cols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
  const hasDelivery = cols.includes('delivery_method');
  db.pragma("foreign_keys = OFF"); db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE orders_new (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, price_id INTEGER NOT NULL UNIQUE, coupon INTEGER NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')), delivery_method TEXT, delivery_info TEXT, reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, completed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id), FOREIGN KEY(price_id) REFERENCES prices(id));`);
    const d = hasDelivery ? 'delivery_method, delivery_info' : 'NULL, NULL';
    db.exec(`INSERT INTO orders_new (id,uid,price_id,coupon,amount,status,delivery_method,delivery_info,reviewed_by,created_at,reviewed_at) SELECT id,uid,price_id,coupon,amount, CASE WHEN status='APPROVED' THEN 'COMPLETED' ELSE status END, ${d},reviewed_by,created_at,reviewed_at FROM orders;`);
    db.exec("DROP TABLE orders;"); db.exec("ALTER TABLE orders_new RENAME TO orders;"); db.exec("COMMIT");
  } catch(e) { db.exec("ROLLBACK"); db.pragma("foreign_keys = ON"); throw e; }
  db.pragma("foreign_keys = ON");
})();

(function migrateQuests() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quests'").get()?.sql || '';
  if (!sql) return;
  const cols = db.prepare("PRAGMA table_info(quests)").all().map(c => c.name);
  if (sql.includes('PROCESSING') && cols.includes('gmail') && cols.includes('password')) return;
  console.log("Migrating quests...");
  const oldU = cols.includes('username') ? 'username' : "''";
  const oldL = cols.includes('login_info') ? 'login_info' : "''";
  db.pragma("foreign_keys = OFF"); db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE quests_new (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, screenshot TEXT NOT NULL, gmail TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')), reviewed_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, completed_at TEXT, FOREIGN KEY(uid) REFERENCES users(id));`);
    db.exec(`INSERT INTO quests_new (id,uid,screenshot,gmail,password,contact,status,reviewed_by,created_at,reviewed_at) SELECT id,uid,screenshot,${oldU},${oldL},contact, CASE WHEN status='APPROVED' THEN 'COMPLETED' ELSE status END,reviewed_by,created_at,reviewed_at FROM quests;`);
    db.exec("DROP TABLE quests;"); db.exec("ALTER TABLE quests_new RENAME TO quests;"); db.exec("COMMIT");
  } catch(e) { db.exec("ROLLBACK"); db.pragma("foreign_keys = ON"); throw e; }
  db.pragma("foreign_keys = ON");
})();

// ===== Helpers =====
const sessions = new Map();
const fmt = (paisa = 0) => `৳${(Number(paisa || 0) / 100).toFixed(2)}`;
const toPaisa = v => Math.round(Number(v) * 100);
const isAdmin = id => Number(id) === ADMIN_ID;
const esc = v => String(v ?? "").replace(/[&<>"]/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[ch]));
const displayName = u => `${u.first_name || ""}${u.username ? ` (@${u.username})` : ""}`.trim() || String(u.id);
const balanceOf = uid => db.prepare("SELECT balance FROM users WHERE id=?").get(uid)?.balance ?? 0;

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

// ✅ NEW: Edit message then auto-delete after N seconds
async function editAndAutoDelete(chatId, messageId, newText, delayMs = 10000, editOptions = {}) {
  try {
    await bot.editMessageText(newText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      ...editOptions
    });
  } catch (e) { /* edit may fail; still delete */ }
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch(() => {});
  }, delayMs);
}

// ===== Force Join =====
async function checkMembership(userId) {
  if (isAdmin(userId)) return true;
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) { console.error("Membership check error:", err.message); return false; }
}
function sendJoinPrompt(chatId) {
  return bot.sendMessage(chatId, "⚠️ বট ব্যবহার করতে হলে আপনাকে আমাদের চ্যানেলে জয়েন করতে হবে।\n\nনিচের বাটনে ক্লিক করে জয়েন করুন, তারপর 'Check Again' এ ক্লিক করুন।", {
    reply_markup: { inline_keyboard: [
      [{ text: "📢 Join Channel", url: "https://t.me/google_play_point_01" }],
      [{ text: "✅ Check Again", callback_data: "check_join" }]
    ]}
  });
}

// ===== Keyboards =====
const getHome = (uid) => {
  const keyboard = [
    ["💰 My Balance", "➕ Add Balance"],
    ["🎮 COD Coupons", "🎁 Free Master Card"],
    ["🎯 Quest Complete", "📜 Transactions"],
    ["💬 Support", "📖 Rules"],
    ["🔄 Restart Bot"]
  ];
  if (isAdmin(uid)) keyboard.push(["🛠 Admin Menu"]);
  return { reply_markup: { keyboard, resize_keyboard: true } };
};

const MENU_BUTTONS = new Set([
  "💰 My Balance","➕ Add Balance","🎮 COD Coupons","🎁 Free Master Card",
  "🎯 Quest Complete","📜 Transactions","💬 Support","📖 Rules","🔄 Restart Bot","🛠 Admin Menu"
]);

const couponMenu = {
  reply_markup: { inline_keyboard: [
    [{ text: "$4 Coupon", callback_data: "coupon:4" }, { text: "$5 Coupon", callback_data: "coupon:5" }],
    [{ text: "$10 Coupon", callback_data: "coupon:10" }, { text: "$20 Coupon", callback_data: "coupon:20" }],
    [{ text: "$25 Coupon", callback_data: "coupon:25" }]
  ]}
};

// ✅ NEW: 2-column admin panel
function adminPanel(chatId) {
  return bot.sendMessage(chatId, "🛠 <b>ADMIN PANEL</b>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📥 Deposits", callback_data: "list:deposits" }, { text: "💬 Price Requests", callback_data: "list:prices" }],
      [{ text: "🛒 Pending Orders", callback_data: "list:orders" }, { text: "🔄 In Progress Orders", callback_data: "list:in_progress_orders" }],
      [{ text: "✅ Completed Orders", callback_data: "list:completed_orders" }, { text: "🎯 Pending Quests", callback_data: "list:quests" }],
      [{ text: "🔄 In Progress Quests", callback_data: "list:in_progress_quests" }, { text: "🎁 Add Cards", callback_data: "list:add_cards" }],
      [{ text: "📦 Available Cards", callback_data: "list:view_cards" }, { text: "📜 Card History", callback_data: "list:card_history" }],
      [{ text: "💰 Check Balance", callback_data: "list:balance" }, { text: "⚙️ Adjust Balance", callback_data: "list:adjust" }]
    ]}
  });
}

// ===== Commands =====
bot.onText(/^\/start(@\w+)?$/, async msg => {
  if (!msg.from?.id) return;
  const uid = msg.from.id;
  if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
  ensureUser(msg.from);
  sessions.delete(uid);
  bot.sendMessage(msg.chat.id,
    `আসসালামু আলাইকুম, ${esc(msg.from.first_name || "বন্ধু")}!\n\n<b>PLAY POINT QUEST HUB</b>\n💰 আপনার ব্যালেন্স: <b>${fmt(balanceOf(uid))}</b>\n\nবট রিস্টার্ট হয়েছে। নিচের মেনু থেকে কাজ বেছে নিন।`,
    { parse_mode: "HTML", ...getHome(uid) });
});

bot.onText(/^\/admin(@\w+)?$/, msg => {
  if (!msg.from?.id) return;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Access denied.");
  return adminPanel(msg.chat.id);
});

bot.onText(/^\/cancel(@\w+)?$/, msg => {
  if (!msg.from?.id) return;
  sessions.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "প্রক্রিয়াটি বাতিল হয়েছে।", getHome(msg.from.id));
});

// ===== Message Handler =====
bot.on("message", async msg => {
  if (!msg.from?.id || msg.from.is_bot) return;
  const uid = msg.from.id;
  const text = msg.text ? msg.text.trim() : "";

  try {
    if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
    ensureUser(msg.from);
    const session = sessions.get(uid);

    if (msg.photo) {
      if (session?.step === "quest_screenshot") {
        session.screenshot = msg.photo[msg.photo.length - 1].file_id;
        session.step = "quest_gmail";
        return bot.sendMessage(uid, "✅ স্ক্রিনশট গ্রহণ করা হয়েছে।\n\nএখন আপনার Gmail অ্যাড্রেস দিন (লগিন করার জন্য)।");
      }
      return;
    }

    if (!msg.text || msg.text.startsWith("/")) return;

    if (MENU_BUTTONS.has(text)) {
      sessions.delete(uid);

      if (text === "🛠 Admin Menu") { if (isAdmin(uid)) return adminPanel(uid); return; }
      if (text === "🔄 Restart Bot") return bot.sendMessage(uid, `🔄 বট রিস্টার্ট হয়েছে।\n\n💰 ব্যালেন্স: ${fmt(balanceOf(uid))}`, getHome(uid));
      if (text === "💰 My Balance") return bot.sendMessage(uid, `💰 আপনার ব্যালেন্স: ${fmt(balanceOf(uid))}`, getHome(uid));
      if (text === "➕ Add Balance") {
        return bot.sendMessage(uid, "পেমেন্টের মাধ্যম বেছে নিন।", {
          reply_markup: { inline_keyboard: [
            [{ text: "bKash", callback_data: "deposit:method:bKash" }],
            [{ text: "Nagad", callback_data: "deposit:method:Nagad" }]
          ]}
        });
      }
      if (text === "🎯 Quest Complete") {
        sessions.set(uid, { step: "quest_screenshot" });
        return bot.sendMessage(uid, "🎯 <b>Quest Complete</b>\n\nকুইস্ট সম্পন্ন করতে ১০৳ ফি দিতে হবে।\n\nঅ্যাডমিনের bKash/Nagad নম্বরে ১০৳ পাঠিয়ে পেমেন্টের স্ক্রিনশট এখানে পাঠান।", { parse_mode: "HTML" });
      }
      if (text === "🎁 Free Master Card") {
        const claimed = db.prepare("SELECT * FROM master_cards WHERE claimed_by=? ORDER BY claimed_at DESC LIMIT 1").get(uid);
        if (claimed) {
          return bot.sendMessage(uid, `🎁 আপনি ইতিমধ্যে একটি Free Master Card নিয়েছেন:\n\n🎫 কার্ড: <code>${esc(claimed.card_code)}</code>${claimed.note ? `\n📝 নোট: ${esc(claimed.note)}` : ''}\n📅 তারিখ: ${claimed.claimed_at}`, { parse_mode: "HTML", ...getHome(uid) });
        }
        const avail = db.prepare("SELECT COUNT(*) AS c FROM master_cards WHERE status='AVAILABLE'").get();
        if (!avail.c) return bot.sendMessage(uid, "😔 এখন কোনো Free Master Card স্টকে নেই। পরে আবার চেষ্টা করুন।", getHome(uid));

        const result = db.transaction(() => {
          const card = db.prepare("SELECT * FROM master_cards WHERE status='AVAILABLE' ORDER BY id LIMIT 1").get();
          if (!card) return { error: "OOS" };
          const ch = db.prepare("UPDATE master_cards SET status='CLAIMED', claimed_by=?, claimed_at=CURRENT_TIMESTAMP WHERE id=? AND status='AVAILABLE'").run(uid, card.id);
          if (!ch.changes) return { error: "RACE" };
          return { card };
        })();
        if (result.error) return bot.sendMessage(uid, "😔 এইমাত্র কেউ কার্ডটি নিয়ে নিয়েছে। পরে আবার চেষ্টা করুন।", getHome(uid));
        return bot.sendMessage(uid,
          `🎉 <b>অভিনন্দন!</b>\n\nআপনি একটি Free Master Card পেয়েছেন:\n\n🎫 কার্ড: <code>${esc(result.card.card_code)}</code>${result.card.note ? `\n📝 নোট: ${esc(result.card.note)}` : ''}\n\nএই কার্ড ব্যবহার করে উপভোগ করুন!`,
          { parse_mode: "HTML", ...getHome(uid) });
      }
      if (text === "🎮 COD Coupons") return bot.sendMessage(uid, "আপনার পছন্দের Coupon নির্বাচন করুন।", couponMenu);
      if (text === "📜 Transactions") {
        const rows = db.prepare(`SELECT type, amount, ref, note, created_at FROM transactions WHERE uid=? ORDER BY id DESC LIMIT 10`).all(uid);
        if (!rows.length) return bot.sendMessage(uid, "এখনও কোনো Transaction নেই।", getHome(uid));
        const lines = rows.map(r => `${r.type}: ${fmt(r.amount)}\n${r.note || r.ref}\n${r.created_at}`);
        return bot.sendMessage(uid, `📜 <b>শেষ ১০টি Transaction</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", ...getHome(uid) });
      }
      if (text === "💬 Support") {
        const support = SUPPORT_USERNAME ? `Support: @${SUPPORT_USERNAME.replace(/^@/, "")}` : "Support-এর জন্য Admin-কে মেসেজ করুন।";
        return bot.sendMessage(uid, support, getHome(uid));
      }
      if (text === "📖 Rules") {
        return bot.sendMessage(uid, "📖 <b>RULES</b>\n\n1. সঠিক Transaction ID জমা দিন।\n2. Admin যাচাই করার পরই ব্যালেন্স যোগ হবে।\n3. PIN, OTP বা পাসওয়ার্ড কারও সাথে শেয়ার করবেন না।\n4. Coupon-এর দাম Admin নিশ্চিত করবেন।\n5. অর্ডার অনুমোদনের আগে ব্যালেন্স কাটা হবে না।", { parse_mode: "HTML", ...getHome(uid) });
      }
    }

    if (session?.step === "deposit_amount") {
      const amount = parseMoney(text);
      if (!amount || amount < 1000) return bot.sendMessage(uid, "সঠিক পরিমাণ লিখুন। মিনিমাম ১০৳, সর্বোচ্চ ৳100000। উদাহরণ: 10");
      session.amount = amount; session.step = "deposit_trx";
      return bot.sendMessage(uid, `${session.method} পেমেন্টের Transaction ID লিখুন।`);
    }
    if (session?.step === "deposit_trx") {
      if (text.length < 5 || text.length > 100) return bot.sendMessage(uid, "সঠিক Transaction ID লিখুন।");
      let inserted;
      try { inserted = db.prepare("INSERT INTO deposits(uid,method,amount,trx) VALUES(?,?,?,?)").run(uid, session.method, session.amount, text); }
      catch (error) {
        if (String(error.message).includes("UNIQUE")) { sessions.delete(uid); return bot.sendMessage(uid, "এই TRX আগে জমা হয়েছে।", getHome(uid)); }
        throw error;
      }
      sessions.delete(uid);
      const depositId = Number(inserted.lastInsertRowid);
      await sendAdmin(
        `💳 <b>DEPOSIT #${depositId}</b>\nইউজার: ${esc(displayName(msg.from))}\nID: <code>${uid}</code>\nমাধ্যম: ${session.method}\nপরিমাণ: <b>${fmt(session.amount)}</b>\nTRX: <code>${esc(text)}</code>`,
        { inline_keyboard: [[{ text: "✅ Approve", callback_data: `deposit:approve:${depositId}` }, { text: "❌ Reject", callback_data: `deposit:reject:${depositId}` }]] }
      );
      return safeNotify(uid, `✅ Deposit Request #${depositId} জমা হয়েছে। Admin যাচাই করলে ব্যালেন্স যোগ হবে।`, getHome(uid));
    }

    if (session?.step === "quest_gmail") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return bot.sendMessage(uid, "সঠিক Gmail দিন।");
      session.gmail = text; session.step = "quest_password";
      return bot.sendMessage(uid, "এখন Gmail-এর পাসওয়ার্ড দিন।");
    }
    if (session?.step === "quest_password") {
      if (text.length < 4) return bot.sendMessage(uid, "সঠিক পাসওয়ার্ড দিন।");
      session.password = text; session.step = "quest_contact";
      return bot.sendMessage(uid, "যোগাযোগের জন্য ফোন বা ইমেইল দিন।");
    }
    if (session?.step === "quest_contact") {
      session.contact = text;
      const result = db.prepare(`INSERT INTO quests(uid, screenshot, gmail, password, contact) VALUES(?,?,?,?,?)`).run(uid, session.screenshot, session.gmail, session.password, session.contact);
      const questId = Number(result.lastInsertRowid);
      sessions.delete(uid);
      await bot.sendMessage(uid, "✅ আপনার Quest Request গ্রহণ করা হয়েছে।", getHome(uid));
      await sendAdmin(
        `🎯 <b>NEW QUEST #${questId}</b>\nইউজার: ${esc(displayName(msg.from))}\nID: <code>${uid}</code>\n📧 Gmail: <code>${esc(session.gmail)}</code>\n🔑 Password: <code>${esc(session.password)}</code>\n📞 যোগাযোগ: ${esc(session.contact)}`,
        { inline_keyboard: [[{ text: "✅ Approve & Start", callback_data: `quest:approve:${questId}` }, { text: "❌ Reject", callback_data: `quest:reject:${questId}` }]] }
      );
      return bot.sendPhoto(ADMIN_ID, session.screenshot, { caption: `Screenshot for Quest #${questId}` });
    }

    if (session?.step === "order_delivery_method") return bot.sendMessage(uid, "উপরে বাটন থেকে ডেলিভারি মাধ্যম বেছে নিন। বাতিল: /cancel");
    if (session?.step === "order_gameid") {
      if (text.length < 3) return bot.sendMessage(uid, "সঠিক গেম আইডি দিন।");
      const result = db.transaction(() => {
        const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(session.priceId, uid);
        if (!req) return { error: "CLOSED" };
        if (balanceOf(uid) < req.price) return { error: "BALANCE" };
        const ch = db.prepare(`UPDATE prices SET status='CONFIRMED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='SENT'`).run(session.priceId);
        if (!ch.changes) return { error: "CLOSED" };
        const ins = db.prepare("INSERT INTO orders(uid, price_id, coupon, amount, delivery_method, delivery_info) VALUES(?,?,?,?,?,?)").run(uid, session.priceId, req.coupon, req.price, "GAME_ID", text);
        return { id: Number(ins.lastInsertRowid), coupon: req.coupon, price: req.price };
      })();
      sessions.delete(uid);
      if (result.error === "CLOSED") return bot.sendMessage(uid, "Request আর active নেই।", getHome(uid));
      if (result.error === "BALANCE") return bot.sendMessage(uid, `ব্যালেন্স যথেষ্ট নয়। বর্তমান: ${fmt(balanceOf(uid))}।`, getHome(uid));
      await safeNotify(uid, `🧾 Order #${result.id} Admin-এর কাছে পাঠানো হয়েছে।`, getHome(uid));
      return sendAdmin(
        `🛒 <b>NEW ORDER #${result.id}</b>\nইউজার: ${esc(displayName(msg.from))}\nID: <code>${uid}</code>\nCoupon: $${result.coupon}\nদাম: <b>${fmt(result.price)}</b>\n📦 ডেলিভারি: 🎮 Game ID\n🎮 <code>${esc(text)}</code>\nব্যালেন্স: ${fmt(balanceOf(uid))}`,
        { inline_keyboard: [[{ text: "✅ Approve & Deduct", callback_data: `order:approve:${result.id}` }, { text: "❌ Reject", callback_data: `order:reject:${result.id}` }]] }
      );
    }
    if (session?.step === "order_gmail_email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return bot.sendMessage(uid, "সঠিক Gmail দিন।");
      session.gmail = text; session.step = "order_gmail_password";
      return bot.sendMessage(uid, "📧 Gmail গ্রহণ করা হয়েছে।\n\nএখন পাসওয়ার্ড দিন।");
    }
    if (session?.step === "order_gmail_password") {
      if (text.length < 4) return bot.sendMessage(uid, "সঠিক পাসওয়ার্ড দিন।");
      const deliveryInfo = `Gmail: ${session.gmail} | Password: ${text}`;
      const result = db.transaction(() => {
        const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(session.priceId, uid);
        if (!req) return { error: "CLOSED" };
        if (balanceOf(uid) < req.price) return { error: "BALANCE" };
        const ch = db.prepare(`UPDATE prices SET status='CONFIRMED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='SENT'`).run(session.priceId);
        if (!ch.changes) return { error: "CLOSED" };
        const ins = db.prepare("INSERT INTO orders(uid, price_id, coupon, amount, delivery_method, delivery_info) VALUES(?,?,?,?,?,?)").run(uid, session.priceId, req.coupon, req.price, "GMAIL", deliveryInfo);
        return { id: Number(ins.lastInsertRowid), coupon: req.coupon, price: req.price };
      })();
      sessions.delete(uid);
      if (result.error === "CLOSED") return bot.sendMessage(uid, "Request আর active নেই।", getHome(uid));
      if (result.error === "BALANCE") return bot.sendMessage(uid, `ব্যালেন্স যথেষ্ট নয়।`, getHome(uid));
      await safeNotify(uid, `🧾 Order #${result.id} Admin-এর কাছে পাঠানো হয়েছে।`, getHome(uid));
      return sendAdmin(
        `🛒 <b>NEW ORDER #${result.id}</b>\nইউজার: ${esc(displayName(msg.from))}\nID: <code>${uid}</code>\nCoupon: $${result.coupon}\nদাম: <b>${fmt(result.price)}</b>\n📦 ডেলিভারি: 📧 Gmail\n📧 <code>${esc(session.gmail)}</code>\n🔑 <code>${esc(text)}</code>`,
        { inline_keyboard: [[{ text: "✅ Approve & Deduct", callback_data: `order:approve:${result.id}` }, { text: "❌ Reject", callback_data: `order:reject:${result.id}` }]] }
      );
    }

    if (session?.step === "admin_price" && isAdmin(uid)) {
      const amount = parseMoney(text);
      if (!amount) return bot.sendMessage(uid, "সঠিক দাম লিখুন। উদাহরণ: 550");
      if (amount < 1000) return bot.sendMessage(uid, "সর্বনিম্ন ৳10।");
      const priceRequest = db.prepare("SELECT * FROM prices WHERE id=? AND status='WAITING'").get(session.requestId);
      if (!priceRequest) { sessions.delete(uid); return bot.sendMessage(uid, "Request pending নেই।"); }
      const changed = db.prepare(`UPDATE prices SET price=?, status='SENT', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='WAITING'`).run(amount, priceRequest.id);
      if (!changed.changes) { sessions.delete(uid); return bot.sendMessage(uid, "পরিবর্তিত হয়েছে।"); }
      
      // ✅ Auto-delete the original "Price Request" message
      if (session.priceMsgId && session.priceChatId) {
        editAndAutoDelete(session.priceChatId, session.priceMsgId, `✅ Price request #${priceRequest.id}: ${fmt(amount)} sent`);
      }
      sessions.delete(uid);

      await safeNotify(priceRequest.uid, `💵 <b>Admin-এর দাম</b>\nCoupon: $${priceRequest.coupon}\nদাম: <b>${fmt(amount)}</b>\n\nConfirm চাপুন।`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Confirm price", callback_data: `price:confirm:${priceRequest.id}` }, { text: "❌ Decline", callback_data: `price:decline:${priceRequest.id}` }]] }
      });
      return;
    }

    if (session?.step === "balance_lookup" && isAdmin(uid)) {
      sessions.delete(uid);
      let targetId = Number(text), targetUser;
      if (Number.isSafeInteger(targetId) && targetId > 0) targetUser = db.prepare("SELECT id FROM users WHERE id=?").get(targetId);
      else { const u = text.replace(/^@/, ''); targetUser = db.prepare("SELECT id FROM users WHERE username=?").get(u); if (targetUser) targetId = targetUser.id; }
      if (!targetUser) return bot.sendMessage(uid, "❌ ইউজার পাওয়া যায়নি।");
      return bot.sendMessage(uid, `User ID: ${targetId}\nBalance: ${fmt(balanceOf(targetId))}`);
    }
    if (session?.step === "admin_adjust_uid" && isAdmin(uid)) {
      let targetId = Number(text), targetUser;
      if (Number.isSafeInteger(targetId) && targetId > 0) targetUser = db.prepare("SELECT id FROM users WHERE id=?").get(targetId);
      else { const u = text.replace(/^@/, ''); targetUser = db.prepare("SELECT id FROM users WHERE username=?").get(u); if (targetUser) targetId = targetUser.id; }
      if (!targetUser) { sessions.delete(uid); return bot.sendMessage(uid, "❌ ইউজার পাওয়া যায়নি।"); }
      session.targetUid = targetId; session.step = "admin_adjust_amount";
      return bot.sendMessage(uid, `বর্তমান ব্যালেন্স: ${fmt(balanceOf(targetId))}\n\nকত যোগ/বিয়োগ? বিয়োগে মাইনাস দিন।`);
    }
    if (session?.step === "admin_adjust_amount" && isAdmin(uid)) {
      if (!/^-?\d{1,6}(\.\d{1,2})?$/.test(text)) return bot.sendMessage(uid, "সঠিক পরিমাণ দিন।");
      const amount = toPaisa(Number(text));
      const target = session.targetUid;
      const result = db.transaction(() => {
        const cur = balanceOf(target);
        const nw = cur + amount;
        if (nw < 0) return { error: "NEGATIVE" };
        db.prepare("UPDATE users SET balance=? WHERE id=?").run(nw, target);
        db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(target, "ADJUSTMENT", amount, `ADJ-${Date.now()}`, `Admin adjustment`);
        return { success: true, nw };
      })();
      if (result.error) { sessions.delete(uid); return bot.sendMessage(uid, "❌ ব্যালেন্স ০ এর নিচে যাবে না।"); }
      sessions.delete(uid);
      await bot.sendMessage(uid, `✅ ইউজার ${target} এর ব্যালেন্স: ${fmt(result.nw)}`);
      return safeNotify(target, `⚠️ অ্যাডমিন আপনার ব্যালেন্সে পরিবর্তন করেছেন।\nনতুন ব্যালেন্স: ${fmt(result.nw)}`);
    }

    if (session?.step === "admin_add_card_code" && isAdmin(uid)) {
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      if (!lines.length) return bot.sendMessage(uid, "কোনো কোড নেই। প্রতি লাইনে একটি করে দিন।");
      const insert = db.prepare("INSERT INTO master_cards(card_code, value, added_by) VALUES(?,0,?)");
      let count = 0;
      db.transaction(() => { for (const line of lines) { insert.run(line, uid); count++; } })();
      sessions.delete(uid);
      await bot.sendMessage(uid, `✅ ${count}টি Free Master Card যোগ করা হয়েছে।`);
      return adminPanel(uid);
    }

  } catch (error) {
    console.error("Message handler error:", error);
    try { await bot.sendMessage(uid, "⚠️ একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।"); } catch {}
  }
});

// ===== Callback Handler =====
bot.on("callback_query", async query => {
  if (!query.from?.id) return;
  const uid = query.from.id;
  const data = query.data || "";
  const answer = (text = "", alert = false) =>
    bot.answerCallbackQuery(query.id, { ...(text ? { text } : {}), show_alert: alert }).catch(() => {});

  try {
    if (data !== "check_join") {
      if (!(await checkMembership(uid))) return sendJoinPrompt(uid);
    }

    if (data === "check_join") {
      if (await checkMembership(uid)) {
        await answer("✅ ধন্যবাদ!");
        return bot.sendMessage(uid, "বটে স্বাগতম! /start দিন বা Restart Bot চাপুন।", getHome(uid));
      }
      return answer("❌ আপনি এখনও জয়েন করেননি।", true);
    }

    ensureUser(query.from);

    if (data.startsWith("deposit:method:")) {
      const method = data.split(":")[2];
      if (!["bKash", "Nagad"].includes(method)) return answer("Invalid", true);
      sessions.set(uid, { step: "deposit_amount", method });
      await answer();
      const paymentNumber = method === "bKash" ? BKASH_NUMBER : NAGAD_NUMBER;
      const numberText = paymentNumber ? `\n\n📱 <b>পেমেন্ট নম্বর:</b> <code>${paymentNumber}</code>\n(Send Money করুন)` : "\n\nAdmin-এর কাছ থেকে নম্বর নিশ্চিত করুন।";
      return bot.sendMessage(uid, `${method} দিয়ে কত টাকা জমা করেছেন? উদাহরণ: 10${numberText}`, { parse_mode: "HTML" });
    }

    if (data.startsWith("coupon:")) {
      const coupon = Number(data.split(":")[1]);
      if (![4, 5, 10, 20, 25].includes(coupon)) return answer("Invalid", true);
      const existing = db.prepare(`SELECT p.id, p.status, p.price, o.status AS order_status FROM prices p LEFT JOIN orders o ON o.price_id = p.id WHERE p.uid=? AND p.coupon=? AND p.status IN ('WAITING','SENT','CONFIRMED') ORDER BY p.id DESC LIMIT 1`).get(uid, coupon);
      if (existing) {
        if (existing.status === "WAITING") return answer("এই coupon-এর request আগেই দেওয়া আছে", true);
        if (existing.status === "SENT") {
          await answer();
          return bot.sendMessage(uid, `💵 <b>Admin-এর দাম</b>\nCoupon: $${coupon}\nদাম: <b>${fmt(existing.price)}</b>\n\nConfirm চাপুন।`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "✅ Confirm price", callback_data: `price:confirm:${existing.id}` }, { text: "❌ Decline", callback_data: `price:decline:${existing.id}` }]] }
          });
        }
        if (existing.status === "CONFIRMED" && existing.order_status === "PENDING") return answer("Order pending আছে", true);
      }
      const result = db.prepare("INSERT INTO prices(uid,coupon) VALUES(?,?)").run(uid, coupon);
      const requestId = Number(result.lastInsertRowid);
      await answer("Price request পাঠানো হয়েছে");
      await safeNotify(uid, `✅ $${coupon} Coupon-এর দাম জানতে Admin-কে Request পাঠানো হয়েছে।`);
      return sendAdmin(
        `💬 <b>PRICE REQUEST #${requestId}</b>\nইউজার: ${esc(displayName(query.from))}\nID: <code>${uid}</code>\nCoupon: <b>$${coupon}</b>`,
        { inline_keyboard: [[{ text: "💵 Reply with BDT price", callback_data: `price:reply:${requestId}` }]] }
      );
    }

    if (data.startsWith("price:reply:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin", true);
      const requestId = Number(data.split(":")[2]);
      const request = db.prepare("SELECT * FROM prices WHERE id=? AND status='WAITING'").get(requestId);
      if (!request) return answer("Pending নেই", true);
      sessions.set(uid, {
        step: "admin_price", requestId,
        priceMsgId: query.message.message_id, priceChatId: query.message.chat.id
      });
      await answer();
      return bot.sendMessage(uid, `Request #${requestId}, Coupon $${request.coupon}\nBDT দাম লিখুন। উদাহরণ: 550`);
    }

    if (data.startsWith("price:admin_cancel:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin", true);
      const requestId = Number(data.split(":")[2]);
      const request = db.prepare("SELECT * FROM prices WHERE id=? AND status IN ('WAITING','SENT')").get(requestId);
      if (!request) return answer("Active নেই", true);
      const ch = db.prepare(`UPDATE prices SET status='DECLINED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('WAITING','SENT')`).run(requestId);
      await answer(ch.changes ? "বাতিল হয়েছে" : "Active নেই");
      if (ch.changes) {
        editAndAutoDelete(query.message.chat.id, query.message.message_id, `❌ Price request #${requestId} cancelled`);
        await safeNotify(request.uid, `Admin আপনার $${request.coupon} Coupon request বাতিল করেছেন।`, getHome(request.uid));
      }
      return;
    }

    if (data.startsWith("price:confirm:")) {
      const requestId = Number(data.split(":")[2]);
      const check = db.transaction(() => {
        const request = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(requestId, uid);
        if (!request) return { error: "CLOSED" };
        if (balanceOf(uid) < request.price) return { error: "BALANCE", price: request.price };
        return { request };
      })();
      if (check.error === "CLOSED") return answer("Request active নেই", true);
      if (check.error === "BALANCE") { await answer("ব্যালেন্স যথেষ্ট নয়", true); return; }
      const req = check.request;
      sessions.set(uid, { step: "order_delivery_method", priceId: req.id, coupon: req.coupon, amount: req.price });
      await answer();
      return bot.sendMessage(uid, `🧾 <b>Order Setup</b>\n\nCoupon: $${req.coupon}\nদাম: ${fmt(req.price)}\n\nকীভাবে কুপনটি নিতে চান?`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "🎮 Game ID দিয়ে", callback_data: `delivery:gameid:${req.id}` }],
          [{ text: "📧 Gmail দিয়ে", callback_data: `delivery:gmail:${req.id}` }],
          [{ text: "❌ Cancel", callback_data: `price:decline:${req.id}` }]
        ]}
      });
    }

    if (data.startsWith("price:decline:")) {
      const requestId = Number(data.split(":")[2]);
      const ch = db.prepare(`UPDATE prices SET status='DECLINED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND uid=? AND status='SENT'`).run(requestId, uid);
      sessions.delete(uid);
      await answer(ch.changes ? "প্রত্যাখ্যান করা হয়েছে" : "Active নেই");
      if (ch.changes) return bot.sendMessage(uid, "দাম গ্রহণ করেননি।", getHome(uid));
      return;
    }

    if (data.startsWith("delivery:gameid:") || data.startsWith("delivery:gmail:")) {
      const parts = data.split(":");
      const kind = parts[1];
      const priceId = Number(parts[2]);
      const s = sessions.get(uid);
      if (!s || s.step !== "order_delivery_method" || s.priceId !== priceId) return answer("Session expired", true);
      const req = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(priceId, uid);
      if (!req) { sessions.delete(uid); return answer("Active নেই", true); }
      if (kind === "gameid") {
        sessions.set(uid, { step: "order_gameid", priceId, coupon: req.coupon, amount: req.price });
        await answer();
        return bot.sendMessage(uid, "🎮 আপনার গেমের ইউজার আইডি দিন।");
      } else {
        sessions.set(uid, { step: "order_gmail_email", priceId, coupon: req.coupon, amount: req.price });
        await answer();
        return bot.sendMessage(uid, "📧 আপনার Gmail দিন।");
      }
    }

    // ✅ Deposit approve/reject — edit + auto-delete
    if (data.startsWith("deposit:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin", true);
      const [, action, rawId] = data.split(":");
      if (!["approve", "reject"].includes(action)) return answer("Invalid", true);
      const depositId = Number(rawId);
      const result = db.transaction(() => {
        const deposit = db.prepare("SELECT * FROM deposits WHERE id=? AND status='PENDING'").get(depositId);
        if (!deposit) return { error: "CLOSED" };
        const ch = db.prepare(`UPDATE deposits SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING'`).run(action === "approve" ? "APPROVED" : "REJECTED", uid, depositId);
        if (!ch.changes) return { error: "CLOSED" };
        if (action === "approve") {
          db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(deposit.amount, deposit.uid);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(deposit.uid, "DEPOSIT", deposit.amount, `DEPOSIT-${depositId}`, `${deposit.method} approved`);
        }
        return { deposit };
      })();
      if (result.error) return answer("আগেই review হয়েছে", true);
      await answer("সংরক্ষিত");
      
      // ✅ Auto-edit + delete after 10s
      await editAndAutoDelete(query.message.chat.id, query.message.message_id,
        action === "approve"
          ? `✅ <b>Deposit #${depositId} APPROVED</b>\nUser: <code>${result.deposit.uid}</code>\nAmount: ${fmt(result.deposit.amount)}`
          : `❌ <b>Deposit #${depositId} REJECTED</b>\nUser: <code>${result.deposit.uid}</code>`
      );
      
      await safeNotify(result.deposit.uid, action === "approve"
        ? `✅ Deposit #${depositId} অনুমোদিত। যোগ: ${fmt(result.deposit.amount)}। নতুন ব্যালেন্স: ${fmt(balanceOf(result.deposit.uid))}`
        : `❌ Deposit #${depositId} বাতিল হয়েছে।`);
      return;
    }

    // ✅ Order actions
    if (data.startsWith("order:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin", true);
      const [, action, rawId] = data.split(":");
      if (!["approve", "reject", "complete"].includes(action)) return answer("Invalid", true);
      const orderId = Number(rawId);

      if (action === "complete") {
        const result = db.transaction(() => {
          const order = db.prepare("SELECT * FROM orders WHERE id=? AND status='PROCESSING'").get(orderId);
          if (!order) return { error: "CLOSED" };
          const ch = db.prepare(`UPDATE orders SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=? AND status='PROCESSING'`).run(orderId);
          if (!ch.changes) return { error: "CLOSED" };
          return { order };
        })();
        if (result.error) return answer("Processing-এ নেই", true);
        await answer("সম্পন্ন হয়েছে");
        await editAndAutoDelete(query.message.chat.id, query.message.message_id,
          `✅ <b>Order #${orderId} COMPLETED</b>`
        );
        await safeNotify(result.order.uid, `✅ আপনার Order #${orderId} সম্পন্ন হয়েছে!\nCoupon: $${result.order.coupon}`, getHome(result.order.uid));
        return;
      }

      const result = db.transaction(() => {
        if (action === "reject") {
          const order = db.prepare("SELECT * FROM orders WHERE id=? AND status IN ('PENDING','PROCESSING')").get(orderId);
          if (!order) return { error: "CLOSED" };
          const wasProcessing = order.status === "PROCESSING";
          if (wasProcessing) {
            db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(order.amount, order.uid);
            db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(order.uid, "ADJUSTMENT", order.amount, `REFUND-${orderId}`, `Order #${orderId} rejected - refund`);
            db.prepare(`UPDATE prices SET status='DECLINED', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(order.price_id);
          }
          db.prepare(`UPDATE orders SET status='REJECTED', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(uid, orderId);
          return { order, refunded: wasProcessing };
        }
        const order = db.prepare("SELECT * FROM orders WHERE id=? AND status='PENDING'").get(orderId);
        if (!order) return { error: "CLOSED" };
        const ch = db.prepare(`UPDATE users SET balance=balance-? WHERE id=? AND balance>=?`).run(order.amount, order.uid, order.amount);
        if (!ch.changes) return { error: "BALANCE" };
        db.prepare(`UPDATE orders SET status='PROCESSING', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(uid, orderId);
        db.prepare(`UPDATE prices SET status='ORDERED', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(order.price_id);
        db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(order.uid, "PURCHASE", -order.amount, `ORDER-${orderId}`, `COD Coupon $${order.coupon}`);
        return { order };
      })();

      if (result.error === "BALANCE") return answer("ইউজারের ব্যালেন্স কম", true);
      if (result.error) return answer("আগেই review হয়েছে", true);
      await answer("সংরক্ষিত");
      const order = result.order;
      const dText = order.delivery_method === "GAME_ID" ? `🎮 Game ID: <code>${esc(order.delivery_info)}</code>`
                    : order.delivery_method === "GMAIL" ? `📧 ${esc(order.delivery_info)}`
                    : `(তথ্য নেই)`;

      // ✅ Auto-delete original message
      await editAndAutoDelete(query.message.chat.id, query.message.message_id,
        action === "approve"
          ? `✅ <b>Order #${orderId} → PROCESSING</b>`
          : `❌ <b>Order #${orderId} REJECTED</b>`
      );

      // For approve, send a fresh "Complete" button message (no auto-delete — admin decides)
      if (action === "approve") {
        await bot.sendMessage(query.message.chat.id,
          `🔄 <b>Order #${orderId} [PROCESSING]</b>\n👤 User: <code>${order.uid}</code>\n🎮 Coupon: $${order.coupon}\n📦 ${dText}\n\nকাজ শেষ হলে Complete চাপুন।`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete Order", callback_data: `order:complete:${orderId}` }]] } }
        );
      }

      await safeNotify(order.uid, action === "approve"
        ? `✅ Order #${orderId} অনুমোদিত। ${fmt(order.amount)} কাটা হয়েছে।\nনতুন ব্যালেন্স: ${fmt(balanceOf(order.uid))}\n⏳ Admin কাজ শেষ করে কনফার্ম করবেন।`
        : `❌ Order #${orderId} বাতিল হয়েছে।${result.refunded ? ` ${fmt(order.amount)} ফেরত দেওয়া হয়েছে।` : ""}`);
      return;
    }

    // ✅ Quest actions
    if (data.startsWith("quest:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin", true);
      const [, action, rawId] = data.split(":");
      if (!["approve", "reject", "complete"].includes(action)) return answer("Invalid", true);
      const questId = Number(rawId);

      if (action === "complete") {
        const result = db.transaction(() => {
          const quest = db.prepare("SELECT * FROM quests WHERE id=? AND status='PROCESSING'").get(questId);
          if (!quest) return { error: "CLOSED" };
          const ch = db.prepare(`UPDATE quests SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=? AND status='PROCESSING'`).run(questId);
          if (!ch.changes) return { error: "CLOSED" };
          return { quest };
        })();
        if (result.error) return answer("Processing-এ নেই", true);
        await answer("সম্পন্ন হয়েছে");
        await editAndAutoDelete(query.message.chat.id, query.message.message_id,
          `✅ <b>Quest #${questId} COMPLETED</b>`
        );
        await safeNotify(result.quest.uid, `✅ আপনার Quest #${questId} সম্পন্ন হয়েছে!`);
        return;
      }

      const result = db.transaction(() => {
        const quest = db.prepare("SELECT * FROM quests WHERE id=? AND status IN ('PENDING','PROCESSING')").get(questId);
        if (!quest) return { error: "CLOSED" };
        const newStatus = action === "approve" ? "PROCESSING" : "REJECTED";
        const ch = db.prepare(`UPDATE quests SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('PENDING','PROCESSING')`).run(newStatus, uid, questId);
        if (!ch.changes) return { error: "CLOSED" };
        return { quest };
      })();
      if (result.error) return answer("আগেই review হয়েছে", true);
      await answer("সংরক্ষিত");
      const quest = result.quest;

      // ✅ Auto-delete original message
      await editAndAutoDelete(query.message.chat.id, query.message.message_id,
        action === "approve"
          ? `✅ <b>Quest #${questId} → PROCESSING</b>`
          : `❌ <b>Quest #${questId} REJECTED</b>`
      );

      // For approve, fresh Complete button
      if (action === "approve") {
        await bot.sendMessage(query.message.chat.id,
          `🔄 <b>Quest #${questId} [PROCESSING]</b>\n👤 User: <code>${quest.uid}</code>\n📧 ${esc(quest.gmail)}\n🔑 ${esc(quest.password)}\n📞 ${esc(quest.contact)}\n\nকাজ শেষ হলে Complete চাপুন।`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Complete Quest", callback_data: `quest:complete:${questId}` }]] } }
        );
      }

      await safeNotify(quest.uid, action === "approve"
        ? `✅ আপনার Quest #${questId} অনুমোদিত।\n⏳ Admin কাজ শেষ করে কনফার্ম করবেন।`
        : `❌ আপনার Quest #${questId} বাতিল হয়েছে।`);
      return;
    }

    // ✅ NEW: Remove card
    if (data.startsWith("card:remove:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin", true);
      const cardId = Number(data.split(":")[2]);
      const card = db.prepare("SELECT * FROM master_cards WHERE id=? AND status='AVAILABLE'").get(cardId);
      if (!card) return answer("কার্ড পাওয়া যায়নি বা already claimed", true);
      const ch = db.prepare("DELETE FROM master_cards WHERE id=? AND status='AVAILABLE'").run(cardId);
      await answer(ch.changes ? "কার্ড রিমুভ হয়েছে" : "রিমুভ করা যায়নি");
      if (ch.changes) {
        await editAndAutoDelete(query.message.chat.id, query.message.message_id,
          `🗑 <b>Card Removed</b>\n#${cardId} <code>${esc(card.card_code)}</code>`
        );
      }
      return;
    }

    // ===== Admin Lists =====
    if (data.startsWith("list:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin", true);
      const type = data.split(":")[1];
      await answer();

      if (type === "balance") { sessions.set(uid, { step: "balance_lookup" }); return bot.sendMessage(uid, "ইউজারের Telegram ID অথবা @username দিন।"); }
      if (type === "adjust") { sessions.set(uid, { step: "admin_adjust_uid" }); return bot.sendMessage(uid, "ইউজারের Telegram ID অথবা @username দিন।"); }

      if (type === "add_cards") {
        sessions.set(uid, { step: "admin_add_card_code" });
        return bot.sendMessage(uid, "🎁 <b>Add Free Master Card</b>\n\nপ্রতি লাইনে একটি কার্ড কোড পাঠান।\n\nউদাহরণ:\nCARD-1111-AAAA\nCARD-2222-BBBB\n\nবাতিল: /cancel", { parse_mode: "HTML" });
      }

      // ✅ UPDATED: View Cards — only available, with remove buttons per card
      if (type === "view_cards") {
        const available = db.prepare("SELECT * FROM master_cards WHERE status='AVAILABLE' ORDER BY id LIMIT 20").all();
        const total = db.prepare("SELECT COUNT(*) AS c FROM master_cards WHERE status='AVAILABLE'").get().c;
        if (!available.length) return bot.sendMessage(uid, "📦 কোনো Available Card নেই।\n\nনতুন কার্ড যোগ করতে '🎁 Add Cards' ব্যবহার করুন।");
        await bot.sendMessage(uid, `📦 <b>Available Cards</b>\nমোট: <b>${total}</b>\n\nপ্রতিটি কার্ডের নিচের 🗑 Remove বাটন দিয়ে রিমুভ করতে পারবেন।`, { parse_mode: "HTML" });
        for (const c of available) {
          await bot.sendMessage(uid, `#${c.id} <code>${esc(c.card_code)}</code>`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🗑 Remove", callback_data: `card:remove:${c.id}` }]] }
          });
        }
        return;
      }

      // ✅ NEW: Card History (claimed)
      if (type === "card_history") {
        const claimed = db.prepare(`SELECT m.*, u.name AS user_name, u.username AS user_username FROM master_cards m LEFT JOIN users u ON m.claimed_by = u.id WHERE m.status='CLAIMED' ORDER BY m.id DESC LIMIT 20`).all();
        if (!claimed.length) return bot.sendMessage(uid, "📜 এখনো কোনো কার্ড কেউ নেয়নি।");
        let txt = `📜 <b>Card History (শেষ ${claimed.length}টি)</b>`;
        for (const c of claimed) {
          txt += `\n\n#${c.id} <code>${esc(c.card_code)}</code>\n→ ${esc(c.user_name)} (@${esc(c.user_username || 'n/a')})\n⏰ ${c.claimed_at}`;
        }
        return bot.sendMessage(uid, txt, { parse_mode: "HTML" });
      }

      if (type === "deposits") {
        const rows = db.prepare(`SELECT d.*, u.name AS user_name, u.username AS user_username FROM deposits d JOIN users u ON d.uid = u.id WHERE d.status='PENDING' ORDER BY d.id LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending deposit নেই।");
        for (const r of rows) {
          await bot.sendMessage(uid, `💳 <b>Deposit #${r.id}</b>\n👤 ${esc(r.user_name)}\n🆔 <code>${r.uid}</code>\nমাধ্যম: ${r.method}\nপরিমাণ: ${fmt(r.amount)}\nTRX: ${esc(r.trx)}`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `deposit:approve:${r.id}` }, { text: "Reject", callback_data: `deposit:reject:${r.id}` }]] }
          });
        }
        return;
      }

      if (type === "quests") {
        const rows = db.prepare(`SELECT q.*, u.name AS user_name, u.username AS user_username FROM quests q JOIN users u ON q.uid = u.id WHERE q.status='PENDING' ORDER BY q.id LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending quest নেই।");
        for (const r of rows) {
          await bot.sendMessage(uid, `🎯 <b>Quest #${r.id}</b>\n👤 ${esc(r.user_name)}\n🆔 <code>${r.uid}</code>\n📧 ${esc(r.gmail)}\n🔑 ${esc(r.password)}\n📞 ${esc(r.contact)}`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "✅ Approve & Start", callback_data: `quest:approve:${r.id}` }, { text: "❌ Reject", callback_data: `quest:reject:${r.id}` }]] }
          });
          await bot.sendPhoto(uid, r.screenshot, { caption: `Screenshot for Quest #${r.id}` });
        }
        return;
      }

      if (type === "in_progress_quests") {
        const rows = db.prepare(`SELECT q.*, u.name AS user_name, u.username AS user_username FROM quests q JOIN users u ON q.uid = u.id WHERE q.status='PROCESSING' ORDER BY q.id LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "In-progress quest নেই।");
        for (const r of rows) {
          await bot.sendMessage(uid, `🔄 <b>Quest #${r.id} [PROCESSING]</b>\n👤 ${esc(r.user_name)}\n🆔 <code>${r.uid}</code>\n📧 ${esc(r.gmail)}\n🔑 ${esc(r.password)}\n📞 ${esc(r.contact)}`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "✅ Complete Quest", callback_data: `quest:complete:${r.id}` }]] }
          });
          await bot.sendPhoto(uid, r.screenshot, { caption: `Screenshot for Quest #${r.id}` });
        }
        return;
      }

      if (type === "prices") {
        const rows = db.prepare(`SELECT p.*, u.name AS user_name, u.username AS user_username FROM prices p JOIN users u ON p.uid = u.id WHERE p.status IN ('WAITING','SENT') ORDER BY p.id LIMIT 20`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending price request নেই।");
        for (const r of rows) {
          const buttons = r.status === "WAITING"
            ? [[{ text: "💵 Reply", callback_data: `price:reply:${r.id}` }], [{ text: "Cancel", callback_data: `price:admin_cancel:${r.id}` }]]
            : [[{ text: "Cancel", callback_data: `price:admin_cancel:${r.id}` }]];
          await bot.sendMessage(uid, `Price request #${r.id} [${r.status}]\n👤 ${esc(r.user_name)}\n🆔 <code>${r.uid}</code>\nCoupon: $${r.coupon}` + (r.price ? `\nPrice: ${fmt(r.price)}` : ""), {
            parse_mode: "HTML", reply_markup: { inline_keyboard: buttons }
          });
        }
        return;
      }

      if (type === "orders") {
        const rows = db.prepare(`SELECT o.*, u.name AS user_name, u.username AS user_username FROM orders o JOIN users u ON o.uid = u.id WHERE o.status='PENDING' ORDER BY o.id ASC LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending order নেই।");
        for (const r of rows) {
          const dText = r.delivery_method === "GAME_ID" ? `🎮 <code>${esc(r.delivery_info)}</code>` : `📧 ${esc(r.delivery_info || '')}`;
          await bot.sendMessage(uid, `🛒 <b>Order #${r.id} [PENDING]</b>\n👤 ${esc(r.user_name)}\n🆔 <code>${r.uid}</code>\nCoupon: $${r.coupon}\nদাম: ${fmt(r.amount)}\n📦 ${dText}\nব্যালেন্স: ${fmt(balanceOf(r.uid))}`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `order:approve:${r.id}` }, { text: "❌ Reject", callback_data: `order:reject:${r.id}` }]] }
          });
        }
        return;
      }

      if (type === "in_progress_orders") {
        const rows = db.prepare(`SELECT o.*, u.name AS user_name, u.username AS user_username FROM orders o JOIN users u ON o.uid = u.id WHERE o.status='PROCESSING' ORDER BY o.id LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "In-progress order নেই।");
        for (const r of rows) {
          const dText = r.delivery_method === "GAME_ID" ? `🎮 <code>${esc(r.delivery_info)}</code>` : `📧 ${esc(r.delivery_info || '')}`;
          await bot.sendMessage(uid, `🔄 <b>Order #${r.id} [PROCESSING]</b>\n👤 ${esc(r.user_name)}\n🆔 <code>${r.uid}</code>\nCoupon: $${r.coupon}\nদাম: ${fmt(r.amount)}\n📦 ${dText}`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "✅ Complete Order", callback_data: `order:complete:${r.id}` }]] }
          });
        }
        return;
      }

      if (type === "completed_orders") {
        const rows = db.prepare(`SELECT o.*, u.name AS user_name, u.username AS user_username FROM orders o JOIN users u ON o.uid = u.id WHERE o.status IN ('COMPLETED','REJECTED') ORDER BY o.id DESC LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "Completed order নেই।");
        for (const r of rows) {
          const dText = r.delivery_method === "GAME_ID" ? `🎮 <code>${esc(r.delivery_info)}</code>` : `📧 ${esc(r.delivery_info || '')}`;
          await bot.sendMessage(uid, `🛒 <b>Order #${r.id} [${r.status}]</b>\n👤 ${esc(r.user_name)}\n🆔 <code>${r.uid}</code>\nCoupon: $${r.coupon}\nদাম: ${fmt(r.amount)}\n📦 ${dText}`, { parse_mode: "HTML" });
        }
        return;
      }
    }
  } catch (error) {
    console.error("Callback handler error:", error);
    try { await answer("সমস্যা হয়েছে", true); } catch {}
  }
});

// ===== Error Handling =====
bot.on("polling_error", e => console.error("Polling error:", e?.message || e));
function shutdown() { try { db.close(); } catch (e) {} process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

bot.getMe().then((info) => {
  console.log("==========================================");
  console.log(`✅ BOT CONNECTED: @${info.username}`);
  console.log("==========================================");
  bot.sendMessage(ADMIN_ID,
    `✅ <b>বট কানেক্টেড!</b>\n\n🆕 <b>নতুন ফিচার:</b>\n• Approve/Reject এর পর মেসেজ ১০ সেকেন্ডে অটো ডিলিট\n• Admin Panel ২-কলামে সাজানো\n• কার্ড রিমুভ বাটন + claimed হলে auto-remove`,
    { parse_mode: "HTML" }
  ).catch(e => console.error("Admin notify failed:", e.message));
}).catch(e => console.error("❌ BOT FAILED:", e.message));