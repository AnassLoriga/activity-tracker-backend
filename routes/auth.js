const express = require("express");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const { UserService } = require("../services/hbaseService");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

// ──────────────────────────────────────────────────────────────────
//  IMPORTANT: HBase doesn't have a native secondary index.
//  To look up a user by email, we use a simple convention:
//  We store a "lookup" row in the users table with row key = email,
//  containing only the userId. This is a common HBase pattern.
// ──────────────────────────────────────────────────────────────────

const { putRow, getRow } = require("../services/hbaseService");
const { TABLES } = require("../config/tables");

const createEmailLookup = async (email, userId) => {
  await putRow(TABLES.USERS.name, `email#${email}`, [
    { column: "info:user_id", $: userId },
  ]);
};

const getUserIdByEmail = async (email) => {
  const row = await getRow(TABLES.USERS.name, `email#${email}`);
  return row ? row["info:user_id"] : null;
};

// ── POST /api/auth/register ──────────────────────────────────────
router.post(
  "/register",
  [
    body("email").isEmail().normalizeEmail(),
    body("username").isLength({ min: 3, max: 30 }).trim(),
    body("password").isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { email, username, password, deviceId } = req.body;

      // Check email uniqueness via lookup row
      const existing = await getUserIdByEmail(email);
      if (existing) {
        return res
          .status(409)
          .json({ success: false, message: "Email already registered" });
      }

      const userId       = uuidv4();
      const passwordHash = await bcrypt.hash(password, 12);

      // 1. Create user row (sharded by UUID prefix)
      await UserService.create(userId, {
        email,
        username,
        passwordHash,
        deviceId,
      });

      // 2. Create email lookup row
      await createEmailLookup(email, userId);

      // 3. Generate JWT
      const token = jwt.sign(
        { userId, username },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      res.status(201).json({
        success: true,
        message: "Account created",
        data: { userId, username, email, token },
      });
    } catch (err) {
      console.error("Register error:", err);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
);

// ── POST /api/auth/login ─────────────────────────────────────────
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { email, password, deviceId } = req.body;

      // Lookup userId by email
      const userId = await getUserIdByEmail(email);
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid email or password" });
      }

      // Get user row
      const user = await UserService.getById(userId);
      if (!user) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid email or password" });
      }

      // Verify password
      const valid = await bcrypt.compare(password, user["auth:password_hash"]);
      if (!valid) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid email or password" });
      }

      // Update last login & device
      await UserService.updateLastLogin(userId);
      if (deviceId) await UserService.updateDeviceId(userId, deviceId);

      const token = jwt.sign(
        { userId, username: user["info:username"] },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      res.json({
        success: true,
        data: {
          userId,
          username: user["info:username"],
          email: user["info:email"],
          token,
        },
      });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
);

// ── GET /api/auth/me ─────────────────────────────────────────────
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await UserService.getById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      data: {
        userId:    req.userId,
        username:  user["info:username"],
        email:     user["info:email"],
        deviceId:  user["info:device_id"],
        createdAt: parseInt(user["info:created_at"]),
        lastLogin: parseInt(user["auth:last_login"]),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ── POST /api/auth/logout ────────────────────────────────────────
// JWT is stateless — client just discards the token.
// Optionally you can maintain a blacklist in HBase.
router.post("/logout", authenticate, (req, res) => {
  res.json({ success: true, message: "Logged out. Discard your token." });
});

module.exports = router;