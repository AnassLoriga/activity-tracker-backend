// ══════════════════════════════════════════════════════════════
//  HBase Table Definitions — Activity Tracker
//
//  ROW KEY DESIGN (Critical for Sharding):
//  ─────────────────────────────────────────
//  HBase distributes data across RegionServers based on row keys.
//  A well-designed row key ensures even distribution (= sharding).
//
//  ┌─────────────────┬──────────────────────────────────────────────────┐
//  │ Table           │ Row Key Pattern                                   │
//  ├─────────────────┼──────────────────────────────────────────────────┤
//  │ users           │ {userId}                                          │
//  │ activities      │ {userId}#{reverseTs}#{type}                       │
//  │ app_sessions    │ {userId}#{appName}#{date}                         │
//  │ daily_stats     │ {userId}#{year}#{month}#{day}                     │
//  └─────────────────┴──────────────────────────────────────────────────┘
//
//  WHY REVERSE TIMESTAMP?
//  Latest records are stored first → faster "get recent" scans.
//  reverseTs = (Long.MAX_VALUE - currentTime).toString()
//
//  REPLICATION (REPLICATION_SCOPE):
//  ─────────────────────────────────
//  Setting REPLICATION_SCOPE => 1 on a column family tells HBase
//  to replicate mutations of that family to peer clusters.
//  REPLICATION_SCOPE => 0 means no replication (default).
// ══════════════════════════════════════════════════════════════

const TABLES = {
  // ── users ──────────────────────────────────────────────────
  USERS: {
    name: "users",
    families: {
      INFO: "info",     // email, username, created_at, device_id
      AUTH: "auth",     // password_hash, last_login, tokens
      PREFS: "prefs",   // timezone, notification settings
    },
    // Pre-split keys for sharding (users distributed across 3 regions)
    // UUID prefixes ensure even distribution
    //splitKeys: ["4", "8", "c"],
    schema: {
      ColumnSchema: [
        { name: "info",  REPLICATION_SCOPE: "1", BLOOMFILTER: "ROW" },
        { name: "auth",  REPLICATION_SCOPE: "1" },
        { name: "prefs", REPLICATION_SCOPE: "0" },
      ],
    },
  },

  // ── activities ─────────────────────────────────────────────
  // Tracks every event: app_open, app_close, step_count, etc.
  ACTIVITIES: {
    name: "activities",
    families: {
      DATA: "data",       // app_name, event_type, metadata
      LOCATION: "loc",    // optional: lat, lng, accuracy
      DEVICE: "dev",      // battery, network_type, device_model
    },
    // Split by first char of userId → distributes across regions
    //splitKeys: ["3", "6", "9", "c", "f"],
    schema: {
      ColumnSchema: [
        {
          name: "data",
          REPLICATION_SCOPE: "1",   // ← replicated to peer clusters
          COMPRESSION: "SNAPPY",
          BLOOMFILTER: "ROWCOL",
          TTL: String(365 * 24 * 3600), // auto-delete after 1 year
        },
        {
          name: "loc",
          REPLICATION_SCOPE: "0",   // location data not replicated
          COMPRESSION: "SNAPPY",
        },
        {
          name: "dev",
          REPLICATION_SCOPE: "1",
          COMPRESSION: "SNAPPY",
        },
      ],
    },
  },

  // ── app_sessions ───────────────────────────────────────────
  // Aggregated per-app per-day usage
  APP_SESSIONS: {
    name: "app_sessions",
    families: {
      STATS: "stats", // total_duration, session_count, first_open, last_open
    },
    //splitKeys: ["4", "8", "c"],
    schema: {
      ColumnSchema: [
        {
          name: "stats",
          REPLICATION_SCOPE: "1",
          VERSIONS: "10",           // keep 10 historical versions
          BLOOMFILTER: "ROWCOL",
        },
      ],
    },
  },

  // ── daily_stats ────────────────────────────────────────────
  // Pre-aggregated stats per user per day (for fast dashboard queries)
  DAILY_STATS: {
    name: "daily_stats",
    families: {
      SUMMARY: "summary", // total_screen_time, total_steps, top_app, unlocks
      APPS: "apps",       // per-app breakdown stored as columns
    },
    //splitKeys: ["4", "8", "c"],
    schema: {
      ColumnSchema: [
        {
          name: "summary",
          REPLICATION_SCOPE: "1",
          VERSIONS: "1",  // only keep latest aggregation
          COMPRESSION: "SNAPPY",
        },
        {
          name: "apps",
          REPLICATION_SCOPE: "1",
          COMPRESSION: "SNAPPY",
        },
      ],
    },
  },
};

// ── Row Key Builders ────────────────────────────────────────────
const LONG_MAX = BigInt("9223372036854775807");

const RowKey = {
  /**
   * users: simple userId
   */
  user: (userId) => userId,

  /**
   * activities: userId#reverseTimestamp#type
   * reverseTs ensures newest events scan first
   */
  activity: (userId, timestamp, type) => {
    const reverseTs = (LONG_MAX - BigInt(timestamp)).toString().padStart(19, "0");
    return `${userId}#${reverseTs}#${type}`;
  },

  /**
   * app_sessions: userId#appName#YYYY-MM-DD
   */
  appSession: (userId, appName, date) => {
    const d = date || new Date().toISOString().slice(0, 10);
    return `${userId}#${appName}#${d}`;
  },

  /**
   * daily_stats: userId#YYYY#MM#DD
   */
  dailyStat: (userId, year, month, day) => {
    const m = String(month).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    return `${userId}#${year}#${m}#${d}`;
  },

  /**
   * Scan prefix: get all activities for a user
   * Scans from userId# to userId$  ($ comes after # in ASCII)
   */
  scanPrefix: (userId) => ({
    startRow: `${userId}#`,
    stopRow: `${userId}$`,
  }),
};

module.exports = { TABLES, RowKey };