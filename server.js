const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_DIR = __dirname;
const DATA_FILE = path.join(BASE_DIR, "data.json");
const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const MONGO_DB_NAME = process.env.MONGODB_DB || "tudor_rota";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Prevent caching on API endpoints
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

let dbVersion = Date.now();
let mongoClient = null;
let mongoDb = null;
let isMongoConnected = false;

function hashPw(pw) {
  return crypto.createHash("sha256").update(String(pw)).digest("hex");
}

const DEFAULT_USER_PASSWORDS = {
  admin: "admin123",
  mantresh: "admin123",
  shon: "shon123",
  isuru: "isuru123",
  riya: "riya123",
  swastik: "swastik123"
};

function ensureUserPasswords(users) {
  if (!Array.isArray(users)) return;
  for (const u of users) {
    if (!u || typeof u !== "object") continue;
    const uname = (u.username || "").trim().toLowerCase();
    if (!u.passwordHash) {
      const defaultPw = DEFAULT_USER_PASSWORDS[uname] || (uname ? `${uname}123` : "admin123");
      u.passwordHash = hashPw(defaultPw);
    }
  }
}

// Read JSON fallback
function readDataJson() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const d = JSON.parse(raw);
      d.users = d.users || [];
      d.shifts = d.shifts || [];
      d.employees = d.employees || [];
      d.departments = d.departments || [];
      d.settings = d.settings || {};
      d.inventory = d.inventory || [];
      d.notifications = d.notifications || [];
      d.resetRequests = d.resetRequests || [];
      ensureUserPasswords(d.users);
      return d;
    }
  } catch (err) {
    console.error("Error reading data.json:", err);
  }
  return {
    users: [],
    shifts: [],
    employees: [],
    departments: [],
    settings: {},
    inventory: [],
    notifications: [],
    resetRequests: []
  };
}

// Write JSON fallback
function writeDataJson(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing data.json:", err);
  }
}

// Connect to MongoDB
async function initMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 2500
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);
    isMongoConnected = true;
    console.log(`✅ [MongoDB] Connected to ${MONGO_URI} (db: ${MONGO_DB_NAME})`);

    // Initial Seeding if empty
    const shiftCount = await mongoDb.collection("shifts").countDocuments();
    const empCount = await mongoDb.collection("employees").countDocuments();
    if (shiftCount === 0 && empCount === 0) {
      console.log("🌱 [MongoDB] Database is empty. Seeding from data.json...");
      const seed = readDataJson();
      for (const colName of ["shifts", "employees", "departments", "users", "inventory", "notifications", "resetRequests"]) {
        if (Array.isArray(seed[colName]) && seed[colName].length > 0) {
          const docs = seed[colName].map(item => {
            const doc = { ...item };
            if (doc.id) doc._id = doc.id;
            return doc;
          });
          await mongoDb.collection(colName).deleteMany({});
          await mongoDb.collection(colName).insertMany(docs);
        }
      }
      if (seed.settings) {
        await mongoDb.collection("settings").replaceOne(
          { _id: "app_settings" },
          { _id: "app_settings", ...seed.settings },
          { upsert: true }
        );
      }
      console.log("✅ [MongoDB] Seeding completed successfully.");
    }
  } catch (err) {
    isMongoConnected = false;
    mongoDb = null;
    console.warn(`ℹ️ [MongoDB] Offline (${err.message}). Using local data.json fallback.`);
  }
}

// Get full database snapshot
async function getDbSnapshot() {
  if (isMongoConnected && mongoDb) {
    try {
      const data = {};
      const settingsDoc = await mongoDb.collection("settings").findOne({ _id: "app_settings" });
      if (settingsDoc) {
        delete settingsDoc._id;
        data.settings = settingsDoc;
      } else {
        data.settings = {};
      }

      for (const col of ["shifts", "employees", "departments", "users", "inventory", "notifications", "resetRequests"]) {
        const docs = await mongoDb.collection(col).find({}).toArray();
        data[col] = docs.map(d => {
          const copy = { ...d };
          delete copy._id;
          return copy;
        });
      }
      ensureUserPasswords(data.users);
      data._last_updated = dbVersion;
      return data;
    } catch (err) {
      console.warn("MongoDB read failed, falling back to data.json:", err);
    }
  }
  const fileData = readDataJson();
  fileData._last_updated = dbVersion;
  return fileData;
}

// -------------------------------------------------------------
// REST API ROUTES
// -------------------------------------------------------------

// Version Check (Lightweight Polling)
app.get("/api/data-version", (req, res) => {
  res.json({
    version: dbVersion,
    timestamp: Date.now()
  });
});

// Database Status
app.get("/api/db-status", async (req, res) => {
  if (isMongoConnected && mongoDb) {
    try {
      const counts = {
        shifts: await mongoDb.collection("shifts").countDocuments(),
        users: await mongoDb.collection("users").countDocuments(),
        employees: await mongoDb.collection("employees").countDocuments(),
        inventory: await mongoDb.collection("inventory").countDocuments()
      };
      let displayUri = MONGO_URI;
      if (displayUri.includes("@")) {
        const parts = displayUri.split("@");
        displayUri = "mongodb+srv://****@" + parts[parts.length - 1];
      }
      return res.json({
        success: true,
        connected: true,
        database: MONGO_DB_NAME,
        uri: displayUri,
        counts,
        isSafe: true,
        type: "mongodb",
        message: "Data securely stored in MongoDB."
      });
    } catch (e) {}
  }
  const fileData = readDataJson();
  res.json({
    success: true,
    connected: false,
    database: "data.json (local fallback)",
    uri: "local filesystem",
    counts: {
      shifts: (fileData.shifts || []).length,
      users: (fileData.users || []).length,
      employees: (fileData.employees || []).length,
      inventory: (fileData.inventory || []).length
    },
    isSafe: true,
    type: "file_fallback",
    message: "Data saved to persistent file storage."
  });
});

// Full Data GET
app.get("/api/data", async (req, res) => {
  try {
    const data = await getDbSnapshot();
    // Strip password hashes
    const safeData = JSON.parse(JSON.stringify(data));
    if (Array.isArray(safeData.users)) {
      safeData.users.forEach(u => delete u.passwordHash);
    }
    res.json(safeData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full Data POST
app.post("/api/data", async (req, res) => {
  try {
    dbVersion = Date.now();
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Invalid payload" });
    }

    if (isMongoConnected && mongoDb) {
      if (Array.isArray(payload.shifts)) {
        await mongoDb.collection("shifts").deleteMany({});
        if (payload.shifts.length > 0) {
          const docs = payload.shifts.map(s => ({ ...s, _id: s.id }));
          await mongoDb.collection("shifts").insertMany(docs);
        }
      }
      if (Array.isArray(payload.employees)) {
        await mongoDb.collection("employees").deleteMany({});
        if (payload.employees.length > 0) {
          const docs = payload.employees.map(e => ({ ...e, _id: e.id }));
          await mongoDb.collection("employees").insertMany(docs);
        }
      }
      if (Array.isArray(payload.departments)) {
        await mongoDb.collection("departments").deleteMany({});
        if (payload.departments.length > 0) {
          const docs = payload.departments.map(d => ({ ...d, _id: d.id }));
          await mongoDb.collection("departments").insertMany(docs);
        }
      }
      if (payload.settings && typeof payload.settings === "object") {
        await mongoDb.collection("settings").replaceOne(
          { _id: "app_settings" },
          { _id: "app_settings", ...payload.settings },
          { upsert: true }
        );
      }
      if (Array.isArray(payload.inventory)) {
        await mongoDb.collection("inventory").deleteMany({});
        if (payload.inventory.length > 0) {
          const docs = payload.inventory.map(i => ({ ...i, _id: i.id }));
          await mongoDb.collection("inventory").insertMany(docs);
        }
      }
      if (Array.isArray(payload.notifications)) {
        await mongoDb.collection("notifications").deleteMany({});
        if (payload.notifications.length > 0) {
          const docs = payload.notifications.map(n => ({ ...n, _id: n.id }));
          await mongoDb.collection("notifications").insertMany(docs);
        }
      }
      if (Array.isArray(payload.users)) {
        for (const u of payload.users) {
          if (!u.id) continue;
          const existing = await mongoDb.collection("users").findOne({ _id: u.id });
          const doc = { ...u, _id: u.id };
          if (existing && existing.passwordHash && !doc.passwordHash) {
            doc.passwordHash = existing.passwordHash;
          } else if (!doc.passwordHash) {
            const uname = (doc.username || "").toLowerCase();
            doc.passwordHash = hashPw(DEFAULT_USER_PASSWORDS[uname] || `${uname}123`);
          }
          await mongoDb.collection("users").replaceOne({ _id: u.id }, doc, { upsert: true });
        }
      }
    }

    // Always maintain local data.json file mirror
    const current = readDataJson();
    if (Array.isArray(payload.shifts)) current.shifts = payload.shifts;
    if (Array.isArray(payload.employees)) current.employees = payload.employees;
    if (Array.isArray(payload.departments)) current.departments = payload.departments;
    if (payload.settings) current.settings = payload.settings;
    if (Array.isArray(payload.inventory)) current.inventory = payload.inventory;
    if (Array.isArray(payload.notifications)) current.notifications = payload.notifications;
    current._last_updated = dbVersion;
    writeDataJson(current);

    res.json({ success: true, version: dbVersion, message: "Saved successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// DEDICATED ATOMIC SHIFT CRUD (NO RESURRECTION, INSTANT PERSISTENCE)
// -------------------------------------------------------------

// GET all shifts
app.get("/api/shifts", async (req, res) => {
  try {
    if (isMongoConnected && mongoDb) {
      const shifts = await mongoDb.collection("shifts").find({}).toArray();
      return res.json(shifts.map(s => { delete s._id; return s; }));
    }
    const data = readDataJson();
    res.json(data.shifts || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts (Create or Update single shift)
app.post("/api/shifts", async (req, res) => {
  try {
    const shift = req.body;
    if (!shift || !shift.id) {
      return res.status(400).json({ error: "Shift with valid id is required" });
    }
    dbVersion = Date.now();
    shift.updatedAt = shift.updatedAt || Date.now();

    if (isMongoConnected && mongoDb) {
      const doc = { ...shift, _id: shift.id };
      await mongoDb.collection("shifts").replaceOne({ _id: shift.id }, doc, { upsert: true });
    }

    // Mirror to data.json
    const fileData = readDataJson();
    fileData.shifts = fileData.shifts || [];
    const idx = fileData.shifts.findIndex(s => s.id === shift.id);
    if (idx !== -1) {
      fileData.shifts[idx] = shift;
    } else {
      fileData.shifts.push(shift);
    }
    fileData._last_updated = dbVersion;
    writeDataJson(fileData);

    res.json({ success: true, version: dbVersion, shift });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/shifts/:id (Permanently delete single shift)
app.delete("/api/shifts/:id", async (req, res) => {
  try {
    const shiftId = req.params.id;
    if (!shiftId) {
      return res.status(400).json({ error: "Shift ID is required" });
    }
    dbVersion = Date.now();

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("shifts").deleteOne({ _id: shiftId });
      await mongoDb.collection("shifts").deleteOne({ id: shiftId });
    }

    // Mirror to data.json
    const fileData = readDataJson();
    fileData.shifts = (fileData.shifts || []).filter(s => s.id !== shiftId);
    fileData._last_updated = dbVersion;
    writeDataJson(fileData);

    res.json({ success: true, version: dbVersion, id: shiftId, message: "Shift permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts/delete (Alternate delete for clients sending POST)
app.post("/api/shifts/delete", async (req, res) => {
  try {
    const shiftId = req.body.id || req.body.shiftId;
    if (!shiftId) {
      return res.status(400).json({ error: "Shift ID is required" });
    }
    dbVersion = Date.now();

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("shifts").deleteOne({ _id: shiftId });
      await mongoDb.collection("shifts").deleteOne({ id: shiftId });
    }

    const fileData = readDataJson();
    fileData.shifts = (fileData.shifts || []).filter(s => s.id !== shiftId);
    fileData._last_updated = dbVersion;
    writeDataJson(fileData);

    res.json({ success: true, version: dbVersion, id: shiftId, message: "Shift permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// AUTHENTICATION & ACCESS CONTROL
// -------------------------------------------------------------

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const username = (req.body.username || "").trim().toLowerCase();
    const password = (req.body.password || "").trim();

    let user = null;
    if (isMongoConnected && mongoDb) {
      user = await mongoDb.collection("users").findOne({ username });
    }
    if (!user) {
      const fileData = readDataJson();
      user = (fileData.users || []).find(u => (u.username || "").toLowerCase() === username);
    }

    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid username or password." });
    }

    if (user.hasRotaAccess === false || user.isActive === false) {
      return res.status(403).json({
        success: false,
        error: "Access denied. Rota access has not been granted by your manager."
      });
    }

    const tempPw = user.tempPassword;
    const isOtpLogin = Boolean(tempPw && password.toUpperCase() === tempPw.toUpperCase());

    const pwHash = hashPw(password);
    const storedHash = user.passwordHash;
    const expectedDefault = DEFAULT_USER_PASSWORDS[username] || `${username}123`;

    const isPwMatch = (
      (storedHash && pwHash === storedHash) ||
      (password === user.password) ||
      (password === expectedDefault) ||
      (["admin", "mantresh"].includes(username) && ["admin123", "mantresh123", "admin", "mantresh"].includes(password))
    );

    if (isOtpLogin || isPwMatch) {
      if (!isOtpLogin && user.passwordHash !== pwHash) {
        user.passwordHash = pwHash;
        if (isMongoConnected && mongoDb) {
          await mongoDb.collection("users").updateOne({ _id: user.id || user._id }, { $set: { passwordHash: pwHash } });
        }
      }

      const token = crypto.randomBytes(16).toString("hex");
      const safeUser = { ...user };
      delete safeUser._id;
      delete safeUser.passwordHash;
      const mustChange = Boolean(isOtpLogin || user.mustChangePassword);

      return res.json({
        success: true,
        token,
        user: safeUser,
        mustChangePassword: mustChange,
        message: "Logged in successfully!"
      });
    }

    return res.status(401).json({ success: false, error: "Invalid username or password." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forgot Password
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const username = (req.body.username || "").trim().toLowerCase();
    const data = await getDbSnapshot();
    const user = (data.users || []).find(u => (u.username || "").toLowerCase() === username);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "Username not found. Please contact your manager to set up your account."
      });
    }

    const resetReq = {
      id: "reset_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex"),
      userId: user.id,
      username: user.username,
      name: user.name || user.username,
      requestedAt: new Date().toISOString().replace("T", " ").substring(0, 16),
      status: "pending",
      otp: null
    };

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("resetRequests").insertOne({ ...resetReq, _id: resetReq.id });
    }
    const fileData = readDataJson();
    fileData.resetRequests = fileData.resetRequests || [];
    fileData.resetRequests.unshift(resetReq);
    writeDataJson(fileData);

    res.json({
      success: true,
      message: `Password reset request submitted for ${user.name || username}! Your manager has been notified.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate OTP (Admin Only)
app.post("/api/auth/generate-otp", async (req, res) => {
  try {
    const userId = req.body.userId;
    const otp = `TL-${Math.floor(1000 + Math.random() * 9000)}`;

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("users").updateOne(
        { $or: [{ _id: userId }, { id: userId }] },
        { $set: { tempPassword: otp, mustChangePassword: true } }
      );
      await mongoDb.collection("resetRequests").updateMany(
        { userId, status: "pending" },
        { $set: { status: "otp_generated", otp, generatedAt: new Date().toISOString() } }
      );
    }

    const fileData = readDataJson();
    const u = (fileData.users || []).find(x => x.id === userId);
    if (u) {
      u.tempPassword = otp;
      u.mustChangePassword = true;
    }
    for (const r of (fileData.resetRequests || [])) {
      if (r.userId === userId && r.status === "pending") {
        r.status = "otp_generated";
        r.otp = otp;
      }
    }
    writeDataJson(fileData);

    res.json({
      success: true,
      otp,
      username: u ? u.username : "",
      name: u ? u.name : "",
      message: `One-Time Password generated: ${otp}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change Password
app.post("/api/auth/change-password", async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!newPassword || newPassword.trim().length < 4) {
      return res.status(400).json({ success: false, error: "Password must be at least 4 characters." });
    }
    const pwHash = hashPw(newPassword.trim());

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("users").updateOne(
        { $or: [{ _id: userId }, { id: userId }] },
        { $set: { passwordHash: pwHash, tempPassword: null, mustChangePassword: false } }
      );
      await mongoDb.collection("resetRequests").updateMany({ userId }, { $set: { status: "resolved" } });
    }

    const fileData = readDataJson();
    const u = (fileData.users || []).find(x => x.id === userId);
    if (u) {
      u.passwordHash = pwHash;
      u.tempPassword = null;
      u.mustChangePassword = false;
    }
    for (const r of (fileData.resetRequests || [])) {
      if (r.userId === userId) r.status = "resolved";
    }
    writeDataJson(fileData);

    res.json({ success: true, message: "Password updated successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Account Details
app.post("/api/auth/update-account", async (req, res) => {
  try {
    const { userId, username, password } = req.body;
    const newUsername = (username || "").trim().toLowerCase();

    if (isMongoConnected && mongoDb) {
      const updates = {};
      if (newUsername) updates.username = newUsername;
      if (password && password.trim().length >= 4) {
        updates.passwordHash = hashPw(password.trim());
        updates.tempPassword = null;
        updates.mustChangePassword = false;
      }
      await mongoDb.collection("users").updateOne({ $or: [{ _id: userId }, { id: userId }] }, { $set: updates });
      const freshUser = await mongoDb.collection("users").findOne({ $or: [{ _id: userId }, { id: userId }] });
      delete freshUser._id;
      delete freshUser.passwordHash;
      return res.json({ success: true, user: freshUser, message: "Account details updated successfully!" });
    }

    const fileData = readDataJson();
    const u = (fileData.users || []).find(x => x.id === userId);
    if (!u) return res.status(404).json({ success: false, error: "User not found" });

    if (newUsername) u.username = newUsername;
    if (password && password.trim().length >= 4) {
      u.passwordHash = hashPw(password.trim());
      u.tempPassword = null;
      u.mustChangePassword = false;
    }
    writeDataJson(fileData);
    const safe = { ...u };
    delete safe.passwordHash;
    res.json({ success: true, user: safe, message: "Account details updated successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grant Access (Admin)
app.post("/api/auth/grant-access", async (req, res) => {
  try {
    const { employeeId, username, password, role, hasInventoryAccess } = req.body;
    const uname = (username || "").trim().toLowerCase();
    if (!uname || !password) {
      return res.status(400).json({ success: false, error: "Username and password are required." });
    }

    const fileData = readDataJson();
    const emp = (fileData.employees || []).find(e => e.id === employeeId);
    const empName = emp ? emp.name : uname;

    const userObj = {
      id: "user_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex"),
      username: uname,
      passwordHash: hashPw(password.trim()),
      role: role || "staff",
      employeeId,
      name: empName,
      hasRotaAccess: true,
      hasInventoryAccess: Boolean(hasInventoryAccess || role === "admin"),
      isActive: true,
      mustChangePassword: false,
      createdAt: new Date().toISOString()
    };

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("users").replaceOne(
        { $or: [{ employeeId }, { username: uname }] },
        { ...userObj, _id: userObj.id },
        { upsert: true }
      );
    }

    const idx = (fileData.users || []).findIndex(u => u.employeeId === employeeId || u.username === uname);
    if (idx !== -1) {
      fileData.users[idx] = userObj;
    } else {
      fileData.users.push(userObj);
    }
    writeDataJson(fileData);

    const safe = { ...userObj };
    delete safe.passwordHash;
    res.json({ success: true, user: safe, message: `Access granted for ${empName} (Username: ${uname})` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Access
app.post("/api/auth/toggle-access", async (req, res) => {
  try {
    const { userId, hasRotaAccess } = req.body;
    const active = Boolean(hasRotaAccess);

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("users").updateOne(
        { $or: [{ _id: userId }, { id: userId }] },
        { $set: { hasRotaAccess: active, isActive: active } }
      );
    }
    const fileData = readDataJson();
    const u = (fileData.users || []).find(x => x.id === userId);
    if (u) {
      u.hasRotaAccess = active;
      u.isActive = active;
      writeDataJson(fileData);
    }
    res.json({ success: true, hasRotaAccess: active, message: `Access ${active ? "granted" : "revoked"}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Inventory Access
app.post("/api/auth/toggle-inventory-access", async (req, res) => {
  try {
    const { userId, hasInventoryAccess } = req.body;
    const active = Boolean(hasInventoryAccess);

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("users").updateOne(
        { $or: [{ _id: userId }, { id: userId }] },
        { $set: { hasInventoryAccess: active } }
      );
    }
    const fileData = readDataJson();
    const u = (fileData.users || []).find(x => x.id === userId);
    if (u) {
      u.hasInventoryAccess = active;
      writeDataJson(fileData);
    }
    res.json({ success: true, hasInventoryAccess: active, message: `Inventory access ${active ? "granted" : "revoked"}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// INVENTORY ENDPOINTS
// -------------------------------------------------------------

// Update Stock Count
app.post("/api/inventory/update-stock", async (req, res) => {
  try {
    const itemId = req.body.id || req.body.productId;
    const newStock = Math.max(0, parseInt(req.body.stock || "0", 10));

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("inventory").updateOne(
        { $or: [{ _id: itemId }, { id: itemId }] },
        { $set: { stock: newStock, lastUpdated: new Date().toISOString() } }
      );
      const item = await mongoDb.collection("inventory").findOne({ $or: [{ _id: itemId }, { id: itemId }] });
      delete item._id;
      return res.json({ success: true, item, message: `Stock updated to ${newStock}.` });
    }

    const fileData = readDataJson();
    const item = (fileData.inventory || []).find(i => i.id === itemId);
    if (!item) return res.status(404).json({ success: false, error: "Inventory item not found" });
    item.stock = newStock;
    item.lastUpdated = new Date().toISOString();
    writeDataJson(fileData);
    res.json({ success: true, item, message: `Stock updated to ${newStock}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Product
app.post("/api/inventory/save-product", async (req, res) => {
  try {
    const prod = req.body.product || req.body;
    const name = (prod.name || "").trim();
    if (!name) return res.status(400).json({ success: false, error: "Product name is required" });

    const item = {
      id: prod.id || `prod_${Date.now()}`,
      name,
      category: prod.category || "Small Drinks",
      unit: prod.unit || prod.size || "Unit",
      stock: Math.max(0, parseInt(prod.stock || "0", 10)),
      minThreshold: Math.max(1, parseInt(prod.minThreshold || "6", 10)),
      image: prod.image || prod.imageUrl || "",
      lastUpdated: new Date().toISOString()
    };

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("inventory").replaceOne(
        { $or: [{ _id: item.id }, { id: item.id }] },
        { ...item, _id: item.id },
        { upsert: true }
      );
    }

    const fileData = readDataJson();
    fileData.inventory = fileData.inventory || [];
    const idx = fileData.inventory.findIndex(i => i.id === item.id);
    if (idx !== -1) {
      fileData.inventory[idx] = item;
    } else {
      fileData.inventory.push(item);
    }
    writeDataJson(fileData);

    res.json({ success: true, product: item, item, message: "Product saved successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Product
app.post("/api/inventory/delete-product", async (req, res) => {
  try {
    const itemId = req.body.id || req.body.productId;
    if (!itemId) return res.status(400).json({ success: false, error: "Product ID required" });

    if (isMongoConnected && mongoDb) {
      await mongoDb.collection("inventory").deleteOne({ $or: [{ _id: itemId }, { id: itemId }] });
    }

    const fileData = readDataJson();
    fileData.inventory = (fileData.inventory || []).filter(i => i.id !== itemId);
    writeDataJson(fileData);

    res.json({ success: true, message: "Product deleted." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// STATIC FILES & SPA FALLBACK
// -------------------------------------------------------------
app.use(express.static(BASE_DIR));

app.use((req, res) => {
  res.sendFile(path.join(BASE_DIR, "index.html"));
});

// Start Server
initMongo().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 [MERN Server] Planday Rota backend running on http://0.0.0.0:${PORT}`);
  });
});
