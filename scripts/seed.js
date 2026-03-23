#!/usr/bin/env node
/**
 * Seed demo data for school project presentation
 * Creates a test user with realistic activity data for the past 30 days
 */

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { testConnection } = require("../config/hbase");
const {
  UserService,
  ActivityService,
  AppSessionService,
  DailyStatsService,
} = require("../services/hbaseService");
const { putRow } = require("../services/hbaseService");
const { TABLES } = require("../config/tables");

// Demo apps to simulate
const DEMO_APPS = [
  { name: "com.facebook.katana",   label: "Facebook",   avgSession: 8 * 60000 },
  { name: "com.instagram.android", label: "Instagram",  avgSession: 12 * 60000 },
  { name: "com.whatsapp",          label: "WhatsApp",   avgSession: 5 * 60000 },
  { name: "com.google.youtube",    label: "YouTube",    avgSession: 20 * 60000 },
  { name: "com.netflix.mediaclient",label: "Netflix",   avgSession: 45 * 60000 },
  { name: "com.spotify.music",     label: "Spotify",    avgSession: 30 * 60000 },
  { name: "com.google.android.gm", label: "Gmail",      avgSession: 3 * 60000 },
  { name: "com.twitter.android",   label: "Twitter",    avgSession: 7 * 60000 },
];

const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const variance = (val) => val * (0.7 + Math.random() * 0.6);

async function seed() {
  console.log("\n🌱 Seeding demo data...\n");

  await testConnection();

  // 1. Create demo user
  const userId       = uuidv4();
  const email        = "demo@activitytracker.com";
  const passwordHash = await bcrypt.hash("demo123", 12);

  await UserService.create(userId, {
    email,
    username: "DemoUser",
    passwordHash,
    deviceId: "android-demo-device",
  });

  // Email lookup
  await putRow(TABLES.USERS.name, `email#${email}`, [
    { column: "info:user_id", $: userId },
  ]);

  console.log(`✅ Created user: ${email} / demo123 (userId: ${userId})`);

  // 2. Record social join events
  const socialJoins = [
    { platform: "Facebook",  daysAgo: 3650 }, // 10 years ago
    { platform: "Instagram", daysAgo: 1825 },
    { platform: "WhatsApp",  daysAgo: 2000 },
    { platform: "Twitter",   daysAgo: 1000 },
    { platform: "TikTok",    daysAgo: 365 },
  ];

  for (const join of socialJoins) {
    const ts = Date.now() - join.daysAgo * 24 * 60 * 60 * 1000;
    await ActivityService.record(userId, {
      type: "social_join",
      appName: join.platform.toLowerCase(),
      timestamp: ts,
      metadata: { platform: join.platform },
    });
  }
  console.log("✅ Recorded social join events");

  // 3. Generate 30 days of activity data
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const day = new Date(today);
    day.setDate(day.getDate() - daysAgo);
    const dateStr = day.toISOString().slice(0, 10);

    // Screen on/off events (simulate unlocks)
    const unlocks = randomBetween(20, 80);
    for (let i = 0; i < unlocks; i++) {
      const ts = day.getTime() + randomBetween(0, 24 * 3600 * 1000);
      await ActivityService.record(userId, {
        type: "screen_on",
        timestamp: ts,
      });
    }

    // App usage per app
    const appBreakdown = {};
    let topApp = null;
    let topDuration = 0;

    for (const app of DEMO_APPS) {
      const sessions  = randomBetween(1, 10);
      const totalTime = Math.round(variance(app.avgSession * sessions));

      await AppSessionService.addUsage(userId, app.name, totalTime);
      appBreakdown[app.name] = totalTime;

      if (totalTime > topDuration) {
        topDuration = totalTime;
        topApp = app.name;
      }
    }

    // Steps
    const steps = randomBetween(2000, 12000);
    await ActivityService.record(userId, {
      type: "step_count",
      timestamp: day.getTime() + 23 * 3600 * 1000,
      metadata: { steps },
    });

    // Aggregate daily stats
    const totalScreenTime = Object.values(appBreakdown).reduce((s, v) => s + v, 0);
    await DailyStatsService.upsert(userId, dateStr, {
      totalScreenTime,
      totalSteps: steps,
      unlocks,
      topApp,
      notifications: randomBetween(20, 150),
      appBreakdown,
    });

    process.stdout.write(`  📅 ${dateStr} ✓\r`);
  }

  console.log("\n✅ Generated 30 days of activity data");

  console.log("\n══════════════════════════════════════════════════");
  console.log("  🎉 Seed complete!");
  console.log("\n  Demo credentials:");
  console.log("    Email:    demo@activitytracker.com");
  console.log("    Password: demo123");
  console.log("\n  Test login:");
  console.log('  curl -X POST http://localhost:3000/api/auth/login \\');
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"email":"demo@activitytracker.com","password":"demo123"}\'');
  console.log("══════════════════════════════════════════════════\n");

  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed error:", err);
  process.exit(1);
});