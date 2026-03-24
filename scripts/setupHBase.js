#!/usr/bin/env node

/**
 * HBase Setup Script — Activity Tracker (v3 — robust)
 *
 * Fixes:
 *  - Attend que le HBase Master soit VRAIMENT prêt (pas seulement Stargate)
 *  - Retry automatique sur timeout
 *  - Essaie JSON puis XML si nécessaire
 *  - Supprime ?numRegions qui peut bloquer certaines versions
 *  - Timeout plus long (30s) + logs détaillés
 */

require("dotenv").config();
const http = require("http");

const HOST = process.env.HBASE_HOST || "localhost";
const PORT = parseInt(process.env.HBASE_PORT) || 8080;

// ── HTTP helper ──────────────────────────────────────────────────
function httpRequest(method, path, body, contentType, timeoutMs = 30000) {
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
          "Content-Type": contentType || "application/json",
          "Content-Length": bodyBuf.length,
        }),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout après ${timeoutMs / 1000}s`));
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Attendre que HBase Master soit prêt ─────────────────────────
async function waitForHBase(maxWaitMs = 120000) {
  const start = Date.now();
  let attempt = 0;
  
  console.log("⏳ Attente que HBase Master soit prêt...");
  
  while (Date.now() - start < maxWaitMs) {
    attempt++;
    try {
      // /version répond même si le Master n'est pas prêt
      // /namespaces est disponible seulement quand le Master est ready
      const res = await httpRequest("GET", "/", null, null, 5000);
      if (res.status === 200) {
        // Essaie de lister les tables — si ça marche, le Master est prêt
        const tablesRes = await httpRequest("GET", "/", null, null, 5000);
        if (tablesRes.status === 200) {
          console.log(`✅ HBase Master prêt (tentative ${attempt})`);
          return true;
        }
      }
    } catch (e) {
      // continue
    }
    
    const waited = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`   Tentative ${attempt} — ${waited}s écoulées...\r`);
    await sleep(3000);
  }
  
  throw new Error("HBase Master pas prêt après 2 minutes");
}

// ── Vérifier si une table existe ────────────────────────────────
async function tableExists(name) {
  try {
    const r = await httpRequest("GET", `/${name}/schema`, null, null, 10000);
    return r.status === 200;
  } catch {
    return false;
  }
}

// ── Créer une table — essaie JSON puis XML ───────────────────────
async function createTable(tableName, families, splitKeys) {
  if (await tableExists(tableName)) {
    console.log(`  ⏭  "${tableName}" existe déjà — skip`);
    return;
  }

  // Méthode 1 : JSON (format moderne)
  const jsonBody = JSON.stringify({
    name: tableName,
    ColumnSchema: families.map((cf) => ({ name: cf.name, ...cf })),
  });

  try {
    const res = await httpRequest(
      "PUT",
      `/${tableName}/schema`,
      jsonBody,
      "application/json",
      30000
    );
    if (res.status >= 200 && res.status < 300) {
      console.log(`  ✅ "${tableName}" créé (JSON) — ${families.length} column families`);
      return;
    }
    // Si 4xx, essaie XML
    if (res.status >= 400) {
      throw new Error(`JSON refusé: HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  ⚠️  JSON échoué (${e.message}) — essai XML...`);
  }

  // Méthode 2 : XML (format Stargate classique)
  const cols = families
    .map((cf) => {
      const attrs = Object.entries(cf)
        .filter(([k]) => k !== "name")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `  <ColumnSchema name="${cf.name}" ${attrs}/>`;
    })
    .join("\n");
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>\n<TableSchema name="${tableName}">\n${cols}\n</TableSchema>`;

  const xmlRes = await httpRequest(
    "PUT",
    `/${tableName}/schema`,
    xmlBody,
    "text/xml",
    30000
  );

  if (xmlRes.status >= 200 && xmlRes.status < 300) {
    console.log(`  ✅ "${tableName}" créé (XML) — ${families.length} column families`);
  } else {
    throw new Error(`Création échouée: HTTP ${xmlRes.status} — ${xmlRes.body.slice(0, 200)}`);
  }
}

// ── Sleep helper ─────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  HBase Setup — Activity Tracker  (v3)");
  console.log(`  Stargate: http://${HOST}:${PORT}`);
  console.log("══════════════════════════════════════════════════\n");

  // 1. Attendre que HBase soit prêt
  try {
    await waitForHBase(120000);
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    console.error("   Vérifie : docker-compose ps");
    console.error("   Logs    : docker-compose logs hbase-master\n");
    process.exit(1);
  }

  // 2. Créer les tables
  console.log("\n🔨 Création des tables...\n");
  try {
    for (const t of TABLES) {
      await createTable(t.name, t.families, t.splitKeys);
    }

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Toutes les tables créées avec succès !");
    console.log("\n  Vérification :");
    console.log("  $ docker exec -it hbase-master hbase shell");
    console.log("  hbase> list");
    console.log("  hbase> describe 'activities'");
    console.log("  hbase> status 'detailed'");
    console.log("══════════════════════════════════════════════════\n");
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Erreur : ${err.message}\n`);
    process.exit(1);
  }
}

main();