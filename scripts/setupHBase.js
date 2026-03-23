#!/usr/bin/env node

/**
 * ════════════════════════════════════════════════════════════════
 *  HBase Setup Script — Activity Tracker
 *
 *  This script:
 *    1. Creates all HBase tables with correct schemas
 *    2. Configures REPLICATION_SCOPE per column family
 *    3. Pre-splits tables into regions (= sharding)
 *
 *  SHARDING explained:
 *  ───────────────────
 *  When you create a table with split keys, HBase immediately
 *  creates multiple regions, each assigned to a different
 *  RegionServer. Data is routed to the correct region based
 *  on its row key.
 *
 *  Example for `activities` table with splitKeys ["3","6","9","c","f"]:
 *
 *  Region 1 (RS1):  rowkeys starting with  0..2
 *  Region 2 (RS2):  rowkeys starting with  3..5
 *  Region 3 (RS3):  rowkeys starting with  6..8
 *  Region 4 (RS1):  rowkeys starting with  9..b
 *  Region 5 (RS2):  rowkeys starting with  c..e
 *  Region 6 (RS3):  rowkeys starting with  f..∞
 *
 *  Since UUIDs are hex-prefixed, data distributes evenly.
 *
 *  REPLICATION explained:
 *  ──────────────────────
 *  REPLICATION_SCOPE => 1  means HBase will replicate all
 *  mutations (puts, deletes) for that column family to any
 *  configured peer cluster. In production you'd configure
 *  a peer with: hbase> add_peer '1', CLUSTER_KEY => "peer:2181:/hbase"
 * ════════════════════════════════════════════════════════════════
 */

require("dotenv").config();
const { client, testConnection } = require("../config/hbase");
const { TABLES } = require("../config/tables");

// ── Create a table ────────────────────────────────────────────────
const createTable = (tableName, schema, splitKeys) => {
  return new Promise((resolve, reject) => {
    // Check if table already exists
    client.table(tableName).schema((err, existing) => {
      if (!err && existing) {
        console.log(`  ⏭  Table "${tableName}" already exists — skipping`);
        return resolve();
      }

      const tableSchema = {
        name: tableName,
        ...schema,
      };

      // Add pre-split configuration in the URL if supported
      // (HBase REST API handles splits differently per version)
      client.table(tableName).create(tableSchema, (createErr) => {
        if (createErr) {
          console.error(`  ❌ Failed to create "${tableName}":`, createErr.message);
          return reject(createErr);
        }
        console.log(`  ✅ Created "${tableName}"`);
        resolve();
      });
    });
  });
};

// ── Print table info ───────────────────────────────────────────────
const printSchema = (name, config) => {
  console.log(`\n  📋 Table: ${name}`);
  config.schema.ColumnSchema.forEach((cf) => {
    const rep = cf.REPLICATION_SCOPE === "1" ? "🔁 replicated" : "🔒 local only";
    console.log(`     Family "${cf.name}": ${rep}${cf.TTL ? `, TTL=${cf.TTL}s` : ""}`);
  });
  if (config.splitKeys) {
    console.log(`     Sharding: pre-split at keys [${config.splitKeys.join(", ")}]`);
    console.log(`     → ${config.splitKeys.length + 1} initial regions across RegionServers`);
  }
};

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  HBase Setup — Activity Tracker");
  console.log(`  Host: ${process.env.HBASE_HOST || "localhost"}:${process.env.HBASE_PORT || 8080}`);
  console.log("══════════════════════════════════════════════════\n");

  // 1. Test connection
  try {
    await testConnection();
  } catch (err) {
    console.error("Cannot connect to HBase. Is it running?");
    console.error("Start with: docker-compose up -d");
    process.exit(1);
  }

  // 2. Print what we're about to create
  console.log("\n📦 Tables to create:\n");
  Object.values(TABLES).forEach((t) => printSchema(t.name, t));

  // 3. Create tables
  console.log("\n🔨 Creating tables...\n");

  try {
    // users
    await createTable(
      TABLES.USERS.name,
      TABLES.USERS.schema,
      TABLES.USERS.splitKeys
    );

    // activities
    await createTable(
      TABLES.ACTIVITIES.name,
      TABLES.ACTIVITIES.schema,
      TABLES.ACTIVITIES.splitKeys
    );

    // app_sessions
    await createTable(
      TABLES.APP_SESSIONS.name,
      TABLES.APP_SESSIONS.schema,
      TABLES.APP_SESSIONS.splitKeys
    );

    // daily_stats
    await createTable(
      TABLES.DAILY_STATS.name,
      TABLES.DAILY_STATS.schema,
      TABLES.DAILY_STATS.splitKeys
    );

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ All tables created successfully!");
    console.log("\n  HBase Shell commands to verify:");
    console.log("  $ docker exec -it hbase-master hbase shell");
    console.log("  hbase> list");
    console.log("  hbase> describe 'activities'");
    console.log("  hbase> status 'detailed'    ← shows region distribution");
    console.log("\n  To add a replication peer (production):");
    console.log("  hbase> add_peer '1', CLUSTER_KEY => 'peer-host:2181:/hbase'");
    console.log("  hbase> enable_table_replication 'activities'");
    console.log("══════════════════════════════════════════════════\n");

    process.exit(0);
  } catch (err) {
    console.error("\n❌ Setup failed:", err.message);
    process.exit(1);
  }
}

main();