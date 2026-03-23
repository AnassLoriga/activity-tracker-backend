const express = require("express");
const { authenticate } = require("../middleware/auth");
const {
  DailyStatsService,
  AppSessionService,
  ActivityService,
} = require("../services/hbaseService");

const router = express.Router();
router.use(authenticate);

// ══════════════════════════════════════════════════════════════════
//  DASHBOARD & STATISTICS ROUTES
//  All filtered by: day | month | year
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/stats/dashboard
 * Main dashboard summary for a given period
 *
 * Query:
 *   filter = 'day' | 'month' | 'year'   (default: 'day')
 *   date   = 'YYYY-MM-DD'               (default: today)
 *   month  = 'YYYY-MM'
 *   year   = 'YYYY'
 */
router.get("/dashboard", async (req, res) => {
  try {
    const { filter = "day", date, month, year } = req.query;
    const today = new Date().toISOString().slice(0, 10);

    let data;

    if (filter === "day") {
      const d = date || today;
      data = await DailyStatsService.getDay(req.userId, d);
      if (!data) {
        // Return empty stats if no data yet
        data = {
          date: d,
          totalScreenTime: 0,
          totalSteps: 0,
          unlocks: 0,
          topApp: null,
          notifications: 0,
          appBreakdown: {},
        };
      }
    } else if (filter === "month") {
      const [y, m] = (month || today.slice(0, 7)).split("-");
      const rows = await DailyStatsService.getMonth(req.userId, y, m);
      data = aggregateRows(rows, "month", `${y}-${m}`);
    } else if (filter === "year") {
      const y = year || today.slice(0, 4);
      const rows = await DailyStatsService.getYear(req.userId, y);
      data = aggregateRows(rows, "year", y);
    } else {
      return res.status(400).json({ success: false, message: "filter must be day|month|year" });
    }

    res.json({ success: true, filter, data });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/stats/screen-time
 * Screen time breakdown for charts
 *
 * Query: from=YYYY-MM-DD&to=YYYY-MM-DD  (max 90 days)
 */
router.get("/screen-time", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from  = req.query.from || today;
    const to    = req.query.to   || today;

    const diffDays = daysBetween(from, to);
    if (diffDays > 90) {
      return res.status(400).json({ success: false, message: "Max range is 90 days" });
    }

    const days = await generateDateRange(from, to);
    const statsPromises = days.map((d) => DailyStatsService.getDay(req.userId, d));
    const results = await Promise.all(statsPromises);

    const chart = days.map((date, i) => ({
      date,
      screenTime: results[i]?.totalScreenTime || 0,
      steps:      results[i]?.totalSteps || 0,
      unlocks:    results[i]?.unlocks || 0,
    }));

    res.json({ success: true, data: chart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/stats/top-apps
 * Top used apps for a period
 *
 * Query: date | from+to | month | year
 */
router.get("/top-apps", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { date, from, to } = req.query;

    let appStats;
    if (from && to) {
      const range = await AppSessionService.getRangeStats(req.userId, from, to);
      // Merge all days into total per-app
      appStats = mergeDailyAppStats(range);
    } else {
      const d = date || today;
      appStats = await AppSessionService.getDayStats(req.userId, d);
    }

    // Sort by total duration and return top 10
    const sorted = appStats
      .sort((a, b) => b.totalDuration - a.totalDuration)
      .slice(0, 10)
      .map((app) => ({
        ...app,
        totalDurationMin: Math.round(app.totalDuration / 60000), // ms → min
        percentage: 0, // calculated below
      }));

    const totalMs = sorted.reduce((s, a) => s + a.totalDuration, 0);
    sorted.forEach((app) => {
      app.percentage = totalMs > 0
        ? Math.round((app.totalDuration / totalMs) * 100)
        : 0;
    });

    res.json({ success: true, data: sorted });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/stats/steps
 * Step count data for charts
 */
router.get("/steps", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from  = req.query.from || today;
    const to    = req.query.to   || today;

    const days    = await generateDateRange(from, to);
    const results = await Promise.all(
      days.map((d) => DailyStatsService.getDay(req.userId, d))
    );

    const data = days.map((date, i) => ({
      date,
      steps: results[i]?.totalSteps || 0,
    }));

    const total   = data.reduce((s, d) => s + d.steps, 0);
    const average = data.length > 0 ? Math.round(total / data.length) : 0;

    res.json({ success: true, data, summary: { total, average } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/stats/social
 * Social platform join events for the user
 */
router.get("/social", async (req, res) => {
  try {
    const events = await ActivityService.getByType(req.userId, "social_join", 100);
    res.json({ success: true, data: events });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/stats/aggregate
 * Trigger aggregation for a specific date (or today)
 * Called by phone after syncing events for a day
 */
router.post("/aggregate", async (req, res) => {
  try {
    const { date } = req.body;
    const d = date || new Date().toISOString().slice(0, 10);

    // Fetch raw data and compute aggregation
    const appStats    = await AppSessionService.getDayStats(req.userId, d);
    const stepEvents  = await ActivityService.getByType(req.userId, "step_count", 100);
    const screenOnEvents = await ActivityService.getByType(req.userId, "screen_on", 1000);

    const totalSteps = stepEvents.reduce((s, e) => {
      const eventDate = new Date(e.timestamp).toISOString().slice(0, 10);
      return eventDate === d ? s + (e.metadata?.steps || 0) : s;
    }, 0);

    const totalScreenTime = appStats.reduce((s, a) => s + a.totalDuration, 0);
    const topApp          = appStats[0]?.appName || null;
    const unlocks         = screenOnEvents.filter(
      (e) => new Date(e.timestamp).toISOString().slice(0, 10) === d
    ).length;

    const appBreakdown = appStats.reduce((acc, a) => {
      acc[a.appName] = a.totalDuration;
      return acc;
    }, {});

    await DailyStatsService.upsert(req.userId, d, {
      totalScreenTime,
      totalSteps,
      unlocks,
      topApp,
      notifications: 0, // would need notification events
      appBreakdown,
    });

    res.json({
      success: true,
      message: `Aggregated stats for ${d}`,
      data: { date: d, totalScreenTime, totalSteps, unlocks, topApp },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Helpers ──────────────────────────────────────────────────────

function generateDateRange(from, to) {
  const dates = [];
  const cur   = new Date(from);
  const end   = new Date(to);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function daysBetween(from, to) {
  return Math.abs((new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24));
}

function aggregateRows(rows, period, label) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.totalScreenTime += row.totalScreenTime || 0;
      acc.totalSteps      += row.totalSteps || 0;
      acc.unlocks         += row.unlocks || 0;
      acc.notifications   += row.notifications || 0;
      return acc;
    },
    { totalScreenTime: 0, totalSteps: 0, unlocks: 0, notifications: 0 }
  );
  return { period, label, days: rows.length, ...totals, dailyBreakdown: rows };
}

function mergeDailyAppStats(rangeObj) {
  const merged = {};
  Object.values(rangeObj).forEach((dayStats) => {
    dayStats.forEach(({ appName, totalDuration, sessionCount }) => {
      if (!merged[appName]) {
        merged[appName] = { appName, totalDuration: 0, sessionCount: 0 };
      }
      merged[appName].totalDuration += totalDuration;
      merged[appName].sessionCount  += sessionCount;
    });
  });
  return Object.values(merged);
}

module.exports = router;