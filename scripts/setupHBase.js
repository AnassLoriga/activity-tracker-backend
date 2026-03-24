#!/usr/bin/env node

/**
 * HBase Setup Script — Activity Tracker (FIXED)
 *
 * POURQUOI CE FIX ?
 * Le package npm `hbase` envoie un body malformé pour la création
 * de tables → Stargate coupe la connexion → "socket hang up"
 *
 * SOLUTION : appel direct à l'API REST Stargate avec http natif Node.js
 * Format attendu par Stargate :
 *   PUT http://localhost:8080/{tableName}/schema
 *   Content-Type: text/xml
 *   <TableSchema name="tableName">
 *     <ColumnSchema name="family" REPLICATION_SCOPE="1"/>
 *   </TableSchema>
 */

require("dotenv").config();
const http = require("http");
const { testConnection } = require("../config/hbase");

const HOST = process.env.HBASE_HOST || "localhost";
const PORT = parseInt(process.env.HBASE_PORT) || 8080;

// ── Appel HTTP direct à Stargate ─────────────────────────────────
function stargate(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body, "utf8") : null;
    const options = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: {
        Accept: "application/json",
        ...(bodyBuf && {
          "Content-Type": "text/xml",
          "Content-Length": bodyBuf.length,
        }),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else if (res.statusCode === 404) {
          resolve({ status: 404, body: data }); // table n'existe pas → normal
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("Timeout 20s")));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Vérifie si table existe ───────────────────────────────────────
async function tableExists(name) {
  try {
    const r = await stargate("GET", `/${name}/schema`);
    return r.status === 200;
  } catch {
    return false;
  }
}

// ── Construit le XML de création ─────────────────────────────────
function schemaXml(tableName, families) {
  const cols = families
    .map((cf) => {
      const attrs = Object.entries(cf)
        .filter(([k]) => k !== "name")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `  <ColumnSchema name="${cf.name}" ${attrs}/>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<TableSchema name="${tableName}">\n${cols}\n</TableSchema>`;
}

// ── Crée une table ────────────────────────────────────────────────
async function createTable(tableName, families, splitKeys) {
  if (await tableExists(tableName)) {
    console.log(`  ⏭  "${tableName}" existe déjà — skip`);
    return;
  }
  const xml = schemaXml(tableName, families);
  // numRegions pour le pré-split (sharding)
  const qs = splitKeys ? `?numRegions=${splitKeys.length + 1}` : "";
  await stargate("PUT", `/${tableName}/schema${qs}`, xml);
  const regions = splitKeys ? ` (${splitKeys.length + 1} régions)` : "";
  console.log(`  ✅ Créé "${tableName}"${regions}`);
}

// ── Définition des tables ─────────────────────────────────────────
const TABLES = [
  {
    name: "users",
    splitKeys: ["4", "8", "c"],
    families: [
      { name: "info",  REPLICATION_SCOPE: "1", BLOOMFILTER: "ROW" },
      { name: "auth",  REPLICATION_SCOPE: "1" },
      { name: "prefs", REPLICATION_SCOPE: "0" },
    ],
  },
  {
    name: "activities",
    splitKeys: ["3", "6", "9", "c", "f"],
    families: [
      { name: "data", REPLICATION_SCOPE: "1", BLOOMFILTER: "ROWCOL", TTL: "31536000" },
      { name: "loc",  REPLICATION_SCOPE: "0" },
      { name: "dev",  REPLICATION_SCOPE: "1" },
    ],
  },
  {
    name: "app_sessions",
    splitKeys: ["4", "8", "c"],
    families: [
      { name: "stats", REPLICATION_SCOPE: "1", VERSIONS: "10" },
    ],
  },
  {
    name: "daily_stats",
    splitKeys: ["4", "8", "c"],
    families: [
      { name: "summary", REPLICATION_SCOPE: "1", VERSIONS: "1" },
      { name: "apps",    REPLICATION_SCOPE: "1" },
    ],
  },
];

// ── Affichage du plan ─────────────────────────────────────────────
function printPlan(table) {
  console.log(`\n  📋 ${table.name}`);
  table.families.forEach((cf) => {
    const rep = cf.REPLICATION_SCOPE === "1" ? "🔁 replicated" : "🔒 local only";
    console.log(`     "${cf.name}": ${rep}${cf.TTL ? `, TTL=${cf.TTL}s` : ""}`);
  });
  console.log(`     Sharding: ${(table.splitKeys.length + 1)} régions (splits: [${table.splitKeys.join(",")}])`);
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  HBase Setup — Activity Tracker");
  console.log(`  Stargate: http://${HOST}:${PORT}`);
  console.log("══════════════════════════════════════════════════");

  try {
    await testConnection();
  } catch {
    console.error("\n❌ HBase inaccessible — lance : docker-compose up -d\n");
    process.exit(1);
  }

  console.log("\n📦 Plan :");
  TABLES.forEach(printPlan);

  console.log("\n🔨 Création...\n");
  try {
    for (const t of TABLES) {
      await createTable(t.name, t.families, t.splitKeys);
    }

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Toutes les tables créées !");
    console.log("\n  Vérifier dans HBase Shell :");
    console.log("  $ docker exec -it hbase-master hbase shell");
    console.log("  hbase> list");
    console.log("  hbase> describe 'activities'");
    console.log("  hbase> status 'detailed'");
    console.log("══════════════════════════════════════════════════\n");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Erreur :", err.message);
    process.exit(1);
  }
}

main();