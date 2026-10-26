// PLAY POINT QUEST HUB
// Node.js 20+
// npm install node-telegram-bot-api better-sqlite3 dotenv

require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  REQUIRED_CHANNEL = "",
  ADMIN_WHATSAPP = "",
  DB_FILE = "./quest_hub.sqlite"
} = process.env;

const ADMIN_ID = Number(ADMIN_CHAT_ID);

if (!BOT_TOKEN || !Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  console.error("Set BOT_TOKEN and ADMIN_CHAT_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new Database(DB_FILE);
const sessions = new Map();

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  username TEXT DEFAULT '',
  banned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  coupon INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT DEFAULT 'PENDING',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  gmail TEXT NOT NULL,
  contact TEXT NOT NULL,
  screenshot TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'OPEN',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const coupons = [4, 5, 10, 20, 25];

const defaults = [
  ["rules", "📖 নিয়মাবলী\n\n১. সঠিক তথ্য দিন।\n২. Admin যাচাই করার পর কাজ সম্পন্ন হবে।\n৩. Password বা OTP কাউকে দেবেন না।"],
  ["support_text", "💬 আপনার সমস্যা লিখে পাঠান।"],
  ...coupons.flatMap(c => [
    [`price_${c}`, "0"],
    [`stock_${c}`, "0"],
    [`enabled_${c}`, "1"]
  ])
];

const insertSetting = db.prepare(
  "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)"
);

for (const [key, value] of defaults) {
  insertSetting.run(key, value);
}

const isAdmin = id => Number(id) === ADMIN_ID;

const getSetting = key =>
  db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? "0";

const setSetting = (key, value) =>
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));

const logAdmin = action =>
  db.prepare("INSERT INTO admin_logs(action) VALUES(?)").run(action);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function send(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, String(text), options);
  } catch (error) {
    console.error("Send error:", error.message);
    return null;
  }
}

function ensureUser(user) {
  db.prepare(`
    INSERT INTO users(id,name,username)
    VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      username=excluded.username
  `).run(
    user.id,
    user.first_name || "",
    user.username || ""
  );
}

async function checkMembership(id) {
  if (isAdmin(id) || !REQUIRED_CHANNEL) return true;

  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, id);

    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

function joinKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{
          text: "📢 JOIN CHANNEL",
          url: `https://t.me/${REQUIRED_CHANNEL.replace(/^@/, "")}`
        }],
        [{
          text: "✅ CHECK JOIN",
          callback_data: "check_join"
        }]
      ]
    }
  };
}

function homeKeyboard(id) {
  const keyboard = [
    [
      { text: "🎮 COUPON SERVICE" },
      { text: "🎯 QUEST" }
    ],
    [
      { text: "💬 SUPPORT" },
      { text: "📖 RULES" }
    ],
    [
      { text: "📞 WHATSAPP" }
    ]
  ];

  if (isAdmin(id)) {
    keyboard.push([{ text: "🛠 ADMIN PANEL" }]);
  }

  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true
    }
  };
}

function adminKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 STATS", callback_data: "stats" },
          { text: "📢 BROADCAST", callback_data: "broadcast" }
        ],
        [
          { text: "🎮 COUPONS", callback_data: "coupons" },
          { text: "🛒 ORDERS", callback_data: "orders" }
        ],
        [
          { text: "🎯 QUESTS", callback_data: "quests" },
          { text: "💬 SUPPORT", callback_data: "support" }
        ],
        [
          { text: "👥 USERS", callback_data: "users" },
          { text: "🚫 BAN USER", callback_data: "ban" }
        ],
        [
          { text: "📖 EDIT RULES", callback_data: "edit_rules" },
          { text: "✏️ EDIT SUPPORT", callback_data: "edit_support" }
        ],
        [
          { text: "📜 ADMIN LOGS", callback_data: "logs" }
        ]
      ]
    }
  };
}

async function start(msg) {
  const id = msg.from.id;

  if (!(await checkMembership(id))) {
    return send(id, "⚠️ প্রথমে আমাদের চ্যানেলে Join করুন।", joinKeyboard());
  }

  ensureUser(msg.from);

  const user = db.prepare("SELECT banned FROM users WHERE id=?").get(id);

  if (user?.banned && !isAdmin(id)) {
    return send(id, "🚫 আপনার অ্যাকাউন্ট বন্ধ করা হয়েছে।");
  }

  sessions.delete(id);

  return send(
    id,
    `🌟 ASSALAMU ALAIKUM ${msg.from.first_name || "FRIEND"}!\n\nWELCOME TO PLAY POINT QUEST HUB 😈🔥`,
    homeKeyboard(id)
  );
}

function parseAmount(text) {
  const value = String(text).trim();

  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) return null;

  return Math.round(number * 100);
}

async function broadcast(msg) {
  const users = db.prepare(
    "SELECT id FROM users WHERE banned=0 AND id<>?"
  ).all(ADMIN_ID);

  let sent = 0;
  let failed = 0;

  await send(ADMIN_ID, `📢 BROADCAST STARTED\nTOTAL USERS: ${users.length}`);

  for (const user of users) {
    try {
      await bot.copyMessage(
        user.id,
        msg.chat.id,
        msg.message_id
      );
      sent++;
    } catch (error) {
      failed++;

      const retry = Number(
        error?.response?.body?.parameters?.retry_after || 0
      );

      if (retry > 0) {
        await wait((retry + 1) * 1000);
      }
    }

    await wait(40);
  }

  logAdmin(`Broadcast sent=${sent}, failed=${failed}`);

  await send(
    ADMIN_ID,
    `📢 BROADCAST REPORT\n\nTOTAL: ${users.length}\nSENT: ${sent}\nFAILED: ${failed}`
  );
}

bot.on("message", async msg => {
  if (!msg.from || msg.from.is_bot) return;

  const id = msg.from.id;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";

  try {
    if (text === "/cancel") {
      sessions.delete(id);
      return send(id, "❌ CANCELLED", homeKeyboard(id));
    }

    if (text === "/start" || text === "/menu") {
      return start(msg);
    }

    if (text === "/admin") {
      if (isAdmin(id)) return send(id, "🛠 ADMIN PANEL", adminKeyboard());
      return;
    }

    if (!(await checkMembership(id))) {
      return send(id, "⚠️ Join our channel first.", joinKeyboard());
    }

    ensureUser(msg.from);

    const user = db.prepare("SELECT banned FROM users WHERE id=?").get(id);

    if (user?.banned && !isAdmin(id)) {
      return send(id, "🚫 You are banned.");
    }

    const session = sessions.get(id);

    // ADMIN BROADCAST
    if (isAdmin(id) && session?.step === "broadcast") {
      if (text === "/cancel") {
        sessions.delete(id);
        return send(id, "Broadcast cancelled.");
      }

      sessions.delete(id);
      return broadcast(msg);
    }

    // ADMIN: EDIT RULES
    if (isAdmin(id) && session?.step === "edit_rules") {
      setSetting("rules", text);
      sessions.delete(id);
      logAdmin("Rules updated");
      return send(id, "✅ Rules updated.");
    }

    // ADMIN: EDIT SUPPORT TEXT
    if (isAdmin(id) && session?.step === "edit_support") {
      setSetting("support_text", text);
      sessions.delete(id);
      return send(id, "✅ Support text updated.");
    }

    // ADMIN: BAN OR UNBAN USER
    if (isAdmin(id) && session?.step === "ban") {
      const target = Number(text);

      if (!Number.isSafeInteger(target) || target <= 0 || target === ADMIN_ID) {
        return send(id, "Enter a valid Telegram user ID.");
      }

      const targetUser = db.prepare("SELECT banned FROM users WHERE id=?").get(target);

      if (!targetUser) {
        sessions.delete(id);
        return send(id, "User not found.");
      }

      db.prepare("UPDATE users SET banned=? WHERE id=?")
        .run(targetUser.banned ? 0 : 1, target);

      sessions.delete(id);
      logAdmin(`Ban toggled for ${target}`);

      return send(id, `User ${target} ban status updated.`);
    }

    // ADMIN: SET COUPON PRICE
    if (isAdmin(id) && session?.step === "price") {
      const amount = parseAmount(text);

      if (amount === null) {
        return send(id, "Enter a valid price, e.g. 120 or 120.50");
      }

      setSetting(`price_${session.coupon}`, amount);
      sessions.delete(id);
      return send(id, "✅ Price updated.");
    }

    // ADMIN: SET STOCK
    if (isAdmin(id) && session?.step === "stock") {
      const stock = Number(text);

      if (!Number.isSafeInteger(stock) || stock < 0) {
        return send(id, "Enter a valid stock number.");
      }

      setSetting(`stock_${session.coupon}`, stock);
      sessions.delete(id);
      return send(id, "✅ Stock updated.");
    }

    // USER: SELECT COUPON QUANTITY
    if (session?.step === "quantity") {
      const qty = Number(text);

      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) {
        return send(id, "Enter a quantity between 1 and 100.");
      }

      const c = session.coupon;
      const price = Number(getSetting(`price_${c}`));
      const stock = Number(getSetting(`stock_${c}`));

      if (price <= 0 || stock < qty) {
        sessions.delete(id);
        return send(id, "Price or stock is unavailable.");
      }

      const order = db.prepare(
        "INSERT INTO orders(uid,coupon,qty,amount) VALUES(?,?,?,?)"
      ).run(id, c, qty, price * qty);

      setSetting(`stock_${c}`, stock - qty);
      sessions.delete(id);

      await send(
        id,
        `✅ ORDER #${order.lastInsertRowid}\nCOUPON: $${c}\nQUANTITY: ${qty}\nTOTAL: ৳${((price * qty) / 100).toFixed(2)}`
      );

      return send(
        ADMIN_ID,
        `🛒 NEW ORDER #${order.lastInsertRowid}\nUSER: ${id}\nCOUPON: $${c}\nQTY: ${qty}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ APPROVE", callback_data: `order_ok:${order.lastInsertRowid}` },
              { text: "❌ REJECT", callback_data: `order_no:${order.lastInsertRowid}` }
            ]]
          }
        }
      );
    }

    // QUEST: SCREENSHOT
    if (session?.step === "quest_photo") {
      if (!msg.photo?.length) {
        return send(id, "Please send a screenshot as a photo.");
      }

      session.screenshot = msg.photo[msg.photo.length - 1].file_id;
      session.step = "quest_gmail";

      return send(id, "আপনার Gmail address দিন (যেমন name@gmail.com)। Password বা OTP নয়।");
    }

    // QUEST: GMAIL ADDRESS ONLY
    if (session?.step === "quest_gmail") {
      if (!/^[^\s@]+@gmail\.com$/i.test(text)) {
        return send(id, "সঠিক Gmail address দিন। Password/OTP দেবেন না।");
      }

      session.gmail = text;
      session.step = "quest_contact";

      return send(id, "আপনার যোগাযোগের নম্বর বা contact দিন।");
    }

    // QUEST: CONTACT
    if (session?.step === "quest_contact") {
      if (!text || text.length > 200) {
        return send(id, "সঠিক contact দিন (সর্বোচ্চ ২০০ অক্ষর)।");
      }

      const result = db.prepare(
        "INSERT INTO quests(uid,gmail,contact,screenshot) VALUES(?,?,?,?)"
      ).run(id, session.gmail, text, session.screenshot);

      sessions.delete(id);

      await send(id, `✅ QUEST REQUEST #${result.lastInsertRowid} SUBMITTED`);

      return bot.sendPhoto(ADMIN_ID, session.screenshot, {
        caption: `QUEST #${result.lastInsertRowid}\nUSER: ${id}\nGMAIL: ${session.gmail}\nCONTACT: ${text}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ APPROVE", callback_data: `quest_ok:${result.lastInsertRowid}` },
            { text: "❌ REJECT", callback_data: `quest_no:${result.lastInsertRowid}` }
          ]]
        }
      });
    }

    // SUPPORT MESSAGE
    if (session?.step === "support") {
      const content = text || (
        msg.photo ? "[Photo attachment]" :
        msg.video ? "[Video attachment]" :
        msg.document ? "[Document attachment]" : ""
      );

      if (!content) return send(id, "Send text, photo, video or document.");

      const result = db.prepare(
        "INSERT INTO support(uid,message) VALUES(?,?)"
      ).run(id, content);

      sessions.delete(id);

      await send(id, "✅ SUPPORT REQUEST SENT.");

      await send(
        ADMIN_ID,
        `💬 SUPPORT #${result.lastInsertRowid}\nUSER: ${id}\n${content}`,
        {
          reply_markup: {
            inline_keyboard: [[{
              text: "📨 REPLY",
              callback_data: `reply:${id}`
            }]]
          }
        }
      );

      if (msg.photo || msg.video || msg.document) {
        await bot.copyMessage(ADMIN_ID, msg.chat.id, msg.message_id).catch(() => {});
      }

      return;
    }

    // ADMIN: REPLY TO USER
    if (isAdmin(id) && session?.step === "reply") {
      sessions.delete(id);
      await send(session.target, `💬 ADMIN REPLY:\n\n${text}`);
      return send(id, "✅ Reply sent.");
    }

    // USER MENU
    if (text === "🎮 COUPON SERVICE") {
      return send(id, "Choose a coupon:", {
        reply_markup: {
          inline_keyboard: coupons.map(c => [{
            text: `$${c} | Price ${(Number(getSetting(`price_${c}`)) / 100).toFixed(2)} | Stock ${getSetting(`stock_${c}`)}`,
            callback_data: `buy:${c}`
          }])
        }
      });
    }

    if (text === "🎯 QUEST") {
      sessions.set(id, { step: "quest_photo" });
      return send(id, "Quest শুরু করতে স্ক্রিনশট পাঠান। Password/OTP পাঠাবেন না।");
    }

    if (text === "💬 SUPPORT") {
      sessions.set(id, { step: "support" });
      return send(id, getSetting("support_text"));
    }

    if (text === "📖 RULES") {
      return send(id, getSetting("rules"));
    }

    if (text === "📞 WHATSAPP") {
      const number = ADMIN_WHATSAPP.replace(/\D/g, "");

      if (!number) return send(id, "WhatsApp number is not configured.");

      return send(id, `WhatsApp support: https://wa.me/${number}`);
    }

    if (text === "🛠 ADMIN PANEL" && isAdmin(id)) {
      return send(id, "🛠 ADMIN PANEL", adminKeyboard());
    }

    if (text && !text.startsWith("/")) {
      return send(id, "মেনু থেকে একটি অপশন নির্বাচন করুন।", homeKeyboard(id));
    }
  } catch (error) {
    console.error("Message handler error:", error);
    await send(id, "❌ Server error. Please try again.");
  }
});

bot.on("callback_query", async query => {
  const id = query.from.id;
  const data = query.data || "";

  const answer = text =>
    bot.answerCallbackQuery(query.id, { text: text || "" }).catch(() => {});

  try {
    if (data === "check_join") {
      if (await checkMembership(id)) {
        ensureUser(query.from);
        await answer("Membership verified.");
        return send(id, "Welcome!", homeKeyboard(id));
      }

      return answer("আগে Channel Join করুন।");
    }

    if (!(await checkMembership(id))) return answer("Join the channel first.");

    ensureUser(query.from);

    if (data.startsWith("buy:")) {
      const c = Number(data.split(":")[1]);

      if (!coupons.includes(c) || getSetting(`enabled_${c}`) !== "1") {
        return answer("Coupon unavailable.");
      }

      sessions.set(id, { step: "quantity", coupon: c });

      await answer();
      return send(id, `$${c} coupon কতটি কিনবেন? শুধু সংখ্যা লিখুন।`);
    }

    if (!isAdmin(id)) return answer("Admin only.");

    if (data === "stats") {
      await answer();

      const users = db.prepare("SELECT COUNT(*) n FROM users").get().n;
      const orders = db.prepare("SELECT COUNT(*) n FROM orders").get().n;
      const quests = db.prepare("SELECT COUNT(*) n FROM quests").get().n;

      return send(
        id,
        `📊 STATS\nUSERS: ${users}\nORDERS: ${orders}\nQUESTS: ${quests}`,
        adminKeyboard()
      );
    }

    if (data === "broadcast") {
      sessions.set(id, { step: "broadcast" });
      await answer();

      return send(
        id,
        "📢 এখন যে কোনো মেসেজ পাঠান। বাংলা, English, সংখ্যা, ইমোজি, special characters, ছবি বা ভিডিও চলবে। Cancel: /cancel"
      );
    }

    if (data === "coupons") {
      await answer();

      return send(id, "কোন কুপন সেট করবেন?", {
        reply_markup: {
          inline_keyboard: coupons.map(c => [
            { text: `$${c} PRICE`, callback_data: `setprice:${c}` },
            { text: `$${c} STOCK`, callback_data: `setstock:${c}` }
          ])
        }
      });
    }

    if (data.startsWith("setprice:") || data.startsWith("setstock:")) {
      const [action, raw] = data.split(":");
      const c = Number(raw);

      if (!coupons.includes(c)) return answer("Invalid coupon.");

      sessions.set(id, {
        step: action === "setprice" ? "price" : "stock",
        coupon: c
      });

      await answer();

      return send(
        id,
        action === "setprice"
          ? `$${c} coupon-এর দাম লিখুন।`
          : `$${c} coupon-এর stock লিখুন।`
      );
    }

    if (data.startsWith("order_ok:") || data.startsWith("order_no:")) {
      const [action, raw] = data.split(":");
      const orderId = Number(raw);

      const order = db.prepare(
        "SELECT * FROM orders WHERE id=? AND status='PENDING'"
      ).get(orderId);

      if (!order) return answer("Order already reviewed.");

      if (action === "order_ok") {
        db.prepare("UPDATE orders SET status='COMPLETED' WHERE id=?")
          .run(orderId);

        await send(order.uid, `✅ Order #${orderId} approved.`);
      } else {
        db.prepare("UPDATE orders SET status='REJECTED' WHERE id=?")
          .run(orderId);

        setSetting(
          `stock_${order.coupon}`,
          Number(getSetting(`stock_${order.coupon}`)) + order.qty
        );

        await send(order.uid, `❌ Order #${orderId} rejected.`);
      }

      logAdmin(`Order ${orderId}: ${action}`);
      return answer("Updated.");
    }

    if (data.startsWith("quest_ok:") || data.startsWith("quest_no:")) {
      const [action, raw] = data.split(":");
      const questId = Number(raw);

      const quest = db.prepare(
        "SELECT * FROM quests WHERE id=? AND status='PENDING'"
      ).get(questId);

      if (!quest) return answer("Quest already reviewed.");

      const status = action === "quest_ok" ? "COMPLETED" : "REJECTED";

      db.prepare("UPDATE quests SET status=? WHERE id=?")
        .run(status, questId);

      await send(
        quest.uid,
        status === "COMPLETED"
          ? `✅ Quest #${questId} completed.`
          : `❌ Quest #${questId} rejected.`
      );

      logAdmin(`Quest ${questId}: ${status}`);
      return answer("Updated.");
    }

    if (data === "orders") {
      await answer();

      const rows = db.prepare(
        "SELECT * FROM orders WHERE status='PENDING' ORDER BY id DESC LIMIT 10"
      ).all();

      if (!rows.length) return send(id, "Pending orders নেই।");

      for (const r of rows) {
        await send(
          id,
          `ORDER #${r.id}\nUSER: ${r.uid}\nCOUPON: $${r.coupon}\nQTY: ${r.qty}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ APPROVE", callback_data: `order_ok:${r.id}` },
                { text: "❌ REJECT", callback_data: `order_no:${r.id}` }
              ]]
            }
          }
        );
      }

      return;
    }

    if (data === "quests") {
      await answer();

      const rows = db.prepare(
        "SELECT * FROM quests WHERE status='PENDING' ORDER BY id DESC LIMIT 10"
      ).all();

      if (!rows.length) return send(id, "Pending quests নেই।");

      for (const r of rows) {
        await bot.sendPhoto(id, r.screenshot, {
          caption: `QUEST #${r.id}\nUSER: ${r.uid}\nGMAIL: ${r.gmail}\nCONTACT: ${r.contact}`,
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ APPROVE", callback_data: `quest_ok:${r.id}` },
              { text: "❌ REJECT", callback_data: `quest_no:${r.id}` }
            ]]
          }
        });
      }

      return;
    }

    if (data === "support") {
      await answer();

      const rows = db.prepare(
        "SELECT * FROM support WHERE status='OPEN' ORDER BY id DESC LIMIT 10"
      ).all();

      if (!rows.length) return send(id, "Open support ticket নেই।");

      for (const r of rows) {
        await send(id, `SUPPORT #${r.id}\nUSER: ${r.uid}\n${r.message}`, {
          reply_markup: {
            inline_keyboard: [[{
              text: "📨 REPLY",
              callback_data: `reply:${r.uid}`
            }]]
          }
        });
      }

      return;
    }

    if (data.startsWith("reply:")) {
      const target = Number(data.split(":")[1]);

      sessions.set(id, { step: "reply", target });
      await answer();

      return send(id, `User ${target}-কে reply লিখুন।`);
    }

    if (data === "users") {
      await answer();

      const rows = db.prepare(
        "SELECT id,name,username,banned FROM users ORDER BY id DESC LIMIT 30"
      ).all();

      return send(
        id,
        rows.map(u =>
          `${u.id} | ${u.name} | @${u.username || "none"} | ${u.banned ? "BANNED" : "ACTIVE"}`
        ).join("\n") || "No users."
      );
    }

    if (data === "ban") {
      sessions.set(id, { step: "ban" });
      await answer();

      return send(id, "যে ইউজারকে ban/unban করবেন তার Telegram ID দিন।");
    }

    if (data === "edit_rules" || data === "edit_support") {
      sessions.set(id, {
        step: data === "edit_rules" ? "edit_rules" : "edit_support"
      });

      await answer();

      return send(
        id,
        "নতুন লেখা পাঠান। বাংলা, English, সংখ্যা, ইমোজি ও যেকোনো সাধারণ চিহ্ন ব্যবহার করতে পারবেন।"
      );
    }

    if (data === "logs") {
      await answer();

      const rows = db.prepare(
        "SELECT * FROM admin_logs ORDER BY id DESC LIMIT 20"
      ).all();

      return send(
        id,
        rows.map(r => `${r.created_at} | ${r.action}`).join("\n") || "No logs."
      );
    }

    return answer("Unknown action.");
  } catch (error) {
    console.error("Callback error:", error);
    await answer("Error occurred.");
  }
});

bot.on("polling_error", error => {
  console.error("Polling error:", error.message);
});

bot.getMe()
  .then(info => console.log(`BOT ONLINE: @${info.username}`))
  .catch(error => console.error("Bot connection error:", error.message));

process.on("SIGINT", async () => {
  await bot.stopPolling().catch(() => {});
  db.close();
  process.exit(0);
});