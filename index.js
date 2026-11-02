
require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

if (!TOKEN) {
    console.error("BOT_TOKEN is missing!");
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
    polling: true
});

const gameLinks = new Map();

function isAdmin(msg) {
    return !ADMIN_ID ||
        String(msg.from.id) === String(ADMIN_ID);
}

function denied(msg) {
    return bot.sendMessage(
        msg.chat.id,
        "Access denied. Admin only."
    );
}

bot.onText(/^\/start$/, async (msg) => {
    if (!isAdmin(msg)) return denied(msg);

    const menu = `
🟡 PIYAS QUEST BOT

Welcome to PIYAS QUEST BOT!

Available Commands:

/start - Start Bot
/help - Help Menu
/status - Bot Status
/addgame - Add Game Link
/games - Show Game Links
/clear - Clear Game Links

Bot is running successfully.
`;

    await bot.sendMessage(msg.chat.id, menu);
});

bot.onText(/^\/help$/, async (msg) => {
    if (!isAdmin(msg)) return denied(msg);

    await bot.sendMessage(
        msg.chat.id,
        "PIYAS QUEST BOT HELP\n\n" +
        "/start\n/status\n/addgame LINK\n/games\n/clear"
    );
});

bot.onText(/^\/status$/, async (msg) => {
    if (!isAdmin(msg)) return denied(msg);

    const links = gameLinks.get(msg.from.id) || [];

    await bot.sendMessage(
        msg.chat.id,
        `🟢 BOT ONLINE\n\n` +
        `Bot Name: PIYAS QUEST BOT\n` +
        `Saved Games: ${links.length}\n` +
        `Mode: Telegram Control`
    );
});

bot.onText(/^\/addgame(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAdmin(msg)) return denied(msg);

    const url = (match[1] || "").trim();

    if (!url) {
        return bot.sendMessage(
            msg.chat.id,
            "Usage:\n/addgame https://play.google.com/store/apps/details?id=example"
        );
    }

    try {
        const parsed = new URL(url);

        if (
            parsed.protocol !== "https:" ||
            parsed.hostname !== "play.google.com"
        ) {
            throw new Error("Invalid URL");
        }
    } catch {
        return bot.sendMessage(
            msg.chat.id,
            "Please provide a valid Google Play Store link."
        );
    }

    const links = gameLinks.get(msg.from.id) || [];

    links.push(url);
    gameLinks.set(msg.from.id, links);

    await bot.sendMessage(
        msg.chat.id,
        "✅ Game link saved successfully!"
    );
});

bot.onText(/^\/games$/, async (msg) => {
    if (!isAdmin(msg)) return denied(msg);

    const links = gameLinks.get(msg.from.id) || [];

    if (!links.length) {
        return bot.sendMessage(
            msg.chat.id,
            "No game links found."
        );
    }

    const output = links
        .map((link, index) => `${index + 1}. ${link}`)
        .join("\n");

    await bot.sendMessage(
        msg.chat.id,
        "🎮 SAVED GAME LINKS\n\n" + output
    );
});

bot.onText(/^\/clear$/, async (msg) => {
    if (!isAdmin(msg)) return denied(msg);

    gameLinks.delete(msg.from.id);

    await bot.sendMessage(
        msg.chat.id,
        "🗑️ Game links cleared."
    );
});

bot.on("polling_error", (error) => {
    console.error("Polling Error:", error.message);
});

bot.on("error", (error) => {
    console.error("Bot Error:", error.message);
});

console.log("PIYAS QUEST BOT STARTED!");
