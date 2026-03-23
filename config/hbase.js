const hbase = require("hbase");

// ──────────────────────────────────────────────────────────────────
//  HBase Client (via REST/Stargate API)
//  The Node.js `hbase` package communicates with HBase through
//  HBase's built-in REST server (Stargate), running on port 8080.
// ──────────────────────────────────────────────────────────────────

const client = hbase({
  host: process.env.HBASE_HOST || "localhost",
  port: parseInt(process.env.HBASE_PORT) || 8080,
  timeout: parseInt(process.env.HBASE_TIMEOUT) || 10000,
  protocol: "http",
  encoding: "UTF-8",
  // krb5 can be added here for Kerberos auth in production
});

// Test connection
const testConnection = () => {
  return new Promise((resolve, reject) => {
    client.version((err, version) => {
      if (err) {
        console.error("❌ HBase connection failed:", err.message);
        reject(err);
      } else {
        console.log("✅ HBase connected — version:", JSON.stringify(version));
        resolve(version);
      }
    });
  });
};

module.exports = { client, testConnection };