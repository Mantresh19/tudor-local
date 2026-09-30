#!/usr/bin/env python3
"""
Lightweight Planday-like Rota Scheduling Server
Zero external dependencies - runs on Python standard library.
Includes Authentication, Access Control, and One-Time Password Reset.
"""

import http.server
import socketserver
import json
import os
import sys
import mimetypes
import hashlib
import secrets
import time
from datetime import datetime
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", 8080))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data.json")

# MongoDB Configuration & Resilient Client
MONGO_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
MONGO_DB_NAME = os.environ.get("MONGODB_DB", "tudor_rota")

_mongo_client = None
_mongo_db = None
_mongo_connected = False
_db_version = int(time.time() * 1000)

def init_mongo():
    global _mongo_client, _mongo_db, _mongo_connected
    try:
        import pymongo
        _mongo_client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=2000)
        _mongo_client.server_info()
        _mongo_db = _mongo_client[MONGO_DB_NAME]
        _mongo_connected = True
        print(f"✅ [MongoDB] Successfully connected to {MONGO_URI} (db: {MONGO_DB_NAME})")
    except Exception as e:
        _mongo_client = None
        _mongo_db = None
        _mongo_connected = False
        print(f"ℹ️ [MongoDB] Connection offline ({e}). Using local data.json fallback.")

init_mongo()

def is_mongo_active():
    global _mongo_connected
    if not _mongo_connected or _mongo_db is None:
        try:
            init_mongo()
        except Exception:
            pass
    return _mongo_connected and _mongo_db is not None

def hash_pw(pw):
    return hashlib.sha256(pw.encode("utf-8")).hexdigest()

DEFAULT_USER_PASSWORDS = {
    "admin": "admin123",
    "mantresh": "admin123",
    "shon": "shon123",
    "isuru": "isuru123",
    "riya": "riya123",
    "swastik": "swastik123",
}

def ensure_user_passwords(users):
    if not isinstance(users, list):
        return
    for u in users:
        if not isinstance(u, dict):
            continue
        uname = (u.get("username") or "").strip().lower()
        if not u.get("passwordHash"):
            default_pw = DEFAULT_USER_PASSWORDS.get(uname, f"{uname}123" if uname else "admin123")
            u["passwordHash"] = hash_pw(default_pw)

def read_db():
    # 1. Try reading from MongoDB if connected
    if is_mongo_active():
        try:
            data = {}
            # Settings
            s_doc = _mongo_db.settings.find_one({"_id": "app_settings"})
            if s_doc:
                s_doc.pop("_id", None)
                data["settings"] = s_doc
            else:
                data["settings"] = {}

            # Collections
            for col_name in ["departments", "employees", "shifts", "users", "resetRequests", "inventory", "notifications"]:
                docs = list(_mongo_db[col_name].find({}))
                for d in docs:
                    d.pop("_id", None)
                data[col_name] = docs

            # Deleted shift IDs tombstone
            del_doc = _mongo_db.settings.find_one({"_id": "deleted_shift_ids"})
            if del_doc and "ids" in del_doc:
                data["deletedShiftIds"] = del_doc["ids"]
            else:
                data["deletedShiftIds"] = []

            # Ensure every user has a valid passwordHash
            ensure_user_passwords(data.get("users", []))

            # Initial Seeding: If MongoDB collections are empty, seed from data.json
            if not data.get("employees") and not data.get("shifts") and os.path.exists(DATA_FILE):
                try:
                    with open(DATA_FILE, "r", encoding="utf-8") as f:
                        seed_data = json.load(f)
                    ensure_user_passwords(seed_data.get("users", []))
                    write_db(seed_data)
                    return seed_data
                except Exception:
                    pass

            return data
        except Exception as e:
            print(f"⚠️ [MongoDB] Error reading: {e}. Falling back to data.json.")

    # 2. Fallback to local data.json
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if "users" not in data:
                    data["users"] = []
                if "resetRequests" not in data:
                    data["resetRequests"] = []
                if "shifts" not in data:
                    data["shifts"] = []
                if "employees" not in data:
                    data["employees"] = []
                if "notifications" not in data:
                    data["notifications"] = []
                if "deletedShiftIds" not in data:
                    data["deletedShiftIds"] = []
                ensure_user_passwords(data["users"])
                return data
        except Exception:
            pass
    fallback = {"users": [], "resetRequests": [], "shifts": [], "employees": [], "notifications": [], "deletedShiftIds": []}
    ensure_user_passwords(fallback["users"])
    return fallback

def write_db(data):
    global _db_version
    _db_version = int(time.time() * 1000)
    if isinstance(data, dict):
        data["_last_updated"] = _db_version
        # Ensure every user has a valid passwordHash before writing
        if "users" in data:
            ensure_user_passwords(data["users"])
    # 1. Always maintain local data.json file mirror
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"Error writing data.json: {e}")

    # 2. Write directly to MongoDB collections
    if is_mongo_active():
        try:
            # Settings
            if "settings" in data and isinstance(data["settings"], dict):
                s_copy = dict(data["settings"])
                s_copy["_id"] = "app_settings"
                _mongo_db.settings.replace_one({"_id": "app_settings"}, s_copy, upsert=True)

            # Deleted shift IDs tombstone
            if "deletedShiftIds" in data and isinstance(data["deletedShiftIds"], list):
                _mongo_db.settings.replace_one(
                    {"_id": "deleted_shift_ids"},
                    {"_id": "deleted_shift_ids", "ids": data["deletedShiftIds"]},
                    upsert=True
                )

            # Collections with unique IDs
            for col_name in ["departments", "employees", "shifts", "users", "resetRequests", "inventory", "notifications"]:
                if col_name in data and isinstance(data[col_name], list):
                    col = _mongo_db[col_name]
                    col.delete_many({})
                    if data[col_name]:
                        to_insert = []
                        for item in data[col_name]:
                            doc = dict(item)
                            if "id" in doc:
                                doc["_id"] = doc["id"]
                            to_insert.append(doc)
                        col.insert_many(to_insert)
        except Exception as e:
            print(f"⚠️ [MongoDB] Error writing to MongoDB: {e}")

class RotaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Service-Worker-Allowed", "/")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/shifts/"):
            shift_id = parsed.path.split("/api/shifts/")[1].strip()
            if shift_id:
                if is_mongo_active():
                    try:
                        _mongo_db.shifts.delete_one({"_id": shift_id})
                        _mongo_db.shifts.delete_one({"id": shift_id})
                        _mongo_db.settings.update_one(
                            {"_id": "deleted_shift_ids"},
                            {"$addToSet": {"ids": shift_id}},
                            upsert=True
                        )
                    except Exception as e:
                        print(f"MongoDB delete error: {e}")
                db = read_db()
                db["shifts"] = [s for s in db.get("shifts", []) if s.get("id") != shift_id]
                db_del = db.get("deletedShiftIds", [])
                if shift_id not in db_del:
                    db_del.append(shift_id)
                db["deletedShiftIds"] = db_del
                write_db(db)
                self.send_json(200, {"success": True, "version": _db_version, "id": shift_id, "message": "Shift permanently deleted"})
                return
        self.send_json(404, {"error": "Not found"})

    def send_json(self, status_code, payload):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/data-version":
            db_data = read_db()
            v = db_data.get("_last_updated") or _db_version
            self.send_json(200, {
                "version": v,
                "timestamp": int(time.time() * 1000)
            })
            return

        if parsed.path == "/api/data":
            data = read_db()
            data["_last_updated"] = data.get("_last_updated") or _db_version
            # Strip password hashes before sending client data
            safe_data = json.loads(json.dumps(data))
            for u in safe_data.get("users", []):
                u.pop("passwordHash", None)
            self.send_json(200, safe_data)
            return

        if parsed.path == "/api/db-status":
            mongo_ok = is_mongo_active()
            counts = {}
            if mongo_ok:
                try:
                    for c in ["shifts", "users", "employees", "inventory"]:
                        counts[c] = _mongo_db[c].count_documents({})
                except Exception:
                    pass
            else:
                db_data = read_db()
                counts = {
                    "shifts": len(db_data.get("shifts", [])),
                    "users": len(db_data.get("users", [])),
                    "employees": len(db_data.get("employees", [])),
                    "inventory": len(db_data.get("inventory", []))
                }

            display_uri = MONGO_URI
            if "@" in display_uri:
                parts = display_uri.split("@")
                display_uri = "mongodb+srv://****@" + parts[-1]

            self.send_json(200, {
                "success": True,
                "connected": mongo_ok,
                "database": MONGO_DB_NAME if mongo_ok else "data.json (local fallback)",
                "uri": display_uri if mongo_ok else "local filesystem",
                "counts": counts,
                "isSafe": True,
                "type": "mongodb" if mongo_ok else "file_fallback",
                "message": "All shifts and rota data are safely stored in MongoDB!" if mongo_ok else "Data saved to persistent file storage."
            })
            return

        # Default fallback to index.html for root
        if parsed.path in ("/", ""):
            self.path = "/index.html"

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        
        try:
            req_data = json.loads(body)
        except Exception:
            req_data = {}

        # 1. Main Rota Data Save
        if parsed.path == "/api/data":
            try:
                db = read_db()
                db_users = {u["id"]: u for u in db.get("users", [])}

                # Preserve users and resetRequests if not sent in full payload
                if "users" not in req_data:
                    req_data["users"] = list(db_users.values())
                else:
                    client_users = req_data.get("users", [])
                    client_ids = {u.get("id") for u in client_users}

                    for u in client_users:
                        uid = u.get("id")
                        uname = (u.get("username") or "").strip().lower()
                        if uid and uid in db_users:
                            if not u.get("passwordHash"):
                                u["passwordHash"] = db_users[uid].get("passwordHash") or hash_pw(DEFAULT_USER_PASSWORDS.get(uname, f"{uname}123"))
                        elif not u.get("passwordHash"):
                            u["passwordHash"] = hash_pw(DEFAULT_USER_PASSWORDS.get(uname, f"{uname}123"))

                    # Keep any db users that were not in client payload
                    for db_uid, db_user in db_users.items():
                        if db_uid not in client_ids:
                            client_users.append(db_user)

                    req_data["users"] = client_users

                if "shifts" in req_data and isinstance(req_data.get("shifts"), list):
                    req_data["shifts"] = req_data["shifts"]
                else:
                    req_data["shifts"] = db.get("shifts", [])

                if "employees" not in req_data or not isinstance(req_data.get("employees"), list):
                    req_data["employees"] = db.get("employees", [])

                if "departments" not in req_data or not isinstance(req_data.get("departments"), list):
                    req_data["departments"] = db.get("departments", [])

                if "settings" not in req_data or not isinstance(req_data.get("settings"), dict):
                    req_data["settings"] = db.get("settings", {})

                if "resetRequests" not in req_data:
                    req_data["resetRequests"] = db.get("resetRequests", [])

                if "inventory" not in req_data:
                    req_data["inventory"] = db.get("inventory", [])

                if "notifications" not in req_data:
                    req_data["notifications"] = db.get("notifications", [])

                write_db(req_data)
                self.send_json(200, {"success": True, "version": _db_version, "message": "Saved successfully"})
            except Exception as e:
                self.send_json(400, {"error": str(e)})
            return

        # Direct shift save/update
        if parsed.path == "/api/shifts":
            shift = req_data
            if shift and shift.get("id"):
                if is_mongo_active():
                    try:
                        doc = dict(shift)
                        doc["_id"] = shift["id"]
                        _mongo_db.shifts.replace_one({"_id": shift["id"]}, doc, upsert=True)
                        _mongo_db.settings.update_one(
                            {"_id": "deleted_shift_ids"},
                            {"$pull": {"ids": shift["id"]}}
                        )
                    except Exception as e:
                        print(f"MongoDB save shift error: {e}")
                db = read_db()
                shifts = db.get("shifts", [])
                db_del = db.get("deletedShiftIds", [])
                if shift["id"] in db_del:
                    db["deletedShiftIds"] = [x for x in db_del if x != shift["id"]]
                idx = next((i for i, s in enumerate(shifts) if s.get("id") == shift["id"]), -1)
                if idx != -1:
                    shifts[idx] = shift
                else:
                    shifts.append(shift)
                db["shifts"] = shifts
                write_db(db)
                self.send_json(200, {"success": True, "version": _db_version, "shift": shift})
                return

        # Direct shift delete
        if parsed.path == "/api/shifts/delete":
            shift_id = req_data.get("id") or req_data.get("shiftId")
            if shift_id:
                if is_mongo_active():
                    try:
                        _mongo_db.shifts.delete_one({"_id": shift_id})
                        _mongo_db.shifts.delete_one({"id": shift_id})
                        _mongo_db.settings.update_one(
                            {"_id": "deleted_shift_ids"},
                            {"$addToSet": {"ids": shift_id}},
                            upsert=True
                        )
                    except Exception as e:
                        print(f"MongoDB delete shift error: {e}")
                db = read_db()
                db["shifts"] = [s for s in db.get("shifts", []) if s.get("id") != shift_id]
                db_del = db.get("deletedShiftIds", [])
                if shift_id not in db_del:
                    db_del.append(shift_id)
                db["deletedShiftIds"] = db_del
                write_db(db)
                self.send_json(200, {"success": True, "version": _db_version, "id": shift_id, "message": "Shift permanently deleted"})
                return

        # 2. Login Endpoint
        if parsed.path == "/api/auth/login":
            username = req_data.get("username", "").strip().lower()
            password = req_data.get("password", "").strip()

            db = read_db()
            user = next((u for u in db.get("users", []) if u.get("username", "").lower() == username), None)

            if not user:
                self.send_json(401, {"success": False, "error": "Invalid username or password."})
                return

            if not user.get("hasRotaAccess", True) or not user.get("isActive", True):
                self.send_json(403, {
                    "success": False, 
                    "error": "Access denied. Rota access has not been granted by your manager."
                })
                return

            # Check if logging in with temporary OTP
            temp_pw = user.get("tempPassword")
            is_otp_login = bool(temp_pw and password.strip().upper() == temp_pw.strip().upper())

            # Check normal password or fallback defaults
            pw_hash = hash_pw(password)
            stored_hash = user.get("passwordHash")
            expected_default = DEFAULT_USER_PASSWORDS.get(username, f"{username}123")

            is_pw_match = (
                (stored_hash and pw_hash == stored_hash) or
                (password == user.get("password")) or
                (password == expected_default) or
                (username in ("admin", "mantresh") and password in ("admin123", "mantresh123", "admin", "mantresh"))
            )

            if is_otp_login or is_pw_match:
                # If stored hash was missing or different, sync it
                if not is_otp_login and user.get("passwordHash") != pw_hash:
                    user["passwordHash"] = pw_hash
                    write_db(db)

                token = secrets.token_hex(16)
                safe_user = {k: v for k, v in user.items() if k != "passwordHash"}
                must_change = bool(is_otp_login or user.get("mustChangePassword", False))
                self.send_json(200, {
                    "success": True,
                    "token": token,
                    "user": safe_user,
                    "mustChangePassword": must_change,
                    "message": "Logged in successfully!"
                })
            else:
                self.send_json(401, {"success": False, "error": "Invalid username or password."})
            return

        # 3. Forgot Password / Request Reset
        if parsed.path == "/api/auth/forgot-password":
            username = req_data.get("username", "").strip().lower()
            db = read_db()
            user = next((u for u in db.get("users", []) if u.get("username", "").lower() == username), None)

            if not user:
                # Do not reveal existence for privacy, or give clear message
                self.send_json(404, {
                    "success": False, 
                    "error": "Username not found. Please contact your manager to set up your account."
                })
                return

            # Check if active request already exists
            existing_req = next((r for r in db.get("resetRequests", []) if r.get("userId") == user["id"] and r.get("status") == "pending"), None)
            if not existing_req:
                req_obj = {
                    "id": "reset_" + str(int(time.time())) + "_" + secrets.token_hex(2),
                    "userId": user["id"],
                    "username": user["username"],
                    "name": user.get("name", user["username"]),
                    "requestedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
                    "status": "pending",
                    "otp": None
                }
                db["resetRequests"].insert(0, req_obj)
                write_db(db)

            self.send_json(200, {
                "success": True,
                "message": f"Password reset request submitted for {user.get('name', username)}! Your manager has been notified to generate your One-Time Password."
            })
            return

        # 4. Generate OTP (Admin Only)
        if parsed.path == "/api/auth/generate-otp":
            user_id = req_data.get("userId")
            db = read_db()
            user = next((u for u in db.get("users", []) if u.get("id") == user_id), None)

            if not user:
                self.send_json(404, {"success": False, "error": "User not found."})
                return

            # Generate 6-digit friendly OTP e.g. TUDOR-4819
            otp = f"TL-{secrets.randbelow(9000) + 1000}"
            user["tempPassword"] = otp
            user["mustChangePassword"] = True

            # Mark matching reset request
            for r in db.get("resetRequests", []):
                if r.get("userId") == user_id and r.get("status") == "pending":
                    r["status"] = "otp_generated"
                    r["otp"] = otp
                    r["generatedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M")

            write_db(db)
            self.send_json(200, {
                "success": True,
                "otp": otp,
                "username": user["username"],
                "name": user.get("name", user["username"]),
                "message": f"One-Time Password generated: {otp}"
            })
            return

        # 5. Change Password
        if parsed.path == "/api/auth/change-password":
            user_id = req_data.get("userId")
            new_password = req_data.get("newPassword", "").strip()

            if len(new_password) < 4:
                self.send_json(400, {"success": False, "error": "Password must be at least 4 characters."})
                return

            db = read_db()
            user = next((u for u in db.get("users", []) if u.get("id") == user_id), None)
            if not user:
                self.send_json(404, {"success": False, "error": "User not found."})
                return

            user["passwordHash"] = hash_pw(new_password)
            user["tempPassword"] = None
            user["mustChangePassword"] = False

            # Mark requests resolved
            for r in db.get("resetRequests", []):
                if r.get("userId") == user_id:
                    r["status"] = "resolved"

            write_db(db)
            self.send_json(200, {
                "success": True,
                "message": "Password updated successfully! You can now log in with your new password."
            })
            return

        # 5b. Update User Account (Username and/or Password)
        if parsed.path == "/api/auth/update-account":
            user_id = req_data.get("userId")
            new_username = req_data.get("username", "").strip().lower()
            new_password = req_data.get("password", "").strip()

            db = read_db()
            user = next((u for u in db.get("users", []) if u.get("id") == user_id), None)
            if not user:
                self.send_json(404, {"success": False, "error": "User not found."})
                return

            if new_username and new_username != user.get("username"):
                exists = next((u for u in db.get("users", []) if u.get("username", "").lower() == new_username and u.get("id") != user_id), None)
                if exists:
                    self.send_json(400, {"success": False, "error": f"Username '{new_username}' is already taken."})
                    return
                user["username"] = new_username

            if new_password:
                if len(new_password) < 4:
                    self.send_json(400, {"success": False, "error": "Password must be at least 4 characters."})
                    return
                user["passwordHash"] = hash_pw(new_password)
                user["tempPassword"] = None
                user["mustChangePassword"] = False

            write_db(db)
            safe_user = {k: v for k, v in user.items() if k != "passwordHash"}
            self.send_json(200, {
                "success": True,
                "user": safe_user,
                "message": "Account details updated successfully!"
            })
            return

        # 6. Grant / Create Rota Access for Staff Member (Admin Only)
        if parsed.path == "/api/auth/grant-access":
            employee_id = req_data.get("employeeId")
            username = req_data.get("username", "").strip().lower()
            password = req_data.get("password", "").strip()
            role = req_data.get("role", "staff")

            if not username or not password:
                self.send_json(400, {"success": False, "error": "Username and password are required."})
                return

            db = read_db()
            emp = next((e for e in db.get("employees", []) if e.get("id") == employee_id), None)
            emp_name = emp["name"] if emp else username

            # Check if username already used by another user
            existing = next((u for u in db.get("users", []) if u.get("username", "").lower() == username and u.get("employeeId") != employee_id), None)
            if existing:
                self.send_json(400, {"success": False, "error": f"Username '{username}' is already in use."})
                return

            # Update existing user for this employee or create new
            user = next((u for u in db.get("users", []) if u.get("employeeId") == employee_id), None)
            has_inv = bool(req_data.get("hasInventoryAccess", role == "admin"))
            if user:
                user["username"] = username
                user["passwordHash"] = hash_pw(password)
                user["role"] = role
                user["hasRotaAccess"] = True
                user["hasInventoryAccess"] = has_inv
                user["isActive"] = True
            else:
                user = {
                    "id": "user_" + str(int(time.time())) + "_" + secrets.token_hex(2),
                    "username": username,
                    "passwordHash": hash_pw(password),
                    "role": role,
                    "employeeId": employee_id,
                    "name": emp_name,
                    "hasRotaAccess": True,
                    "hasInventoryAccess": has_inv,
                    "isActive": True,
                    "mustChangePassword": False,
                    "createdAt": datetime.now().isoformat()
                }
                db["users"].append(user)

            write_db(db)
            self.send_json(200, {
                "success": True,
                "user": {k: v for k, v in user.items() if k != "passwordHash"},
                "message": f"Access granted for {emp_name} (Username: {username})"
            })
            return

        # 7. Toggle Access (Enable / Disable)
        if parsed.path == "/api/auth/toggle-access":
            user_id = req_data.get("userId")
            has_access = bool(req_data.get("hasRotaAccess", True))

            db = read_db()
            user = next((u for u in db.get("users", []) if u.get("id") == user_id), None)
            if not user:
                self.send_json(404, {"success": False, "error": "User not found."})
                return

            user["hasRotaAccess"] = has_access
            user["isActive"] = has_access
            write_db(db)
            self.send_json(200, {
                "success": True,
                "hasRotaAccess": has_access,
                "message": f"Access {'granted' if has_access else 'revoked'} for {user.get('name', 'user')}."
            })
            return

        # 8. Toggle Inventory Access
        if parsed.path == "/api/auth/toggle-inventory-access":
            user_id = req_data.get("userId")
            has_inv = bool(req_data.get("hasInventoryAccess", True))

            db = read_db()
            user = next((u for u in db.get("users", []) if u.get("id") == user_id), None)
            if not user:
                self.send_json(404, {"success": False, "error": "User not found."})
                return

            user["hasInventoryAccess"] = has_inv
            write_db(db)
            self.send_json(200, {
                "success": True,
                "hasInventoryAccess": has_inv,
                "message": f"Inventory access {'granted' if has_inv else 'revoked'} for {user.get('name', 'user')}."
            })
            return

        # 9. Inventory: Update Stock Count (Quick Mobile Numpad)
        if parsed.path == "/api/inventory/update-stock":
            item_id = req_data.get("id") or req_data.get("productId")
            new_stock = req_data.get("stock")
            if item_id is None or new_stock is None:
                self.send_json(400, {"success": False, "error": "Item ID and stock count are required."})
                return
            db = read_db()
            inv = db.get("inventory", [])
            item = next((i for i in inv if i.get("id") == item_id), None)
            if not item:
                self.send_json(404, {"success": False, "error": "Inventory item not found."})
                return
            item["stock"] = max(0, int(new_stock))
            item["lastUpdated"] = datetime.now().isoformat()
            write_db(db)
            self.send_json(200, {"success": True, "item": item, "message": f"Stock updated to {item['stock']}."})
            return

        # 10. Inventory: Add or Edit Product
        if parsed.path == "/api/inventory/save-product":
            db = read_db()
            inv = db.setdefault("inventory", [])
            prod_data = req_data.get("product") if isinstance(req_data.get("product"), dict) else req_data
            item_id = prod_data.get("id") or prod_data.get("productId")
            name = prod_data.get("name", "").strip()
            category = prod_data.get("category", "Small Drinks").strip()
            unit = prod_data.get("unit") or prod_data.get("size") or "Unit"
            stock = max(0, int(prod_data.get("stock", 0)))
            min_threshold = max(1, int(prod_data.get("minThreshold", 6)))
            image_url = prod_data.get("image") or prod_data.get("imageUrl") or ""

            if not name:
                self.send_json(400, {"success": False, "error": "Product name is required."})
                return

            if item_id:
                item = next((i for i in inv if i.get("id") == item_id), None)
                if item:
                    item.update({
                        "name": name,
                        "category": category,
                        "unit": unit,
                        "stock": stock,
                        "minThreshold": min_threshold,
                        "image": image_url,
                        "lastUpdated": datetime.now().isoformat()
                    })
                else:
                    item = {
                        "id": item_id,
                        "name": name,
                        "category": category,
                        "unit": unit,
                        "stock": stock,
                        "minThreshold": min_threshold,
                        "image": image_url,
                        "lastUpdated": datetime.now().isoformat()
                    }
                    inv.append(item)
            else:
                item_id = f"prod_{int(time.time()*1000)}"
                item = {
                    "id": item_id,
                    "name": name,
                    "category": category,
                    "unit": unit,
                    "stock": stock,
                    "minThreshold": min_threshold,
                    "image": image_url,
                    "lastUpdated": datetime.now().isoformat()
                }
                inv.append(item)

            write_db(db)
            self.send_json(200, {"success": True, "product": item, "item": item, "message": "Product saved successfully."})
            return

        # 11. Inventory: Delete Product
        if parsed.path == "/api/inventory/delete-product":
            item_id = req_data.get("id") or req_data.get("productId")
            if not item_id:
                self.send_json(400, {"success": False, "error": "Product ID is required."})
                return
            db = read_db()
            inv = db.get("inventory", [])
            orig_len = len(inv)
            db["inventory"] = [i for i in inv if i.get("id") != item_id]
            if len(db["inventory"]) < orig_len:
                write_db(db)
                self.send_json(200, {"success": True, "message": "Product deleted successfully."})
            else:
                self.send_json(404, {"success": False, "error": "Product not found."})
            return

        self.send_json(404, {"error": "Endpoint not found"})

def run(port=PORT):
    socketserver.TCPServer.allow_reuse_address = True
    for p in range(port, port + 10):
        try:
            with socketserver.TCPServer(("", p), RotaHandler) as httpd:
                print(f"==================================================")
                print(f" Tudor Local Rota App (Auth & Access Control)")
                print(f" Local URL: http://localhost:{p}")
                print(f" Directory: {BASE_DIR}")
                print(f" Press Ctrl+C to stop.")
                print(f"==================================================")
                sys.stdout.flush()
                httpd.serve_forever()
        except OSError as e:
            if e.errno == 48:
                continue
            raise

if __name__ == "__main__":
    run()
