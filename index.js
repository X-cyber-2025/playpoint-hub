
require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN = String(process.env.ADMIN_CHAT_ID || "");

if (!TOKEN || !ADMIN) {
    console.log("BOT_TOKEN or ADMIN_CHAT_ID missing!");
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
    polling: true
});

let games = [];
let waiting = {};

function isAdmin(msg) {
    return String(msg.from.id) === ADMIN;
}

function menu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📊 Dashboard", callback_data: "status" },
                    { text: "🎮 Games", callback_data: "games" }
                ],
                [
                    { text: "➕ Add Game", callback_data: "add" },
                    { text: "🗑 Clear Games", callback_data: "clear" }
                ]
            ]
        }
    };
}

bot.onText(/^\/start$/, async (msg) => {
    if (!isAdmin(msg)) return;

    await bot.sendMessage(
        msg.chat.id,
        "🟡 PIYAS QUEST BOT\n\nWelcome to Admin Panel!\n\nSelect an option below.",
        menu()
    );
});

bot.onText(/^\/help$/, async (msg) => {
    if (!isAdmin(msg)) return;

    await bot.sendMessage(
        msg.chat.id,
        "/start - Admin Panel\n/status - Bot Status\n/addgame - Add Game\n/games - Game List\n/clear - Clear Games"
    );
});

bot.onText(/^\/status$/, async (msg) => {
    if (!isAdmin(msg)) return;

    await bot.sendMessage(
        msg.chat.id,
        "🟢 BOT ONLINE\n\n" +
        "Bot: PIYAS QUEST BOT\n" +
        "Status: Running\n" +
        "Saved Games: " + games.length,
        menu()
    );
});

bot.onText(/^\/addgame$/, async (msg) => {
    if (!isAdmin(msg)) return;

    waiting[msg.from.id] = true;

    await bot.sendMessage(
        msg.chat.id,
        "🎮 Send your Google Play game link now."
    );
});

bot.onText(/^\/games$/, async (msg) => {
    if (!isAdmin(msg)) return;

    if (games.length === 0) {
        return bot.sendMessage(msg.chat.id, "No games saved.");
    }

    const list = games.map((g, i) => `${i + 1}. ${g}`).join("\n\n");

    await bot.sendMessage(msg.chat.id, list);
});

bot.onText(/^\/clear$/, async (msg) => {
    if (!isAdmin(msg)) return;

    games = [];

    await bot.sendMessage(
        msg.chat.id,
        "🗑 All game links cleared."
    );
});

bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!isAdmin(msg)) return;
    if (!waiting[msg.from.id]) return;

    try {
        const url = new URL(msg.text.trim());

        if (
            url.protocol !== "https:" ||
            url.hostname !== "play.google.com"
        ) {
            throw new Error("Invalid link");
        }

        games.push(url.href);
        delete waiting[msg.from.id];

        await bot.sendMessage(
            msg.chat.id,
            "✅ Game link saved successfully!",
            menu()
        );

    } catch {
        await bot.sendMessage(
            msg.chat.id,
            "❌ Invalid link. Send an official Google Play link."
        );
    }
});

bot.on("polling_error", (err) => {
    console.log("Polling Error:", err.message);
});

console.log("PIYAS QUEST BOT STARTED!");
