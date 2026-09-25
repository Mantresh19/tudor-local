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

def hash_pw(pw):
    return hashlib.sha256(pw.encode("utf-8")).hexdigest()

def read_db():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if "users" not in data:
                    data["users"] = []
                if "resetRequests" not in data:
                    data["resetRequests"] = []
                return data
        except Exception:
            pass
    return {"users": [], "resetRequests": [], "shifts": [], "employees": []}

def write_db(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

class RotaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Service-Worker-Allowed", "/")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, status_code, payload):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/data":
            data = read_db()
            # Strip password hashes before sending client data
            safe_data = json.loads(json.dumps(data))
            for u in safe_data.get("users", []):
                u.pop("passwordHash", None)
            self.send_json(200, safe_data)
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
                # Preserve users and resetRequests if not sent in full payload
                if "users" not in req_data:
                    req_data["users"] = db.get("users", [])
                else:
                    # Restore password hashes from db if client sent stripped users
                    existing_hashes = {u["id"]: u.get("passwordHash") for u in db.get("users", [])}
                    for u in req_data["users"]:
                        if not u.get("passwordHash") and u.get("id") in existing_hashes:
                            u["passwordHash"] = existing_hashes[u["id"]]

                if "resetRequests" not in req_data:
                    req_data["resetRequests"] = db.get("resetRequests", [])

                write_db(req_data)
                self.send_json(200, {"success": True, "message": "Saved successfully"})
            except Exception as e:
                self.send_json(400, {"error": str(e)})
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
            is_otp_login = temp_pw and password == temp_pw

            # Check normal password
            pw_hash = hash_pw(password)
            is_pw_match = pw_hash == user.get("passwordHash") or password == user.get("password")

            if is_otp_login or is_pw_match:
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
            if user:
                user["username"] = username
                user["passwordHash"] = hash_pw(password)
                user["role"] = role
                user["hasRotaAccess"] = True
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
                    "isActive": True,
                    "mustChangePassword": False,
                    "createdAt": datetime.now().isoformat()
                }
                db["users"].append(user)

            write_db(db)
            self.send_json(200, {
                "success": True,
                "user": {k: v for k, v in user.items() if k != "passwordHash"},
                "message": f"Rota access granted for {emp_name} (Username: {username})"
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
