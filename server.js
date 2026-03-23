require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");
const { testConnection } = require("./config/hbase");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "5mb" })); // allow batch events

// ── Routes ────────────────────────────────────────────────────────
app.use("/api/auth",       require("./routes/auth"));
app.use("/api/activities", require("./routes/activities"));
app.use("/api/stats",      require("./routes/stats"));

// ── Health check ─────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await testConnection();
    res.json({
      status: "ok",
      service: "Activity Tracker API",
      hbase: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      hbase: "disconnected",
      error: err.message,
    });
  }
});

// ── API Docs (quick reference) ────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    name:    "Activity Tracker API",
    version: "1.0.0",
    description: "HBase-backed activity tracking backend — School Project",
    endpoints: {
      auth: {
        "POST /api/auth/register": "Create account",
        "POST /api/auth/login":    "Login → get JWT token",
        "GET  /api/auth/me":       "Get profile (auth required)",
        "POST /api/auth/logout":   "Logout",
      },
      activities: {
        "POST /api/activities":              "Record single activity event",
        "POST /api/activities/batch":        "Sync multiple events at once",
        "GET  /api/activities":              "List recent activities (?limit&type&from&to)",
        "GET  /api/activities/apps":         "App usage (?date or ?from&to)",
        "POST /api/activities/social-join":  "Record social platform join date",
        "POST /api/activities/steps":        "Record step count",
      },
      stats: {
        "GET  /api/stats/dashboard":  "Dashboard summary (?filter=day|month|year)",
        "GET  /api/stats/screen-time":"Screen time chart (?from&to)",
        "GET  /api/stats/top-apps":   "Top apps by usage",
        "GET  /api/stats/steps":      "Step count chart (?from&to)",
        "GET  /api/stats/social":     "Social platform join history",
        "POST /api/stats/aggregate":  "Trigger daily aggregation",
      },
    },
    hbase: {
      tables: ["users", "activities", "app_sessions", "daily_stats"],
      sharding: "Pre-split regions based on row key prefixes",
      replication: "REPLICATION_SCOPE=1 on critical column families",
    },
  });
});

// ── 404 handler ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// ── Error handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ── Start server ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   Activity Tracker API — School Project      ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  🚀 Server running on http://localhost:${PORT}   ║`);
  console.log(`║  📦 HBase: ${process.env.HBASE_HOST || "localhost"}:${process.env.HBASE_PORT || 8080}              ║`);
  console.log("╚══════════════════════════════════════════════╝\n");

  // Try to connect to HBase on startup
  try {
    await testConnection();
    console.log("✅ HBase connection verified\n");
    console.log("💡 First time? Run: npm run setup-hbase\n");
  } catch (err) {
    console.warn("⚠️  HBase not reachable yet (start Docker: docker-compose up -d)\n");
  }
});

module.exports = app;