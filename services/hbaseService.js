const { client } = require("../config/hbase");
const { TABLES, RowKey } = require("../config/tables");

// ──────────────────────────────────────────────────────────────────
//  HBase Service — Wraps the hbase npm client with Promise-based
//  helpers for all tables.
//
//  HBase stores everything as bytes. Values are base64 encoded
//  by the REST API.  The client library handles encoding for us.
// ──────────────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Convert HBase row cells array → plain object
 * Input:  [{ column: 'info:email', $ : 'test@mail.com', timestamp: ... }]
 * Output: { 'info:email': 'test@mail.com', timestamp: ... }
 */
const cellsToObject = (cells = []) => {
  const obj = {};
  cells.forEach((cell) => {
    const col = cell.column.toString();
    obj[col] = cell.$.toString();
    if (!obj._timestamp) obj._timestamp = cell.timestamp;
  });
  return obj;
};

/**
 * Put a row into HBase
 * @param {string} table
 * @param {string} rowKey
 * @param {Array}  values  [{column:'family:qualifier', $:'value'}]
 */
const putRow = (table, rowKey, values) => {
  return new Promise((resolve, reject) => {
    client
      .table(table)
      .row(rowKey)
      .put(values, (err, success) => {
        if (err) return reject(err);
        resolve(success);
      });
  });
};

/**
 * Get a single row from HBase
 */
const getRow = (table, rowKey) => {
  return new Promise((resolve, reject) => {
    client
      .table(table)
      .row(rowKey)
      .get((err, cells) => {
        if (err) return reject(err);
        if (!cells || cells.length === 0) return resolve(null);
        resolve(cellsToObject(cells));
      });
  });
};

/**
 * Scan rows in a range (for listing activities, stats, etc.)
 */
const scanRows = (table, options = {}) => {
  return new Promise((resolve, reject) => {
    const scanner = client.table(table).scan(
      {
        startRow: options.startRow,
        stopRow: options.stopRow,
        maxVersions: options.maxVersions || 1,
        filter: options.filter || null,
        numberOfRows: options.limit || 100,
      },
      (err, rows) => {
        if (err) return reject(err);
        const result = (rows || []).map((row) => ({
          key: row.key.toString(),
          ...cellsToObject(row.columns),
        }));
        resolve(result);
      }
    );
  });
};

/**
 * Delete a row
 */
const deleteRow = (table, rowKey) => {
  return new Promise((resolve, reject) => {
    client
      .table(table)
      .row(rowKey)
      .delete((err, success) => {
        if (err) return reject(err);
        resolve(success);
      });
  });
};

// ════════════════════════════════════════════════════════════════
//  USER OPERATIONS
// ════════════════════════════════════════════════════════════════

const UserService = {
  /**
   * Create a new user
   */
  async create(userId, { email, username, passwordHash, deviceId }) {
    const now = Date.now().toString();
    await putRow(TABLES.USERS.name, RowKey.user(userId), [
      { column: "info:email",      $: email },
      { column: "info:username",   $: username },
      { column: "info:device_id",  $: deviceId || "" },
      { column: "info:created_at", $: now },
      { column: "auth:password_hash", $: passwordHash },
      { column: "auth:last_login",    $: now },
    ]);
    return userId;
  },

  /**
   * Get user by ID
   */
  async getById(userId) {
    return getRow(TABLES.USERS.name, RowKey.user(userId));
  },

  /**
   * Scan all users (admin use — limited)
   */
  async list(limit = 50) {
    return scanRows(TABLES.USERS.name, { limit });
  },

  /**
   * Update last login timestamp
   */
  async updateLastLogin(userId) {
    await putRow(TABLES.USERS.name, RowKey.user(userId), [
      { column: "auth:last_login", $: Date.now().toString() },
    ]);
  },

  /**
   * Update device ID (when user logs in from new device)
   */
  async updateDeviceId(userId, deviceId) {
    await putRow(TABLES.USERS.name, RowKey.user(userId), [
      { column: "info:device_id", $: deviceId },
    ]);
  },
};

// ════════════════════════════════════════════════════════════════
//  ACTIVITY OPERATIONS
// ════════════════════════════════════════════════════════════════

const ActivityService = {
  /**
   * Record a new activity event
   * types: 'app_open', 'app_close', 'screen_on', 'screen_off',
   *        'step_count', 'notification', 'call', 'sms'
   */
  async record(userId, { type, appName, duration, metadata, timestamp }) {
    const ts = timestamp || Date.now();
    const rowKey = RowKey.activity(userId, ts, type);

    const values = [
      { column: "data:type",      $: type },
      { column: "data:app_name",  $: appName || "" },
      { column: "data:duration",  $: String(duration || 0) },
      { column: "data:timestamp", $: String(ts) },
    ];

    if (metadata) {
      Object.entries(metadata).forEach(([k, v]) => {
        values.push({ column: `data:meta_${k}`, $: String(v) });
      });
    }

    await putRow(TABLES.ACTIVITIES.name, rowKey, values);
    return rowKey;
  },

  /**
   * Get recent activities for a user
   * Uses reverseTimestamp row key → newest first automatically
   */
  async getRecent(userId, limit = 50) {
    const { startRow, stopRow } = RowKey.scanPrefix(userId);
    const rows = await scanRows(TABLES.ACTIVITIES.name, {
      startRow,
      stopRow,
      limit,
    });

    return rows.map((row) => ({
      id: row.key,
      type: row["data:type"],
      appName: row["data:app_name"],
      duration: parseInt(row["data:duration"] || 0),
      timestamp: parseInt(row["data:timestamp"]),
    }));
  },

  /**
   * Get activities filtered by date range
   */
  async getByDateRange(userId, startDate, endDate) {
    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    const LONG_MAX = BigInt("9223372036854775807");

    // reverseTs for start (newest boundary) and end (oldest boundary)
    const revStart = (LONG_MAX - BigInt(endTs)).toString().padStart(19, "0");
    const revEnd   = (LONG_MAX - BigInt(startTs)).toString().padStart(19, "0");

    return scanRows(TABLES.ACTIVITIES.name, {
      startRow: `${userId}#${revStart}`,
      stopRow:  `${userId}#${revEnd}`,
      limit: 500,
    });
  },

  /**
   * Get activities by type for a user
   */
  async getByType(userId, type, limit = 100) {
    const all = await ActivityService.getRecent(userId, 500);
    return all.filter((a) => a.type === type).slice(0, limit);
  },
};

// ════════════════════════════════════════════════════════════════
//  APP SESSION OPERATIONS
// ════════════════════════════════════════════════════════════════

const AppSessionService = {
  /**
   * Increment app usage for today
   * Called when an app_close event is received with duration
   */
  async addUsage(userId, appName, durationMs) {
    const date = new Date().toISOString().slice(0, 10);
    const rowKey = RowKey.appSession(userId, appName, date);

    // Read current stats first
    let current = await getRow(TABLES.APP_SESSIONS.name, rowKey);
    const prevDuration = parseInt(current?.["stats:total_duration"] || 0);
    const prevSessions = parseInt(current?.["stats:session_count"] || 0);

    await putRow(TABLES.APP_SESSIONS.name, rowKey, [
      { column: "stats:total_duration", $: String(prevDuration + durationMs) },
      { column: "stats:session_count",  $: String(prevSessions + 1) },
      { column: "stats:last_open",      $: Date.now().toString() },
      { column: "stats:app_name",       $: appName },
      ...(prevSessions === 0
        ? [{ column: "stats:first_open", $: Date.now().toString() }]
        : []),
    ]);
  },

  /**
   * Get all app usage for a specific day
   */
  async getDayStats(userId, date) {
    const { startRow, stopRow } = RowKey.scanPrefix(userId);
    const rows = await scanRows(TABLES.APP_SESSIONS.name, {
      startRow: `${userId}#`,
      stopRow:  `${userId}$`,
      limit: 200,
    });

    // Filter by date (format: userId#appName#date)
    return rows
      .filter((r) => r.key.endsWith(`#${date}`))
      .map((r) => ({
        appName: r["stats:app_name"],
        totalDuration: parseInt(r["stats:total_duration"] || 0),
        sessionCount:  parseInt(r["stats:session_count"] || 0),
        firstOpen: parseInt(r["stats:first_open"] || 0),
        lastOpen:  parseInt(r["stats:last_open"] || 0),
      }))
      .sort((a, b) => b.totalDuration - a.totalDuration);
  },

  /**
   * Get app usage for a date range (for charts)
   */
  async getRangeStats(userId, startDate, endDate) {
    const start = new Date(startDate);
    const end   = new Date(endDate);
    const days  = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }

    const results = await Promise.all(
      days.map((date) => AppSessionService.getDayStats(userId, date))
    );

    return days.reduce((acc, date, i) => {
      acc[date] = results[i];
      return acc;
    }, {});
  },
};

// ════════════════════════════════════════════════════════════════
//  DAILY STATS OPERATIONS (pre-aggregated for dashboard)
// ════════════════════════════════════════════════════════════════

const DailyStatsService = {
  /**
   * Upsert aggregated daily stats
   * Called by a scheduled job or on-the-fly
   */
  async upsert(userId, date, stats) {
    const [year, month, day] = date.split("-");
    const rowKey = RowKey.dailyStat(userId, year, month, day);

    const values = [
      { column: "summary:date",             $: date },
      { column: "summary:total_screen_time",$: String(stats.totalScreenTime || 0) },
      { column: "summary:total_steps",      $: String(stats.totalSteps || 0) },
      { column: "summary:unlocks",          $: String(stats.unlocks || 0) },
      { column: "summary:top_app",          $: stats.topApp || "" },
      { column: "summary:notifications",    $: String(stats.notifications || 0) },
      { column: "summary:updated_at",       $: Date.now().toString() },
    ];

    // Per-app breakdown stored as dynamic columns
    if (stats.appBreakdown) {
      Object.entries(stats.appBreakdown).forEach(([app, duration]) => {
        values.push({ column: `apps:${app}`, $: String(duration) });
      });
    }

    await putRow(TABLES.DAILY_STATS.name, rowKey, values);
  },

  /**
   * Get stats for a specific day
   */
  async getDay(userId, date) {
    const [year, month, day] = date.split("-");
    const row = await getRow(
      TABLES.DAILY_STATS.name,
      RowKey.dailyStat(userId, year, month, day)
    );
    if (!row) return null;
    return DailyStatsService._formatRow(row);
  },

  /**
   * Get stats for a month
   */
  async getMonth(userId, year, month) {
    const m = String(month).padStart(2, "0");
    const startRow = `${userId}#${year}#${m}#01`;
    const stopRow  = `${userId}#${year}#${m}#32`;

    const rows = await scanRows(TABLES.DAILY_STATS.name, {
      startRow,
      stopRow,
      limit: 31,
    });
    return rows.map(DailyStatsService._formatRow);
  },

  /**
   * Get stats for a year (monthly aggregation)
   */
  async getYear(userId, year) {
    const startRow = `${userId}#${year}#01`;
    const stopRow  = `${userId}#${year}#13`;

    const rows = await scanRows(TABLES.DAILY_STATS.name, {
      startRow,
      stopRow,
      limit: 365,
    });
    return rows.map(DailyStatsService._formatRow);
  },

  _formatRow(row) {
    const appBreakdown = {};
    Object.entries(row).forEach(([k, v]) => {
      if (k.startsWith("apps:")) {
        appBreakdown[k.replace("apps:", "")] = parseInt(v);
      }
    });
    return {
      date:            row["summary:date"],
      totalScreenTime: parseInt(row["summary:total_screen_time"] || 0),
      totalSteps:      parseInt(row["summary:total_steps"] || 0),
      unlocks:         parseInt(row["summary:unlocks"] || 0),
      topApp:          row["summary:top_app"] || "",
      notifications:   parseInt(row["summary:notifications"] || 0),
      appBreakdown,
    };
  },
};

module.exports = {
  UserService,
  ActivityService,
  AppSessionService,
  DailyStatsService,
  putRow,
  getRow,
  scanRows,
};