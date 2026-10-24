// PLAY POINT QUEST HUB — UTF-8 Node.js Telegram bot
// Money is stored as integer paisa. Verify every payment manually before approval.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");

const { BOT_TOKEN, ADMIN_CHAT_ID, SUPPORT_USERNAME = "", BKASH_NUMBER = "", NAGAD_NUMBER = "" } = process.env;
const ADMIN_ID = Number(ADMIN_CHAT_ID);
const REQUIRED_CHANNEL = "@google_play_point_01"; // গ্রুপ জয়েন এর জন্য

if (!BOT_TOKEN || !Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  console.error("ERROR: Set BOT_TOKEN and numeric ADMIN_CHAT_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new Database(process.env.DB_FILE || "./quest_hub.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('bKash','Nagad')),
  amount INTEGER NOT NULL CHECK(amount > 0),
  trx TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  FOREIGN KEY(uid) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS deposit_trx_unique ON deposits(method, trx);

CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  coupon INTEGER NOT NULL CHECK(coupon IN (4,5,10,20,25)),
  price INTEGER,
  status TEXT NOT NULL DEFAULT 'WAITING'
    CHECK(status IN ('WAITING','SENT','CONFIRMED','DECLINED','ORDERED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(uid) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  price_id INTEGER NOT NULL UNIQUE,
  coupon INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  FOREIGN KEY(uid) REFERENCES users(id),
  FOREIGN KEY(price_id) REFERENCES prices(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('DEPOSIT','PURCHASE','ADJUSTMENT')),
  amount INTEGER NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(uid) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS quests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  screenshot TEXT NOT NULL,
  username TEXT NOT NULL,
  login_info TEXT NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  FOREIGN KEY(uid) REFERENCES users(id)
);
`);

const sessions = new Map();
const fmt = (paisa = 0) => `৳${(Number(paisa || 0) / 100).toFixed(2)}`;
const toPaisa = value => Math.round(Number(value) * 100);
const isAdmin = id => Number(id) === ADMIN_ID;

const esc = value => String(value ?? "").replace(/[&<>"]/g, ch => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
}[ch]));

const displayName = user =>
  `${user.first_name || ""}${user.username ? ` (@${user.username})` : ""}`.trim() || String(user.id);

const balanceOf = uid =>
  db.prepare("SELECT balance FROM users WHERE id=?").get(uid)?.balance ?? 0;

function ensureUser(user) {
  db.prepare(`
    INSERT INTO users(id,name,username) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username
  `).run(user.id, user.first_name || "", user.username || "");
}

async function safeNotify(chatId, text, options) {
  try {
    await bot.sendMessage(chatId, text, options);
    return true;
  } catch (err) {
    console.error(`Notify ${chatId} failed:`, err.message);
    return false;
  }
}

function sendAdmin(text, reply_markup) {
  return safeNotify(ADMIN_ID, text, {
    parse_mode: "HTML",
    ...(reply_markup ? { reply_markup } : {})
  });
}

// ================= Force Join Function =================
async function checkMembership(userId) {
  if (isAdmin(userId)) return true; // অ্যাডমিনকে জয়েন করতে হবে না
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error("Membership check error:", err.message);
    return false; 
  }
}

function sendJoinPrompt(chatId) {
  return bot.sendMessage(chatId, "⚠️ বট ব্যবহার করতে হলে আপনাকে আমাদের চ্যানেলে জয়েন করতে হবে।\n\nনিচের বাটনে ক্লিক করে জয়েন করুন, তারপর 'Check Again' এ ক্লিক করুন।", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Join Channel", url: "https://t.me/google_play_point_01" }],
        [{ text: "✅ Check Again", callback_data: "check_join" }]
      ]
    }
  });
}
// =======================================================

const home = {
  reply_markup: {
    keyboard: [
      ["💰 My Balance", "➕ Add Balance"],
      ["🎮 COD Coupons", "🎯 Quest Complete"],
      ["📜 Transactions", "💬 Support"],
      ["📖 Rules"]
    ],
    resize_keyboard: true
  }
};

const MENU_BUTTONS = new Set([
  "💰 My Balance", "➕ Add Balance", "🎮 COD Coupons", 
  "🎯 Quest Complete", "📜 Transactions", "💬 Support", "📖 Rules"
]);

const couponMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "$4 Coupon", callback_data: "coupon:4" }, { text: "$5 Coupon", callback_data: "coupon:5" }],
      [{ text: "$10 Coupon", callback_data: "coupon:10" }, { text: "$20 Coupon", callback_data: "coupon:20" }],
      [{ text: "$25 Coupon", callback_data: "coupon:25" }]
    ]
  }
};

function adminPanel(chatId) {
  return bot.sendMessage(chatId, "🛠 ADMIN PANEL", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Pending deposits", callback_data: "list:deposits" }],
        [{ text: "Pending price requests", callback_data: "list:prices" }],
        [{ text: "Pending orders", callback_data: "list:orders" }],
        [{ text: "Pending Quests", callback_data: "list:quests" }],
        [{ text: "Check user balance", callback_data: "list:balance" }],
        [{ text: "⚙️ Adjust User Balance", callback_data: "list:adjust" }]
      ]
    }
  });
}

function parseMoney(text) {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 100000) return null;
  return toPaisa(value);
}

// ===== Commands =====
bot.onText(/^\/start(@\w+)?$/, async msg => {
  if (!msg.from?.id) return;
  const uid = msg.from.id;
  
  // গ্রুপ জয়েন চেক
  const isJoined = await checkMembership(uid);
  if (!isJoined) return sendJoinPrompt(uid);

  ensureUser(msg.from);
  sessions.delete(uid); // বট রিস্টার্ট (সব স্টেট ক্লিয়ার)

  bot.sendMessage(
    msg.chat.id,
    `আসসালামু আলাইকুম, ${esc(msg.from.first_name || "বন্ধু")}!\n\n` +
    `<b>PLAY POINT QUEST HUB</b>\n💰 আপনার ব্যালেন্স: <b>${fmt(balanceOf(uid))}</b>\n\n` +
    `বট রিস্টার্ট হয়েছে। নিচের মেনু থেকে আপনার প্রয়োজনীয় কাজ বেছে নিন।`,
    { parse_mode: "HTML", ...home }
  );
});

bot.onText(/^\/admin(@\w+)?$/, msg => {
  if (!msg.from?.id) return;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Access denied.");
  return adminPanel(msg.chat.id);
});

bot.onText(/^\/cancel(@\w+)?$/, msg => {
  if (!msg.from?.id) return;
  sessions.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "প্রক্রিয়াটি বাতিল হয়েছে।", home);
});

// ===== Message Handler =====
bot.on("message", async msg => {
  if (!msg.from?.id || msg.from.is_bot) return;

  const uid = msg.from.id;
  const text = msg.text ? msg.text.trim() : "";

  try {
    // গ্রুপ জয়েন চেক (মেসেজ পাঠানোর আগে)
    const isJoined = await checkMembership(uid);
    if (!isJoined) return sendJoinPrompt(uid);

    ensureUser(msg.from);
    const session = sessions.get(uid);

    // ১. ছবি বা স্ক্রিনশট হ্যান্ডলার (Quest-এর জন্য)
    if (msg.photo) {
      if (session?.step === "quest_screenshot") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        session.screenshot = fileId;
        session.step = "quest_username";
        return bot.sendMessage(uid, "✅ স্ক্রিনশট গ্রহণ করা হয়েছে।\n\nএখন আপনার গেমের/অ্যাকাউন্টের ইউজারনেম দিন।");
      }
      return; 
    }

    if (!msg.text || msg.text.startsWith("/")) return;

    // ২. মেনু বাটন হ্যান্ডলার
    if (MENU_BUTTONS.has(text)) {
      sessions.delete(uid);
      
      if (text === "💰 My Balance") return bot.sendMessage(uid, `💰 আপনার ব্যালেন্স: ${fmt(balanceOf(uid))}`, home);
      
      if (text === "➕ Add Balance") {
        return bot.sendMessage(uid, "পেমেন্টের মাধ্যম বেছে নিন। টাকা পাঠানোর নম্বর নিচে দেওয়া আছে।", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "bKash", callback_data: "deposit:method:bKash" }],
              [{ text: "Nagad", callback_data: "deposit:method:Nagad" }]
            ]
          }
        });
      }

      if (text === "🎯 Quest Complete") {
        sessions.set(uid, { step: "quest_screenshot" });
        return bot.sendMessage(uid, "🎯 <b>Quest Complete</b>\n\nকুইস্ট সম্পন্ন করতে ১০৳ ফি দিতে হবে।\n\nঅ্যাডমিনের bKash/Nagad নম্বরে ১০৳ পাঠিয়ে পেমেন্টের স্ক্রিনশট এখানে পাঠান।", { parse_mode: "HTML" });
      }
      
      if (text === "🎮 COD Coupons") return bot.sendMessage(uid, "আপনার পছন্দের Coupon নির্বাচন করুন।", couponMenu);
      
      if (text === "📜 Transactions") {
        const rows = db.prepare(`SELECT type, amount, ref, note, created_at FROM transactions WHERE uid=? ORDER BY id DESC LIMIT 10`).all(uid);
        if (!rows.length) return bot.sendMessage(uid, "এখনও কোনো Transaction নেই।", home);
        const lines = rows.map(row => `${row.type}: ${fmt(row.amount)}\n${row.note || row.ref}\n${row.created_at}`);
        return bot.sendMessage(uid, `📜 <b>শেষ ১০টি Transaction</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", ...home });
      }
      
      if (text === "💬 Support") {
        const support = SUPPORT_USERNAME ? `Support: @${SUPPORT_USERNAME.replace(/^@/, "")}` : "Support-এর জন্য Admin-কে মেসেজ করুন।";
        return bot.sendMessage(uid, support, home);
      }
      
      if (text === "📖 Rules") {
        return bot.sendMessage(uid, "📖 <b>GROUP/BOT RULES</b>\n\n1. সঠিক Transaction ID জমা দিন।\n2. পেমেন্ট Admin যাচাই করার পরই ব্যালেন্স যোগ হবে।\n3. PIN, OTP বা পাসওয়ার্ড কাউকে দেবেন না।\n4. Coupon-এর দাম Admin নিশ্চিত করবেন।\n5. অর্ডার অনুমোদনের আগে ব্যালেন্স কাটা হবে না।", { parse_mode: "HTML", ...home });
      }
    }

    // ৩. ডিপোজিট স্টেপ
    if (session?.step === "deposit_amount") {
      const amount = parseMoney(text);
      if (!amount || amount < 1000) return bot.sendMessage(uid, "সঠিক পরিমাণ লিখুন। মিনিমাম ডিপোজিট ১০৳, সর্বোচ্চ ৳100000। উদাহরণ: 10");
      session.amount = amount;
      session.step = "deposit_trx";
      return bot.sendMessage(uid, `${session.method} পেমেন্টের Transaction ID লিখুন। PIN বা OTP দেবেন না।`);
    }

    if (session?.step === "deposit_trx") {
      if (text.length < 5 || text.length > 100) return bot.sendMessage(uid, "সঠিক Transaction ID লিখুন।");
      let inserted;
      try {
        inserted = db.prepare("INSERT INTO deposits(uid,method,amount,trx) VALUES(?,?,?,?)").run(uid, session.method, session.amount, text);
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) {
          sessions.delete(uid);
          return bot.sendMessage(uid, "এই method-এর Transaction ID আগে জমা হয়েছে।", home);
        }
        throw error;
      }
      sessions.delete(uid);
      const depositId = Number(inserted.lastInsertRowid);

      await sendAdmin(
        `💳 <b>DEPOSIT REQUEST #${depositId}</b>\nইউজার: ${esc(displayName(msg.from))}\nইউজার ID: <code>${uid}</code>\nমাধ্যম: ${session.method}\nপরিমাণ: <b>${fmt(session.amount)}</b>\nTransaction ID: <code>${esc(text)}</code>`,
        { inline_keyboard: [[{ text: "✅ Approve", callback_data: `deposit:approve:${depositId}` }, { text: "❌ Reject", callback_data: `deposit:reject:${depositId}` }]] }
      );
      return safeNotify(uid, `✅ Deposit Request #${depositId} জমা হয়েছে।\nমাধ্যম: ${session.method}\nপরিমাণ: ${fmt(session.amount)}\n\nAdmin পেমেন্ট যাচাই করে অনুমোদন দিলে ব্যালেন্স যোগ হবে।`, home);
    }

    // ৪. কুইস্ট স্টেপ (লগিন ও যোগাযোগ)
    if (session?.step === "quest_username") {
      if (text.length < 3) return bot.sendMessage(uid, "সঠিক ইউজারনেম দিন।");
      session.username = text;
      session.step = "quest_login";
      return bot.sendMessage(uid, "আপনার লগিন এপ্রোবাল কোড বা পাসওয়ার্ড দিন।");
    }

    if (session?.step === "quest_login") {
      if (text.length < 3) return bot.sendMessage(uid, "সঠিক পাসওয়ার্ড বা এপ্রোবাল কোড দিন।");
      session.login_info = text;
      session.step = "quest_contact";
      return bot.sendMessage(uid, "যোগাযোগের জন্য আপনার ফোন নম্বর বা ইমেইল দিন।");
    }

    if (session?.step === "quest_contact") {
      session.contact = text;
      const result = db.prepare(`INSERT INTO quests(uid, screenshot, username, login_info, contact) VALUES(?,?,?,?,?)`).run(uid, session.screenshot, session.username, session.login_info, session.contact);
      const questId = Number(result.lastInsertRowid);
      sessions.delete(uid);

      await bot.sendMessage(uid, "✅ আপনার Quest Request গ্রহণ করা হয়েছে। অ্যাডমিন যাচাই করে কাজ শুরু করবেন।", home);
      
      await sendAdmin(
        `🎯 <b>NEW QUEST REQUEST #${questId}</b>\nইউজার: ${esc(displayName(msg.from))}\nইউজার ID: <code>${uid}</code>\nইউজারনেম: ${esc(session.username)}\nলগিন: ${esc(session.login_info)}\nযোগাযোগ: ${esc(session.contact)}`,
        { inline_keyboard: [[{ text: "✅ Approve", callback_data: `quest:approve:${questId}` }, { text: "❌ Reject", callback_data: `quest:reject:${questId}` }]] }
      );
      return bot.sendPhoto(ADMIN_ID, session.screenshot, { caption: `Screenshot for Quest #${questId}` });
    }

    // ৫. অ্যাডমিন প্রাইস স্টেপ
    if (session?.step === "admin_price" && isAdmin(uid)) {
      const amount = parseMoney(text);
      if (!amount) return bot.sendMessage(uid, "সঠিক BDT দাম লিখুন। উদাহরণ: 550");
      if (amount < 1000) return bot.sendMessage(uid, "সর্বনিম্ন দাম ৳10 হতে হবে।");

      const priceRequest = db.prepare("SELECT * FROM prices WHERE id=? AND status='WAITING'").get(session.requestId);
      if (!priceRequest) {
        sessions.delete(uid);
        return bot.sendMessage(uid, "এই price request আর pending নেই।");
      }
      const changed = db.prepare(`UPDATE prices SET price=?, status='SENT', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='WAITING'`).run(amount, priceRequest.id);
      if (!changed.changes) {
        sessions.delete(uid);
        return bot.sendMessage(uid, "Request ইতিমধ্যে পরিবর্তিত হয়েছে।");
      }
      sessions.delete(uid);

      await safeNotify(priceRequest.uid, `💵 <b>Admin-এর দাম</b>\nCoupon: $${priceRequest.coupon}\nদাম: <b>${fmt(amount)}</b>\n\nএই দামে অর্ডার করতে চাইলে Confirm চাপুন।`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ Confirm price", callback_data: `price:confirm:${priceRequest.id}` }, { text: "❌ Decline", callback_data: `price:decline:${priceRequest.id}` }]] }
      });
      return bot.sendMessage(uid, `Request #${priceRequest.id}-এর দাম পাঠানো হয়েছে: ${fmt(amount)}`);
    }

    // ৬. অ্যাডমিন ব্যালেন্স লুকআপ
    if (session?.step === "balance_lookup" && isAdmin(uid)) {
      const target = Number(text);
      sessions.delete(uid);
      if (!Number.isSafeInteger(target) || target <= 0) return bot.sendMessage(uid, "সঠিক numeric Telegram user ID দিন। (ইউজারনেম নয়, শুধু নাম্বার দিন)");
      const targetUser = db.prepare("SELECT id FROM users WHERE id=?").get(target);
      return bot.sendMessage(uid, targetUser ? `User ID: ${target}\nBalance: ${fmt(balanceOf(target))}` : "এই ইউজার এখনও বটে /start করেনি।");
    }

    // ৭. অ্যাডমিন - ব্যালেন্স অ্যাডজাস্ট (ইউজার আইডি)
    if (session?.step === "admin_adjust_uid" && isAdmin(uid)) {
      const target = Number(text);
      if (!Number.isSafeInteger(target) || target <= 0) return bot.sendMessage(uid, "সঠিক numeric Telegram user ID দিন। (ইউজারনেম নয়, শুধু নাম্বার দিন)");
      
      const targetUser = db.prepare("SELECT id FROM users WHERE id=?").get(target);
      if (!targetUser) {
        sessions.delete(uid);
        return bot.sendMessage(uid, "এই ইউজার এখনও বটে /start করেনি।");
      }

      session.targetUid = target;
      session.step = "admin_adjust_amount";
      
      return bot.sendMessage(uid, `ইউজারের বর্তমান ব্যালেন্স: ${fmt(balanceOf(target))}\n\nকত টাকা যোগ বা বিয়োগ করতে চান? (বিয়োগ করতে চাইলে সামনে মাইনাস চিহ্ন দিন)\nউদাহরণ: 500 অথবা -500`);
    }

    // ৮. অ্যাডমিন - ব্যালেন্স অ্যাডজাস্ট (অ্যামাউন্ট)
    if (session?.step === "admin_adjust_amount" && isAdmin(uid)) {
      if (!/^-?\d{1,6}(\.\d{1,2})?$/.test(text)) {
        return bot.sendMessage(uid, "সঠিক পরিমাণ লিখুন। উদাহরণ: 500 অথবা -500");
      }
      const amount = toPaisa(Number(text));
      const target = session.targetUid;

      const result = db.transaction(() => {
        const currentBal = balanceOf(target);
        const newBal = currentBal + amount;
        
        if (newBal < 0) return { error: "NEGATIVE" };

        db.prepare("UPDATE users SET balance=? WHERE id=?").run(newBal, target);
        db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(
          target,
          "ADJUSTMENT",
          amount,
          `ADJ-${Date.now()}`,
          `Admin adjustment`
        );
        return { success: true, newBal };
      })();

      if (result.error === "NEGATIVE") {
        sessions.delete(uid);
        return bot.sendMessage(uid, "❌ এই পরিমাণ বিয়োগ করা যাবে না, কারণ ব্যালেন্স ০ এর নিচে নেমে যাবে।");
      }

      sessions.delete(uid);
      await bot.sendMessage(uid, `✅ ইউজার ${target} এর ব্যালেন্স আপডেট করা হয়েছে।\nনতুন ব্যালেন্স: ${fmt(result.newBal)}`);
      return safeNotify(target, `⚠️ অ্যাডমিন আপনার ব্যালেন্সে পরিবর্তন করেছেন।\nনতুন ব্যালেন্স: ${fmt(result.newBal)}`);
    }

  } catch (error) {
    console.error("Message handler error:", error);
    try { await bot.sendMessage(uid, "⚠️ একটি সমস্যা হয়েছে। আবার চেষ্টা করুন অথবা Admin-কে জানান।"); } catch {}
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
    // Join Check (Check Again বাটন ছাড়া বাকি সব কিছুর জন্য)
    if (data !== "check_join") {
      const isJoined = await checkMembership(uid);
      if (!isJoined) return sendJoinPrompt(uid);
    }

    if (data === "check_join") {
      const isJoined = await checkMembership(uid);
      if (isJoined) {
        await answer("✅ ধন্যবাদ! আপনি সফলভাবে জয়েন করেছেন।");
        return bot.sendMessage(uid, "বটে স্বাগতম! এখন আপনি সব ফিচার ব্যবহার করতে পারবেন। /start দিন।", home);
      } else {
        return answer("❌ আপনি এখনও জয়েন করেননি। দয়া করে জয়েন করুন।", true);
      }
    }

    ensureUser(query.from);

    if (data.startsWith("deposit:method:")) {
      const method = data.split(":")[2];
      if (!["bKash", "Nagad"].includes(method)) return answer("Invalid payment method", true);
      sessions.set(uid, { step: "deposit_amount", method });
      await answer();

      const paymentNumber = method === "bKash" ? BKASH_NUMBER : NAGAD_NUMBER;
      const numberText = paymentNumber ? `\n\n📱 <b>পেমেন্ট নম্বর:</b> <code>${paymentNumber}</code>\n(Send Money করুন)` : "\n\nটাকা পাঠানোর আগে Admin-এর কাছ থেকে অফিসিয়াল পেমেন্ট নম্বর নিশ্চিত করুন।";

      return bot.sendMessage(uid, `${method} দিয়ে কত টাকা জমা দিয়েছেন? শুধু পরিমাণ লিখুন। উদাহরণ: 10${numberText}`, { parse_mode: "HTML" });
    }

    if (data.startsWith("coupon:")) {
      const coupon = Number(data.split(":")[1]);
      if (![4, 5, 10, 20, 25].includes(coupon)) return answer("Invalid coupon", true);

      const existing = db.prepare(`SELECT p.id, p.status, o.status AS order_status FROM prices p LEFT JOIN orders o ON o.price_id = p.id WHERE p.uid=? AND p.coupon=? AND p.status IN ('WAITING','SENT','CONFIRMED') ORDER BY p.id DESC LIMIT 1`).get(uid, coupon);
      if (existing) {
        if (existing.status === "WAITING") return answer("এই coupon-এর জন্য আগেই request দেওয়া আছে", true);
        if (existing.status === "SENT") return answer("Admin দাম পাঠিয়েছেন — Confirm বা Decline করুন", true);
        if (existing.status === "CONFIRMED" && existing.order_status === "PENDING") return answer("এই coupon-এর জন্য order pending আছে", true);
      }

      const result = db.prepare("INSERT INTO prices(uid,coupon) VALUES(?,?)").run(uid, coupon);
      const requestId = Number(result.lastInsertRowid);

      await answer("Price request পাঠানো হয়েছে");
      await safeNotify(uid, `✅ $${coupon} Coupon-এর দাম জানতে Admin-এর কাছে Request পাঠানো হয়েছে।`);
      return sendAdmin(
        `💬 <b>COUPON PRICE REQUEST #${requestId}</b>\nইউজার: ${esc(displayName(query.from))}\nইউজার ID: <code>${uid}</code>\nCoupon: <b>$${coupon}</b>\n\nBDT দাম জানাতে নিচের বোতাম চাপুন।`,
        { inline_keyboard: [[{ text: "💵 Reply with BDT price", callback_data: `price:reply:${requestId}` }]] }
      );
    }

    if (data.startsWith("price:reply:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin ব্যবহার করতে পারবেন", true);
      const requestId = Number(data.split(":")[2]);
      const request = db.prepare("SELECT * FROM prices WHERE id=? AND status='WAITING'").get(requestId);
      if (!request) return answer("Request আর pending নেই", true);
      sessions.set(uid, { step: "admin_price", requestId });
      await answer();
      return bot.sendMessage(uid, `Request #${requestId}, Coupon $${request.coupon}\nBDT দাম লিখুন। উদাহরণ: 550`);
    }

    if (data.startsWith("price:admin_cancel:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin ব্যবহার করতে পারবেন", true);
      const requestId = Number(data.split(":")[2]);
      const request = db.prepare("SELECT * FROM prices WHERE id=? AND status IN ('WAITING','SENT')").get(requestId);
      if (!request) return answer("Request আর active নেই", true);
      const changed = db.prepare(`UPDATE prices SET status='DECLINED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('WAITING','SENT')`).run(requestId);
      await answer(changed.changes ? "Request বাতিল হয়েছে" : "আর active নেই");
      if (changed.changes) {
        await safeNotify(request.uid, `Admin আপনার $${request.coupon} Coupon price request বাতিল করেছেন। চাইলে আবার নতুন করে request দিতে পারেন।`, home);
        return bot.sendMessage(uid, `Price request #${requestId} cancelled.`);
      }
      return;
    }

    if (data.startsWith("price:confirm:")) {
      const requestId = Number(data.split(":")[2]);
      const order = db.transaction(() => {
        const request = db.prepare("SELECT * FROM prices WHERE id=? AND uid=? AND status='SENT'").get(requestId, uid);
        if (!request) return { error: "CLOSED" };
        if (balanceOf(uid) < request.price) return { error: "BALANCE", price: request.price };
        const updated = db.prepare(`UPDATE prices SET status='CONFIRMED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='SENT'`).run(requestId);
        if (!updated.changes) return { error: "CLOSED" };
        const inserted = db.prepare("INSERT INTO orders(uid,price_id,coupon,amount) VALUES(?,?,?,?)").run(uid, requestId, request.coupon, request.price);
        return { id: Number(inserted.lastInsertRowid), coupon: request.coupon, price: request.price };
      })();

      if (order.error === "CLOSED") return answer("Request আর active নেই", true);
      if (order.error === "BALANCE") {
        await answer("ব্যালেন্স যথেষ্ট নয়", true);
        return safeNotify(uid, `আপনার ব্যালেন্স ${fmt(balanceOf(uid))}; প্রয়োজন ${fmt(order.price)}। আগে Add Balance করুন।`);
      }

      await answer("Order Admin-এর কাছে পাঠানো হয়েছে");
      await safeNotify(uid, `🧾 Order #${order.id} Admin-এর কাছে পাঠানো হয়েছে। অনুমোদনের আগে ব্যালেন্স কাটা হবে না।`);
      return sendAdmin(
        `🛒 <b>NEW ORDER #${order.id}</b>\nইউজার ID: <code>${uid}</code>\nCoupon: $${order.coupon}\nদাম: <b>${fmt(order.price)}</b>\nবর্তমান ব্যালেন্স: ${fmt(balanceOf(uid))}`,
        { inline_keyboard: [[{ text: "✅ Approve & deduct", callback_data: `order:approve:${order.id}` }, { text: "❌ Reject", callback_data: `order:reject:${order.id}` }]] }
      );
    }

    if (data.startsWith("price:decline:")) {
      const requestId = Number(data.split(":")[2]);
      const changed = db.prepare(`UPDATE prices SET status='DECLINED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND uid=? AND status='SENT'`).run(requestId, uid);
      await answer(changed.changes ? "দাম প্রত্যাখ্যান করা হয়েছে" : "Request আর active নেই");
      if (changed.changes) return bot.sendMessage(uid, "দাম গ্রহণ করেননি। চাইলে নতুন করে দাম জানতে পারেন।", home);
      return;
    }

    if (data.startsWith("deposit:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin ব্যবহার করতে পারবেন", true);
      const [, action, rawId] = data.split(":");
      if (!["approve", "reject"].includes(action)) return answer("Invalid action", true);
      const depositId = Number(rawId);

      const result = db.transaction(() => {
        const deposit = db.prepare("SELECT * FROM deposits WHERE id=? AND status='PENDING'").get(depositId);
        if (!deposit) return { error: "CLOSED" };
        const changed = db.prepare(`UPDATE deposits SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING'`).run(action === "approve" ? "APPROVED" : "REJECTED", uid, depositId);
        if (!changed.changes) return { error: "CLOSED" };
        if (action === "approve") {
          db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(deposit.amount, deposit.uid);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(deposit.uid, "DEPOSIT", deposit.amount, `DEPOSIT-${depositId}`, `${deposit.method} approved`);
        }
        return { deposit };
      })();

      if (result.error) return answer("এই deposit আগেই review হয়েছে", true);
      await answer("Review সংরক্ষণ হয়েছে");
      const deposit = result.deposit;
      await safeNotify(query.message.chat.id, `Deposit #${depositId}: ${action === "approve" ? "APPROVED" : "REJECTED"}`);
      await safeNotify(deposit.uid, action === "approve" ? `✅ Deposit #${depositId} অনুমোদিত হয়েছে। যোগ হয়েছে ${fmt(deposit.amount)}। নতুন ব্যালেন্স: ${fmt(balanceOf(deposit.uid))}` : `❌ Deposit #${depositId} বাতিল হয়েছে।`);
      return;
    }

    if (data.startsWith("order:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin ব্যবহার করতে পারবেন", true);
      const [, action, rawId] = data.split(":");
      if (!["approve", "reject"].includes(action)) return answer("Invalid action", true);
      const orderId = Number(rawId);

      const result = db.transaction(() => {
        const order = db.prepare("SELECT * FROM orders WHERE id=? AND status='PENDING'").get(orderId);
        if (!order) return { error: "CLOSED" };
        if (action === "approve") {
          const changed = db.prepare(`UPDATE users SET balance=balance-? WHERE id=? AND balance>=?`).run(order.amount, order.uid, order.amount);
          if (!changed.changes) return { error: "BALANCE" };
        }
        const updated = db.prepare(`UPDATE orders SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING'`).run(action === "approve" ? "APPROVED" : "REJECTED", uid, orderId);
        if (!updated.changes) return { error: "CLOSED" };
        if (action === "approve") {
          db.prepare(`UPDATE prices SET status='ORDERED', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(order.price_id);
          db.prepare(`INSERT INTO transactions(uid,type,amount,ref,note) VALUES(?,?,?,?,?)`).run(order.uid, "PURCHASE", -order.amount, `ORDER-${orderId}`, `COD Coupon $${order.coupon}`);
        }
        return { order };
      })();

      if (result.error === "BALANCE") return answer("ইউজারের ব্যালেন্স যথেষ্ট নয়", true);
      if (result.error) return answer("এই order আগেই review হয়েছে", true);
      await answer("Review সংরক্ষণ হয়েছে");
      const order = result.order;
      await safeNotify(query.message.chat.id, `Order #${orderId}: ${action === "approve" ? "APPROVED" : "REJECTED"}`);
      await safeNotify(order.uid, action === "approve" ? `✅ Order #${orderId} অনুমোদিত হয়েছে। ${fmt(order.amount)} কাটা হয়েছে। ব্যালেন্স: ${fmt(balanceOf(order.uid))}` : `❌ Order #${orderId} বাতিল হয়েছে।`);
      return;
    }

    if (data.startsWith("quest:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin ব্যবহার করতে পারবেন", true);
      const [, action, rawId] = data.split(":");
      if (!["approve", "reject"].includes(action)) return answer("Invalid action", true);
      const questId = Number(rawId);

      const result = db.transaction(() => {
        const quest = db.prepare("SELECT * FROM quests WHERE id=? AND status='PENDING'").get(questId);
        if (!quest) return { error: "CLOSED" };

        const updated = db.prepare(`UPDATE quests SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING'`).run(action === "approve" ? "APPROVED" : "REJECTED", uid, questId);
        if (!updated.changes) return { error: "CLOSED" };

        return { quest };
      })();

      if (result.error) return answer("এই quest আগেই review হয়েছে", true);
      await answer("Review সংরক্ষণ হয়েছে");
      const quest = result.quest;
      
      await safeNotify(query.message.chat.id, `Quest #${questId}: ${action === "approve" ? "APPROVED" : "REJECTED"}`);
      await safeNotify(quest.uid, action === "approve" ? `✅ আপনার Quest #${questId} অনুমোদিত হয়েছে। অ্যাডমিন এখন আপনার কাজ শুরু করবেন।` : `❌ আপনার Quest #${questId} বাতিল হয়েছে।`);
      return;
    }

    if (data.startsWith("list:")) {
      if (!isAdmin(uid)) return answer("শুধু Admin ব্যবহার করতে পারবেন", true);
      const type = data.split(":")[1];
      await answer();

      if (type === "balance") {
        sessions.set(uid, { step: "balance_lookup" });
        return bot.sendMessage(uid, "যে ইউজারের ব্যালেন্স দেখতে চান তার numeric Telegram user ID দিন। (ইউজারনেম নয়)");
      }

      if (type === "adjust") {
        sessions.set(uid, { step: "admin_adjust_uid" });
        return bot.sendMessage(uid, "যে ইউজারের ব্যালেন্স পরিবর্তন (যোগ/বিয়োগ) করতে চান তার numeric Telegram user ID দিন। (ইউজারনেম নয়)");
      }

      if (type === "deposits") {
        const rows = db.prepare(`SELECT * FROM deposits WHERE status='PENDING' ORDER BY id LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending deposit নেই।");
        for (const row of rows) {
          await bot.sendMessage(uid, `Deposit #${row.id}\nUser: ${row.uid}\nMethod: ${row.method}\nAmount: ${fmt(row.amount)}\nTRX: ${esc(row.trx)}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `deposit:approve:${row.id}` }, { text: "Reject", callback_data: `deposit:reject:${row.id}` }]] } });
        }
        return;
      }

      if (type === "quests") {
        const rows = db.prepare(`SELECT * FROM quests WHERE status='PENDING' ORDER BY id LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending quest নেই।");
        for (const row of rows) {
          await bot.sendMessage(uid, `Quest #${row.id}\nUser: ${row.uid}\nUsername: ${esc(row.username)}\nLogin: ${esc(row.login_info)}\nContact: ${esc(row.contact)}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `quest:approve:${row.id}` }, { text: "Reject", callback_data: `quest:reject:${row.id}` }]] } });
          await bot.sendPhoto(uid, row.screenshot, { caption: `Screenshot for Quest #${row.id}` });
        }
        return;
      }

      if (type === "prices") {
        const rows = db.prepare(`SELECT * FROM prices WHERE status IN ('WAITING','SENT') ORDER BY id LIMIT 20`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending price request নেই।");
        for (const row of rows) {
          const buttons = row.status === "WAITING" ? [[{ text: "Reply with BDT price", callback_data: `price:reply:${row.id}` }], [{ text: "Cancel request", callback_data: `price:admin_cancel:${row.id}` }]] : [[{ text: "Cancel request", callback_data: `price:admin_cancel:${row.id}` }]];
          await bot.sendMessage(uid, `Price request #${row.id} [${row.status}]\nUser: ${row.uid}\nCoupon: $${row.coupon}` + (row.price ? `\nPrice: ${fmt(row.price)}` : ""), { reply_markup: { inline_keyboard: buttons } });
        }
        return;
      }

      if (type === "orders") {
        const rows = db.prepare(`SELECT * FROM orders WHERE status='PENDING' ORDER BY id LIMIT 10`).all();
        if (!rows.length) return bot.sendMessage(uid, "Pending order নেই।");
        for (const row of rows) {
          await bot.sendMessage(uid, `Order #${row.id}\nUser: ${row.uid}\nCoupon: $${row.coupon}\nPrice: ${fmt(row.amount)}\nBalance: ${fmt(balanceOf(row.uid))}`, { reply_markup: { inline_keyboard: [[{ text: "Approve & charge", callback_data: `order:approve:${row.id}` }, { text: "Reject", callback_data: `order:reject:${row.id}` }]] } });
        }
      }
    }
  } catch (error) {
    console.error("Callback handler error:", error);
    try { await answer("সমস্যা হয়েছে, আবার চেষ্টা করুন", true); } catch {}
  }
});

bot.on("polling_error", error => { console.error("Telegram polling error:", error?.message || error); });

function shutdown() { try { db.close(); } catch (e) {} process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ===== Success Connection Indicator =====
bot.getMe().then((botInfo) => {
  console.log("==========================================");
  console.log("✅ BOT SUCCESSFULLY CONNECTED!");
  console.log(`🤖 Bot Name: ${botInfo.first_name}`);
  console.log(`🔗 Username: @${botInfo.username}`);
  console.log("==========================================");
  console.log("PLAY POINT QUEST HUB is running...");

  bot.sendMessage(ADMIN_ID, 
    `✅ <b>বট সফলভাবে কানেক্ট হয়েছে!</b>\n\n` +
    `🤖 বটের নাম: ${botInfo.first_name}\n` +
    `🔗 ইউজারনেম: @${botInfo.username}\n\n` +
    `আপনার বট এখন সম্পূর্ণ প্রস্তুত।`, 
    { parse_mode: "HTML" }
  ).catch(err => console.error("Admin notification failed:", err.message));

}).catch((error) => {
  console.error("❌ BOT CONNECTION FAILED:", error.message);
});