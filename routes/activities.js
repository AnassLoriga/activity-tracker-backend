const express = require("express");
const { body, query, validationResult } = require("express-validator");
const { authenticate } = require("../middleware/auth");
const {
  ActivityService,
  AppSessionService,
  DailyStatsService,
} = require("../services/hbaseService");

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════
//  ACTIVITY EVENTS
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/activities
 * Record a new activity event from the phone
 *
 * Body: {
 *   type:     'app_open' | 'app_close' | 'screen_on' | 'screen_off'
 *             | 'step_count' | 'notification' | 'call' | 'sms'
 *   appName:  'com.facebook.katana'
 *   duration: 120000  (ms, for app_close events)
 *   metadata: { steps: 1500, network: 'wifi', battery: 85 }
 *   timestamp: 1700000000000  (optional, defaults to now)
 * }
 */
router.post(
  "/",
  [
    body("type").isIn([
      "app_open", "app_close", "screen_on", "screen_off",
      "step_count", "notification", "call", "sms", "social_join",
    ]),
    body("appName").optional().isString(),
    body("duration").optional().isNumeric(),
    body("timestamp").optional().isNumeric(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { type, appName, duration, metadata, timestamp } = req.body;

      // 1. Record raw activity event
      const rowKey = await ActivityService.record(req.userId, {
        type,
        appName,
        duration,
        metadata,
        timestamp,
      });

      // 2. If app_close: update aggregated app session stats
      if (type === "app_close" && appName && duration > 0) {
        await AppSessionService.addUsage(req.userId, appName, duration);
      }

      res.status(201).json({
        success: true,
        message: "Activity recorded",
        data: { rowKey },
      });
    } catch (err) {
      console.error("Record activity error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/**
 * POST /api/activities/batch
 * Record multiple activities at once (sync from phone)
 * Used when phone was offline and syncing buffered events
 */
router.post("/batch", async (req, res) => {
  try {
    const { events } = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, message: "events[] required" });
    }

    if (events.length > 500) {
      return res.status(400).json({ success: false, message: "Max 500 events per batch" });
    }

    const results = await Promise.allSettled(
      events.map((event) =>
        ActivityService.record(req.userId, event).then(async (rowKey) => {
          if (event.type === "app_close" && event.appName && event.duration > 0) {
            await AppSessionService.addUsage(req.userId, event.appName, event.duration);
          }
          return rowKey;
        })
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed    = results.filter((r) => r.status === "rejected").length;

    res.json({
      success: true,
      data: { total: events.length, succeeded, failed },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/activities
 * Get recent activities for the logged-in user
 *
 * Query params:
 *   limit    (default 50)
 *   type     filter by type
 *   from     start date ISO string
 *   to       end date ISO string
 */
router.get("/", async (req, res) => {
  try {
    const { limit = 50, type, from, to } = req.query;

    let activities;

    if (from && to) {
      activities = await ActivityService.getByDateRange(req.userId, from, to);
    } else if (type) {
      activities = await ActivityService.getByType(req.userId, type, parseInt(limit));
    } else {
      activities = await ActivityService.getRecent(req.userId, parseInt(limit));
    }

    res.json({ success: true, data: activities });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  APP SESSIONS (per-app usage)
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/activities/apps
 * Get app usage stats
 *
 * Query: date=2024-01-15  OR  from=2024-01-01&to=2024-01-31
 */
router.get("/apps", async (req, res) => {
  try {
    const { date, from, to } = req.query;

    let data;
    if (from && to) {
      data = await AppSessionService.getRangeStats(req.userId, from, to);
    } else {
      const d = date || new Date().toISOString().slice(0, 10);
      data = await AppSessionService.getDayStats(req.userId, d);
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  SPECIAL EVENTS
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/activities/social-join
 * Track when user joined a social platform
 * e.g. { platform: 'Facebook', joinedAt: '2024-01-15T10:30:00Z' }
 */
router.post("/social-join", async (req, res) => {
  try {
    const { platform, joinedAt } = req.body;

    if (!platform) {
      return res.status(400).json({ success: false, message: "platform required" });
    }

    const timestamp = joinedAt ? new Date(joinedAt).getTime() : Date.now();

    const rowKey = await ActivityService.record(req.userId, {
      type: "social_join",
      appName: platform.toLowerCase(),
      timestamp,
      metadata: {
        platform,
        joined_at_human: new Date(timestamp).toISOString(),
      },
    });

    res.status(201).json({
      success: true,
      message: `Recorded: joined ${platform}`,
      data: { rowKey, platform, joinedAt: new Date(timestamp).toISOString() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/activities/steps
 * Sync step count for a day
 */
router.post("/steps", async (req, res) => {
  try {
    const { steps, date } = req.body;

    if (!steps || isNaN(steps)) {
      return res.status(400).json({ success: false, message: "steps (number) required" });
    }

    const timestamp = date ? new Date(date).getTime() : Date.now();

    const rowKey = await ActivityService.record(req.userId, {
      type: "step_count",
      timestamp,
      metadata: { steps: parseInt(steps) },
    });

    res.status(201).json({
      success: true,
      data: { rowKey, steps: parseInt(steps) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;