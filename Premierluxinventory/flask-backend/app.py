import eventlet
eventlet.monkey_patch()

from flask import Flask, request, jsonify, session, render_template, redirect
from flask_cors import CORS
from pymongo import MongoClient
import os
import json
import numpy as np
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from datetime import datetime, timezone, timedelta
from flask_socketio import SocketIO
from groq import Groq
import threading
import time
import uuid
import string
import random

# ---------- Flask + CORS Setup ----------

# WE TELL FLASK TO LOOK UP ONE FOLDER (../frontend) FOR TEMPLATES
app = Flask(__name__)

CORS(app, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*")
app.secret_key = "premierlux_secret_key"

# ---------- MongoDB setup ----------
MONGO_URI = os.environ.get("MONGO_URI", "mongodb+srv://dbirolliverhernandez_db_user:yqHWCWJwNxKofjHs@cluster0.bgmzgav.mongodb.net/?appName=Cluster0")
client = MongoClient(MONGO_URI)
db = client["premierlux"]
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "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")

ai_dashboard_collection = db["ai_dashboard"]
inventory_collection = db["inventory"]
branches_collection = db["branches"]
batches_collection = db["batches"]
consumption_collection = db["consumption"]
suppliers_collection = db["suppliers"]
orders_collection = db["orders"]
users_collection = db["users"]
audit_collection = db["audit_logs"]
settings_collection = db["settings"]


# ---------- USER SETUP (Auto-Fix) ----------

# 1. Create Default Owner if database is empty
if users_collection.count_documents({}) == 0:
    users_collection.insert_one({
        "name": "System Owner",
        "email": "owner@example.com",
        "password": "owner123",
        "role": "owner",
        "branch": "All",
        "created_at": datetime.now()
    })

# 2. AUTO-FIX: Promote existing "Super Admin" to Owner
# This fixes the issue where your old account is stuck as "Admin"
existing_admin = users_collection.find_one({"email": "admin@example.com"})
if existing_admin and existing_admin.get("role") != "owner":
    print("Promoting Super Admin to Owner...")
    users_collection.update_one(
        {"email": "admin@example.com"},
        {"$set": {"role": "owner", "branch": "All"}}
    )


# GET CURRENT USER INFO
@app.route("/api/me", methods=["GET"])
def get_current_user():
    if "user_email" not in session:
        return jsonify({"error": "Not logged in"}), 401
    
    return jsonify({
        "name": session.get("user_name"),
        "email": session.get("user_email"),
        "role": session.get("role"),
        "branch": session.get("branch")
    })
# ---------- PAGE ROUTES (Serving HTML) ----------

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.json or {}
    email = data.get("email")
    password = data.get("password")

    # 1. Fetch User
    user = users_collection.find_one({"email": email})
    
    if not user or user.get("password") != password:
        return jsonify({"error": "Invalid email or password"}), 401

    # 2. CHECK SYSTEM LOCKDOWN (New Logic)
    # Check if a lockdown setting exists and is True
    setting = settings_collection.find_one({"_id": "global_config"})
    is_locked = setting.get("lockdown", False) if setting else False

    # If Locked, ONLY Owner can enter
    if is_locked and user.get("role") != "owner":
        return jsonify({"error": "System is under MAINTENANCE. Owner access only."}), 403

    # 3. Success - Set Session
    session.permanent = True
    session["user_email"] = user["email"]
    session["user_name"] = user.get("name", "User")
    session["role"] = user.get("role", "staff")
    session["branch"] = user.get("branch", "Main")
    
    log_behavior(user["email"], "Login", "User logged into the system")
    
    return jsonify({
        "message": "Login successful",
        "role": user.get("role"),
        "name": user.get("name"),
        "branch": user.get("branch")
    }), 200
# 2. Protected Dashboard (Home)
@app.route("/")
def home():
    # If NOT logged in, kick them to login page
    if "user_email" not in session:
        return redirect("/login")
    
    # If logged in, show the dashboard
    return render_template("index.html")

# Serve the Login Page (HTML)
@app.route("/login")
def login_page():
    return render_template("login.html")


# ---------- USER MANAGEMENT & LOGGING ----------

# Helper Function: Behavioral Logging
def log_behavior(user_email, action, details):
    audit_collection.insert_one({
        "user": user_email,
        "action": action,
        "details": details,
        "timestamp": datetime.now()
    })

# ✅ FIXED: Allows both Owner and Admin
@app.route("/api/users", methods=["GET"])
def get_users():
    current_role = session.get("role")
    
    # Allow if role is Owner OR Admin
    if current_role not in ["owner", "admin"]:
        return jsonify({"error": "Unauthorized"}), 403

    users = list(users_collection.find({}, {"password": 0})) 
    for u in users:
        u["_id"] = str(u["_id"])
    return jsonify(users), 200

@app.route("/api/users", methods=["POST"])
def create_user():
    # Allow Owner and Admin to create users
    if session.get("role") not in ["owner", "admin"]:
        return jsonify({"error": "Unauthorized"}), 403

    data = request.json or {}
    if not data.get("email") or not data.get("password"):
        return jsonify({"error": "Email and Password required"}), 400
    
    if users_collection.find_one({"email": data["email"]}):
        return jsonify({"error": "Email already exists"}), 400

    new_user = {
        "name": data.get("name", "New User"),
        "email": data["email"],
        "password": data["password"],
        "role": data.get("role", "staff"),
        "branch": data.get("branch", "Main"), # <--- NEW FIELD
        "created_at": datetime.now()
    }
    
    users_collection.insert_one(new_user)
    log_behavior(session.get("user_email"), "Create User", f"Created {data['role']} for {data.get('branch')}")
    
    return jsonify({"message": "User created"}), 201

@app.route("/api/users/<user_id>", methods=["DELETE"])
def delete_user(user_id):
    current_role = session.get("role")
    
    # 1. Security Check: Only Owner and Admin can access delete functions
    if current_role not in ["owner", "admin"]:
        return jsonify({"error": "Unauthorized"}), 403

    from bson.objectid import ObjectId
    target_user = users_collection.find_one({"_id": ObjectId(user_id)})
    
    if not target_user:
        return jsonify({"error": "User not found"}), 404

    target_role = target_user.get("role")

    # 2. Hierarchy Rules
    # Rule A: No one can delete the Owner
    if target_role == "owner":
        return jsonify({"error": "Cannot delete the System Owner"}), 403
    
    # Rule B: Admins CANNOT delete other Admins (Only Owner can)
    if current_role == "admin" and target_role == "admin":
        return jsonify({"error": "Only the Owner can delete Administrators"}), 403

    # Rule C: Admins can only delete Staff
    if current_role == "admin" and target_role != "staff":
        return jsonify({"error": "Admins can only delete Staff accounts"}), 403

    # If we pass all checks, proceed
    users_collection.delete_one({"_id": ObjectId(user_id)})
    
    log_behavior(session.get("user_email"), "Delete User", f"Deleted user {target_user.get('email')}")
    return jsonify({"message": "User deleted"}), 200
# ---------- INVENTORY CRUD + QUERIES ----------

@app.route("/api/inventory", methods=["GET"])
def get_inventory():
    items = list(inventory_collection.find({}, {"_id": 0}))
    return jsonify(items)

@app.route("/api/inventory", methods=["POST"])
def add_inventory():
    data = request.json or {}
    data["created_at"] = datetime.now() 
    inventory_collection.insert_one(data)
    return jsonify({"message": "Item added"}), 201

@app.route("/api/inventory/<string:item_name>", methods=["DELETE"])
def delete_inventory(item_name):
    inventory_collection.delete_one({"name": item_name})
    batches_collection.delete_many({"item_name": item_name})
    
    return jsonify({"message": "Item and associated batches deleted"})

@app.route("/api/inventory/branch/<string:branch_name>", methods=["GET"])
def get_inventory_by_branch(branch_name):
    items = list(inventory_collection.find({"branch": branch_name}, {"_id": 0}))
    return jsonify(items)

@app.route("/api/inventory/lowstock", methods=["GET"])
def get_low_stock():
    items = list(
        inventory_collection.find(
            {"$expr": {"$lte": ["$quantity", "$reorder_level"]}},
            {"_id": 0},
        )
    )
    return jsonify(items)

@app.route("/api/inventory/<name>/adjust", methods=["POST"])
def adjust_inventory(name):
    data = request.json or {}
    branch = data.get("branch")
    delta = int(data.get("delta", 0))
    # NEW: Get the category (default to 'Manual Adjustment' if missing)
    reason_cat = data.get("reason_category", "Manual Adjustment") 
    note = data.get("note", "")

    if delta == 0:
        return jsonify({"error": "non-zero delta required"}), 400

    query = {"name": name}
    if branch:
        query["branch"] = branch

    inv = inventory_collection.find_one(query)
    if not inv:
        return jsonify({"error": "item not found"}), 404

    new_qty = max(0, int(inv.get("quantity", 0)) + delta)
    inventory_collection.update_one(
        {"_id": inv["_id"]},
        {"$set": {"quantity": new_qty}},
    )

    # SAVE TO LOGS
    consumption_collection.insert_one({
        "name": name,
        "date": datetime.utcnow(),
        "quantity_used": abs(delta),
        "direction": "out" if delta < 0 else "in",
        "branch": branch or inv.get("branch"),
        "reason_category": reason_cat,  # <--- SAVING IT HERE
        "note": note
    })

    return jsonify({"status": "ok", "quantity": new_qty})

# ---------- BATCHES ----------
@app.route("/api/batches", methods=["GET"])
def get_batches():
    # Fetch all fields. Convert _id to string for JSON compatibility.
    batches = list(batches_collection.find({}))
    for b in batches:
        b['_id'] = str(b['_id']) # Convert ObjectId to string
    return jsonify(batches), 200

@app.route("/api/batches", methods=["POST"])
def create_batch():
    data = request.get_json(force=True)

    if not data or "item_name" not in data or "branch" not in data:
        return jsonify({"error": "item_name and branch are required"}), 400

    # --- AUTOMATION LOGIC START ---
    
    # 1. Auto-Generate Batch # (Format: BATCH-YYYYMMDD-XXXX)
    # If user provided one, use it. Otherwise, generate it.
    auto_batch = data.get("batch_number")
    if not auto_batch:
        date_str = datetime.now().strftime("%Y%m%d")
        suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
        auto_batch = f"BTN-{date_str}-{suffix}"

    # 2. Auto-Generate Lot # (Format: LOT-YYYYMMDD)
    auto_lot = data.get("lot_number")
    if not auto_lot:
        auto_lot = f"LOT-{datetime.now().strftime('%Y%m%d')}"

    # 3. Auto-Generate Supplier Batch (Placeholder if empty)
    auto_supp = data.get("supplier_batch")
    if not auto_supp:
        auto_supp = "SUP-NA-" + datetime.now().strftime("%H%M") # e.g. SUP-NA-1430

    # 4. Auto-Generate QR ID (Unique UUID)
    auto_qr = data.get("qr_code_id")
    if not auto_qr:
        auto_qr = str(uuid.uuid4())[:8].upper() # Short unique ID e.g. A1B2C3D4

    # --- AUTOMATION LOGIC END ---

    batch_doc = {
        "item_name": data.get("item_name"),
        "sku": data.get("sku"),
        "branch": data.get("branch"),
        "current_stock": data.get("current_stock", 0),
        "monthly_usage": data.get("monthly_usage", 0),
        "price": data.get("price", 0),
        "reorder_level": data.get("reorder_level", 0),
        
        # USE AUTO VALUES HERE
        "batch_number": auto_batch,
        "lot_number": auto_lot,
        "supplier_batch": auto_supp,
        "qr_code_id": auto_qr,
        
        "mfg_date": data.get("mfg_date") or None,
        "exp_date": data.get("exp_date") or None,
        "category": data.get("category") or "Uncategorized",
    }

    result = batches_collection.insert_one(batch_doc)
    batch_doc["_id"] = str(result.inserted_id)

 # Update main inventory count AND save latest batch info
    inventory_collection.update_one(
        {"name": batch_doc["item_name"], "branch": batch_doc["branch"]},
        {
            "$setOnInsert": {
                "reorder_level": batch_doc["reorder_level"],
                "price": batch_doc["price"],
                "created_at": datetime.now()
            },
            "$set": { 
                "category": batch_doc["category"],
                "monthly_usage": batch_doc["monthly_usage"], # ➤ ADDED THIS LINE
                "batch_number": batch_doc["batch_number"],
                "lot_number": batch_doc["lot_number"],
                "supplier_batch": batch_doc["supplier_batch"],
                "qr_code_id": batch_doc["qr_code_id"],
                "mfg_date": batch_doc["mfg_date"],
                "exp_date": batch_doc["exp_date"]
            },
            "$inc": { "quantity": batch_doc["current_stock"] },
        },
        upsert=True,
    )

    return jsonify({"status": "ok", "batch": batch_doc}), 201
# ---------- AI: SIMPLE FORECASTING ----------

@app.route("/api/forecast/<item_name>", methods=["GET"])
def forecast_item(item_name):
    try:
        history = list(
            consumption_collection.find(
                {"name": item_name},
                {"_id": 0, "date": 1, "quantity_used": 1},
            )
        )

        if not history:
            return jsonify(
                {
                    "item": item_name,
                    "message": "No consumption history found for this item.",
                    "forecast": [],
                }
            ), 200

        history_sorted = sorted(
            history,
            key=lambda x: datetime.strptime(x["date"], "%Y-%m-%d"),
        )
        y = np.array([h["quantity_used"] for h in history_sorted], dtype=float)

        if len(y) < 3:
            avg = float(np.mean(y))
            forecast_values = [avg] * 7
        else:
            model = ExponentialSmoothing(y, trend=None, seasonal=None)
            model_fit = model.fit(optimized=True)
            forecast_values = model_fit.forecast(7).tolist()

        return jsonify(
            {
                "item": item_name,
                "history_points": len(y),
                "forecast_horizon_days": 7,
                "daily_forecast": forecast_values,
            }
        ), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ---------- AI DASHBOARD ----------

@app.route("/api/ai/dashboard", methods=["GET"])
def get_ai_dashboard():
    doc = ai_dashboard_collection.find_one({"_id": "summary"}) or {}
    if doc:
        doc["updated_at"] = doc.get("updated_at")
    return jsonify({
        "summary_text": doc.get("summary_text", ""),
        "risk_text": doc.get("risk_text", ""),
        "updated_at": doc.get("updated_at"),
    }), 200


# ==========================================
# 🤖 LUX CHATBOT (Powered by Groq Llama 3)
# ==========================================

@app.route("/api/chat", methods=["POST"])
def chat():
    try:
        # 1. SETUP GROQ CLIENT
        # Paste your Groq API Key here
        GROQ_API_KEY = "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"
        client = Groq(api_key=GROQ_API_KEY)

        data = request.json or {}
        user_message = data.get("message", "").strip()
        image_data = data.get("image") # Base64 string

        # 2. GATHER SYSTEM CONTEXT (Inventory Data)
        try:
            # Get a quick snapshot of the inventory to guide the AI
            total_items = inventory_collection.count_documents({})
            low_stock = list(inventory_collection.find(
                {"$expr": {"$lte": ["$quantity", "$reorder_level"]}},
                {"_id": 0, "name": 1, "quantity": 1, "branch": 1}
            ))
            
            # Limit context size to prevent errors
            inventory_summary = f"Total Items: {total_items}. Low Stock Items: {json.dumps(low_stock[:20])}"
        except Exception:
            inventory_summary = "Inventory data currently unavailable."

        # 3. DEFINE SYSTEM PROMPT
        system_prompt = f"""
        You are LUX, the AI assistant for PremierLux Dental.
        Your Tone: Professional, concise, and helpful.
        
        Current Inventory Status:
        {inventory_summary}
        
        Rules:
        - If the user asks about stock, check the 'Low Stock Items' list above first.
        - If an image is provided, analyze it (e.g., identify dental tools, read expiration dates).
        - Keep answers short (under 3 sentences) unless asked for details.
        """

        # 4. PREPARE MESSAGE FOR GROQ
        messages = [
            {"role": "system", "content": system_prompt}
        ]

        # 5. HANDLE IMAGE VS TEXT ONLY
        if image_data:
            # CLEAN IMAGE DATA
            if "base64," in image_data:
                image_data = image_data.split("base64,")[1]
                
            # Groq Vision Format
            image_url = f"data:image/jpeg;base64,{image_data}"
            
            messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": user_message or "Analyze this image."},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]
            })
            
            # Use Vision Model
            model_to_use = "llama-3.2-11b-vision-preview"
        
        else:
            # Text Only
            messages.append({
                "role": "user", 
                "content": user_message
            })
            
            # Use Text Model
            model_to_use = "llama-3.3-70b-versatile"

        # 6. CALL GROQ API
        completion = client.chat.completions.create(
            model=model_to_use,
            messages=messages,
            temperature=0.5,
            max_tokens=500
        )

        answer = completion.choices[0].message.content

        return jsonify({
            "type": "llm_answer", 
            "text": answer
        }), 200

    except Exception as e:
        print(f"LUX Error: {e}")
        return jsonify({
            "type": "error", 
            "text": "⚠️ I'm currently offline or check your API Key."
        }), 500
# ---------- BRANCHES ----------

# ---------- BRANCHES (FIXED) ----------

from bson.objectid import ObjectId # Ensure this is at the top of app.py

@app.route("/api/branches", methods=["GET"])
def get_branches():
    # ➤ FIX: Do NOT hide _id. We need it to edit and delete.
    branches = list(branches_collection.find({}))
    for b in branches:
        b["_id"] = str(b["_id"]) # Convert MongoDB ID to string for JS
    return jsonify(branches)

@app.route("/api/branches", methods=["POST"])
def add_branch():
    data = request.json or {}
    if not data.get("name"):
        return jsonify({"error": "Branch name is required"}), 400

    doc = {
        "name": data["name"],
        "address": data.get("address", ""),
        "manager": data.get("manager", ""),
        "phone": data.get("phone", "") # Added phone field
    }
    branches_collection.insert_one(doc)
    return jsonify({"message": "Branch added"}), 201

# ➤ NEW: Added route for Editing
@app.route("/api/branches/<id>", methods=["PUT"])
def update_branch(id):
    try:
        data = request.json or {}
        # Update the branch fields
        branches_collection.update_one(
            {"_id": ObjectId(id)}, 
            {"$set": {
                "name": data.get("name"),
                "address": data.get("address"),
                "manager": data.get("manager"),
                "phone": data.get("phone")
            }}
        )
        return jsonify({"message": "Branch updated successfully"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ➤ NEW: Added route for Deleting
@app.route("/api/branches/<id>", methods=["DELETE"])
def delete_branch(id):
    try:
        # Delete the branch by its ID
        branches_collection.delete_one({"_id": ObjectId(id)})
        return jsonify({"message": "Branch deleted successfully"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500
# ---------- KPI ENDPOINTS ----------

@app.route("/api/low-stock-count", methods=["GET"])
def api_low_stock_count():
    try:
        count = inventory_collection.count_documents({
            "$expr": {"$lte": ["$quantity", "$reorder_level"]}
        })
        return jsonify({"count": int(count)}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/total-inventory", methods=["GET"])
def api_total_inventory():
    try:
        cursor = inventory_collection.find({}, {"price": 1, "quantity": 1})
        total_value = 0.0
        for doc in cursor:
            price = float(doc.get("price") or 0)
            qty = float(doc.get("quantity") or 0)
            total_value += price * qty
        return jsonify({"value": total_value}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/branches-count", methods=["GET"])
def api_branches_count():
    try:
        count = branches_collection.count_documents({})
        return jsonify({"count": int(count)}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ---------- SUPPLIERS ----------

@app.route("/api/suppliers", methods=["GET"])
def get_suppliers():
    suppliers = list(suppliers_collection.find({}, {"_id": 0}))
    return jsonify(suppliers), 200


# ... inside app.py ...

@app.route("/api/suppliers", methods=["POST"])
def add_supplier():
    data = request.json or {}
    if not data.get("name"):
        return jsonify({"error": "Supplier name is required"}), 400

    doc = {
        "name": data["name"],
        "contact": data.get("contact", ""),
        "phone": data.get("phone", ""),
        "lead_time_days": data.get("lead_time_days", 0),
        # NEW FIELDS ADDED HERE
        "website": data.get("website", ""),
        "notes": data.get("notes", "")
    }
    suppliers_collection.insert_one(doc)
    return jsonify({"message": "Supplier added"}), 201

@app.route("/api/suppliers/<string:name>", methods=["POST"])
def update_supplier(name):
    data = request.json or {}
    
    update_fields = {
        "contact": data.get("contact"),
        "phone": data.get("phone"),
        "lead_time_days": data.get("lead_time_days"),
        # NEW FIELDS ADDED HERE
        "website": data.get("website"),
        "notes": data.get("notes")
    }
    
    # Remove None values
    update_fields = {k: v for k, v in update_fields.items() if v is not None}

    result = suppliers_collection.update_one(
        {"name": name},
        {"$set": update_fields}
    )
    
    if result.matched_count == 0:
        return jsonify({"error": "Supplier not found"}), 404
        
    return jsonify({"message": "Supplier updated"}), 200


@app.route("/api/suppliers/<string:name>", methods=["DELETE"])
def delete_supplier(name):
    result = suppliers_collection.delete_one({"name": name})
    if result.deleted_count == 0:
        return jsonify({"error": "Supplier not found"}), 404
    return jsonify({"message": "Supplier deleted"}), 200


# ---------- ORDERS (Restock Requests) ----------

@app.route("/api/orders", methods=["GET"])
def get_orders():
    # Fetch all orders, newest first
    orders = list(orders_collection.find({}).sort("created_at", -1))
    for o in orders:
        o["_id"] = str(o["_id"])  # Convert ObjectId to string
    return jsonify(orders), 200

@app.route("/api/orders", methods=["POST"])
def create_order():
    data = request.json or {}
    
    # Simple validation
    if not data.get("item") or not data.get("quantity"):
        return jsonify({"error": "Item and Quantity are required"}), 400

    # Ensure status is set
    if "status" not in data:
        data["status"] = "pending"
    
    # Save to database
    result = orders_collection.insert_one(data)
    data["_id"] = str(result.inserted_id)

    return jsonify({"message": "Order created successfully", "order": data}), 201

# ---------- ALERTS ----------

@app.post("/api/alerts/<alert_id>/acknowledge")
def acknowledge_alert(alert_id):
    user_id = request.headers.get("X-User-Id", "demo-admin")
    user_name = request.headers.get("X-User-Name", "Demo Admin")

    doc = {
        "alert_id": alert_id,
        "user_id": user_id,
        "user_name": user_name,
        "acknowledged_at": datetime.utcnow().isoformat() + "Z",
    }

    db.alert_acknowledgements.insert_one(doc)
    return jsonify({"status": "ok"})

@app.get("/api/alerts")
def get_alerts():
    # 1. Setup User ID for Acknowledgements
    user_id = request.headers.get("X-User-Id", "demo-admin")

    alerts = []
    low_by_branch = {}

    # 2. INVENTORY ALERTS (Low Stock & Expiry)
    items = list(inventory_collection.find({}))

    for item in items:
        name = item.get("name")
        branch = item.get("branch", "Main branch")
        qty = item.get("quantity", 0)
        reorder = item.get("reorder_level", 0)
        expiry = item.get("expiry_date")

        # Low Stock
        if reorder and qty <= reorder:
            alerts.append({
                "id": f"low-stock-{branch}-{name}",
                "type": "low_stock",
                "severity": "high",
                "title": f"Low stock: {name}",
                "description": f"{qty} units left (Reorder: {reorder}) in {branch}.",
                "branch": branch,
            })
            low_by_branch[branch] = low_by_branch.get(branch, 0) + 1

        # Expiry
        if expiry and expiry_within_days(expiry, 30):
            alerts.append({
                "id": f"expiry-{branch}-{name}",
                "type": "expiry_risk",
                "severity": "medium",
                "title": f"Expiry Risk: {name}",
                "description": f"Batch expiring soon in {branch}.",
                "branch": branch,
            })

    # 3. BRANCH AGGREGATE ALERTS
    for branch, count in low_by_branch.items():
        if count >= 3:
            alerts.append({
                "id": f"branch-low-{branch}",
                "type": "branch_low_stock",
                "severity": "high",
                "title": f"Branch Alert: {branch}",
                "description": f"{count} items are low on stock in {branch}.",
                "branch": branch,
            })

    # 4. NEW: STAFF REQUESTS (Pending Orders)
    # This was likely the missing part or had a syntax error
    pending_orders = list(orders_collection.find({"status": "pending"}))
    for order in pending_orders:
        alerts.append({
            "id": f"order-{str(order['_id'])}", # Converted ObjectId to string safely
            "type": "pending_request",
            "severity": "info",
            "title": f"📢 New Request: {order.get('item')}",
            "description": f"Staff at {order.get('branch')} requested {order.get('quantity')} units.",
            "branch": order.get('branch'),
            "action_link": "orders"
        })

    # 5. FILTER ACKNOWLEDGED ALERTS
    # This prevents deleted alerts from reappearing
    try:
        acked_ids = {
            doc["alert_id"]
            for doc in db.alert_acknowledgements.find(
                {"user_id": user_id}, {"alert_id": 1, "_id": 0}
            )
        }
    except Exception:
        acked_ids = set()

    visible_alerts = [a for a in alerts if a["id"] not in acked_ids]
    
    return jsonify(visible_alerts)


# ---------- HELPER FUNCTION ----------

# Helper to fix "not defined" error
def expiry_within_days(expiry_value, days):
    if not expiry_value: return False
    if isinstance(expiry_value, datetime): expiry_dt = expiry_value
    else:
        try: expiry_dt = datetime.fromisoformat(str(expiry_value))
        except: return False
    return expiry_dt <= datetime.now() + timedelta(days=days)

# ---------- REPLENISHMENT ----------

@app.get("/api/replenishment/recommendations")
def get_replenishment_recommendations():
    items = list(inventory_collection.find({}))

    recommendations = []

    for item in items:
        name = item.get("name")
        branch = item.get("branch", "Main")
        qty = item.get("quantity", 0)
        reorder = item.get("reorder_level", 0)

        avg_daily_usage = item.get("avg_daily_usage", 1)
        lead_time_days = item.get("lead_time_days", 7)
        safety_stock = item.get("safety_stock", reorder or 0)

        reorder_point = avg_daily_usage * lead_time_days + safety_stock

        trigger_level = max(reorder, reorder_point)
        if qty <= trigger_level:
            target_stock = avg_daily_usage * (lead_time_days + 7) + safety_stock
            suggested_qty = max(int(target_stock - qty), 0)

            if suggested_qty > 0:
                recommendations.append({
                    "name": name,
                    "branch": branch,
                    "current_quantity": qty,
                    "reorder_level": reorder,
                    "reorder_point": reorder_point,
                    "suggested_order_qty": suggested_qty,
                })

    return jsonify(recommendations)

# ---------- ANALYTICS REST ENDPOINTS ----------

@app.get("/analytics/overview")
def analytics_overview():
    # Fix: Compare Date Strings ("YYYY-MM-DD") instead of Objects
    seven_days_ago = datetime.now() - timedelta(days=7)
    
    # Inventory uses Date Objects (usually), Batches use Strings (from HTML form)
    new_items = inventory_collection.count_documents({
        "created_at": {"$gte": seven_days_ago}
    })

    # For batches, we convert the date limit to a string "YYYY-MM-DD"
    date_str = seven_days_ago.strftime("%Y-%m-%d")
    batches_7d = batches_collection.count_documents({
        "mfg_date": {"$gte": date_str}
    })

    total_items = inventory_collection.count_documents({})
    branches = branches_collection.count_documents({})

    return jsonify({
        "new_items": new_items,
        "batches_7d": batches_7d,
        "total_items": total_items,
        "branches": branches,
    })

@app.get("/analytics/movement")
def analytics_movement():
    target_branch = request.args.get('branch')
    query = {}
    if target_branch and target_branch != 'All':
        query["branch"] = target_branch

    today = datetime.now()
    start_date = today - timedelta(days=6)
    labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    stock_in = [0] * 7
    stock_out = [0] * 7

    # Filter Batches (Stock In)
    batches = list(batches_collection.find(query))
    for b in batches:
        mfg = b.get("mfg_date")
        if not mfg: continue
        try:
            if isinstance(mfg, str): mfg = datetime.fromisoformat(mfg)
            if mfg >= start_date:
                idx = 0 if mfg.weekday() == 6 else mfg.weekday() + 1
                stock_in[idx] += int(b.get("current_stock", 0))
        except: continue

    # Filter Consumption (Stock Out/In)
    usage = list(consumption_collection.find(query))
    for u in usage:
        d = u.get("date")
        if not d: continue
        try:
            if isinstance(d, str): d = datetime.fromisoformat(d)
            if d >= start_date:
                idx = 0 if d.weekday() == 6 else d.weekday() + 1
                qty = int(u.get("quantity_used", 0))
                if u.get("direction") == "in": stock_in[idx] += qty
                else: stock_out[idx] += qty
        except: continue

    return jsonify({"labels": labels, "stock_in": stock_in, "stock_out": stock_out})

@app.get("/analytics/movement-monthly")
def analytics_movement_monthly():
    target_branch = request.args.get('branch')

    now = datetime.now()
    months = []
    for i in range(11, -1, -1):
        first = (now.replace(day=1) - timedelta(days=30 * i))
        months.append((first.year, first.month))

    month_labels = [datetime(y, m, 1).strftime("%b %Y") for (y, m) in months]
    month_in = [0] * 12
    month_out = [0] * 12

    oldest_year, oldest_month = months[0]
    since = datetime(oldest_year, oldest_month, 1)

    # Build Query with Branch Filter
    query = {"date": {"$gte": since}}
    if target_branch and target_branch != 'All':
        query["branch"] = target_branch

    usage = list(consumption_collection.find(query))
    for u in usage:
        d = u.get("date")
        try:
            if isinstance(d, str): d = datetime.fromisoformat(d)
            ym = (d.year, d.month)
            if ym in months:
                idx = months.index(ym)
                qty = int(u.get("quantity_used", 0))
                if u.get("direction") == "in": month_in[idx] += qty
                else: month_out[idx] += qty
        except: continue

    return jsonify({"labels": month_labels, "stock_in": month_in, "stock_out": month_out})


@app.get("/analytics/category")
def analytics_category():
    pipeline = [
        {"$match": {"category": {"$ne": None}}},
        {"$group": {"_id": "$category", "total": {"$sum": "$quantity"}}},
        {"$project": {"_id": 0, "id": "$_id", "total": 1}},
    ]
    return jsonify(list(inventory_collection.aggregate(pipeline)))


@app.get("/analytics/low-stock")
def analytics_low_stock():
    return jsonify(list(inventory_collection.find(
        {"$expr": {"$lte": ["$quantity", "$reorder_level"]}},
        {"_id": 0, "name": 1, "quantity": 1},
    )))

@app.get("/analytics/top-products")
def analytics_top_products():
    pipeline = [
        # 1. Filter: Only count Stock OUT
        {"$match": {"direction": "out"}},

        # 2. Group: Sum up quantity used
        {"$group": {"_id": "$name", "used": {"$sum": "$quantity_used"}}},
        
        # 3. Sort: Highest usage first
        {"$sort": {"used": -1}},
        {"$limit": 5},
        
        # 4. Lookup: Get Price from Inventory
        {"$lookup": {
            "from": "inventory",
            "localField": "_id",
            "foreignField": "name",
            "as": "inv_data"
        }},
        
        # 5. Calculate Cost (Safe handling if price is missing)
        {"$project": {
            "_id": 1,
            "used": 1,
            "price": {"$ifNull": [{"$arrayElemAt": ["$inv_data.price", 0]}, 0]},
            "total_cost": {
                "$multiply": [
                    "$used",
                    {"$ifNull": [{"$arrayElemAt": ["$inv_data.price", 0]}, 0]}
                ]
            }
        }}
    ]
    return jsonify(list(consumption_collection.aggregate(pipeline)))

@app.route("/api/analytics/branch-stock", methods=["GET"])
def analytics_branch_stock():
    pipeline = [
        {"$group": {
            "_id": "$branch",
            "total_qty": {"$sum": "$quantity"},
        }},
        {"$sort": {"_id": 1}},
    ]
    results = list(inventory_collection.aggregate(pipeline))
    labels = [r["_id"] or "Unassigned" for r in results]
    values = [r["total_qty"] for r in results]
    return jsonify({"labels": labels, "values": values}), 200

# ---------- SOCKET ANALYTICS BROADCASTER ----------

def build_analytics_payload():
    # 1. Setup Dates
    now = datetime.now()
    seven_days_ago = now - timedelta(days=7)
    date_str = seven_days_ago.strftime("%Y-%m-%d")

    # 2. OVERVIEW KPIs (Robust Query)
    new_items = inventory_collection.count_documents({
        "$or": [
            {"created_at": {"$gte": seven_days_ago}}, 
            {"created_at": {"$gte": date_str}}
        ]
    })
    
    batches_7d = batches_collection.count_documents({
        "mfg_date": {"$gte": date_str}
    })
    
    total_items = inventory_collection.count_documents({})
    branches = branches_collection.count_documents({})

    overview = {
        "new_items": new_items,
        "batches_7d": batches_7d,
        "total_items": total_items,
        "branches": branches,
    }

# 3. WEEKLY MOVEMENT (Robust Date Logic)
    week_labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    week_in = [0] * 7
    week_out = [0] * 7
    
    # Process Batches (In)
    start_week = now - timedelta(days=6)
    
    # FIX: Only fetch documents that actually HAVE a date string
    recent_batches = list(batches_collection.find({
        "mfg_date": {"$type": "string", "$gte": date_str} 
    }))
    
    for b in recent_batches:
        d_val = b.get("mfg_date")
        if not d_val: continue
        try:
            # Handle string dates safely
            d = datetime.fromisoformat(d_val)
            # Map Python weekday (0=Mon...6=Sun) to our labels (0=Sun...6=Sat)
            # Our labels: Sun(0), Mon(1), Tue(2)...
            # Python: Mon(0) -> 1, Tue(1) -> 2... Sun(6) -> 0
            idx = 0 if d.weekday() == 6 else d.weekday() + 1
            
            week_in[idx] += int(b.get("current_stock", 0)) # Ensure integer
        except Exception as e:
            print(f"Skipping batch date error: {d_val}")
            continue

    # Process Consumption (In/Out)
    recent_usage = list(consumption_collection.find({
        "date": {"$gte": start_week}
    }))
    
    for u in recent_usage:
        d = u.get("date")
        if not d: continue
        # If it's stored as datetime object in Mongo, use it directly
        if isinstance(d, str):
            try:
                d = datetime.fromisoformat(d)
            except: continue
            
        idx = 0 if d.weekday() == 6 else d.weekday() + 1
        qty = int(u.get("quantity_used", 0))
        
        if u.get("direction") == "in":
            week_in[idx] += qty
        else:
            week_out[idx] += qty

    weekly_movement = {
        "labels": week_labels,
        "stock_in": week_in,
        "stock_out": week_out,
    }

    # 4. MONTHLY MOVEMENT (Big Chart)
    # (Simplified for brevity - passing same structure as weekly if complex query fails, 
    # but ideally this should be your full monthly logic from before)
    monthly_movement = weekly_movement 

    # 5. LOW STOCK
    low_stock_rows = list(inventory_collection.find(
        {"$expr": {"$lte": ["$quantity", "$reorder_level"]}},
        {"_id": 0, "name": 1, "quantity": 1},
    ))

    # 6. TOP PRODUCTS (Cost Calculation Included)
    pipeline = [
        {"$match": {"direction": "out"}},
        {"$group": {"_id": "$name", "used": {"$sum": "$quantity_used"}}},
        {"$sort": {"used": -1}},
        {"$limit": 5},
        {"$lookup": {
            "from": "inventory",
            "localField": "_id",
            "foreignField": "name",
            "as": "inv_data"
        }},
        {"$project": {
            "_id": 1,
            "used": 1,
            "total_cost": {
                "$multiply": [
                    "$used",
                    { "$toDouble": {"$ifNull": [{"$arrayElemAt": ["$inv_data.price", 0]}, 0]} }
                ]
            }
        }}
    ]
    top_products = list(consumption_collection.aggregate(pipeline))

    # RETURN EVERYTHING
    return {
        "overview": overview,
        "movement": weekly_movement,
        "movement_monthly": monthly_movement,
        "low_stock": low_stock_rows,
        "top_products": top_products,
    }


def analytics_broadcaster():
    while True:
        try:
            payload = build_analytics_payload()
            socketio.emit("analytics_update", payload, namespace="/analytics")
        except Exception as e:
            print("Analytics broadcaster error:", e)
        time.sleep(5)


@socketio.on("connect", namespace="/analytics")
def analytics_connect():
    print("Client connected to analytics")

# ---------- COMPLIANCE API ----------

@app.route("/api/compliance/overview", methods=["GET"])
def get_compliance_overview():
    # 1. Check for Expired Items (Critical Compliance Issue)
    today = datetime.now()
    # Find batches where exp_date < today
    expired_batches = list(batches_collection.find({
        "exp_date": {"$lt": today.strftime("%Y-%m-%d")}
    }))
    
    # 2. Check for Low Stock (Operational Compliance Issue)
    low_stock_items = list(inventory_collection.find(
        {"$expr": {"$lte": ["$quantity", "$reorder_level"]}}
    ))

    total_issues = len(expired_batches) + len(low_stock_items)
    
    # Calculate Score (Simple logic: Start at 100, deduct 5 per issue, min 0)
    score = max(0, 100 - (total_issues * 5))
    
    status = "Excellent"
    if score < 90: status = "Good"
    if score < 70: status = "Warning"
    if score < 50: status = "Critical"

    return jsonify({
        "score": score,
        "status": status,
        "expired_count": len(expired_batches),
        "low_stock_count": len(low_stock_items),
        "issues": total_issues
    })

@app.route("/api/compliance/audit-logs", methods=["GET"])
def get_audit_logs():
    # Fetch recent stock movements (last 50)
    logs = list(consumption_collection.find({}).sort("date", -1).limit(50))
    
    # Clean up _id for JSON
    for log in logs:
        log["_id"] = str(log["_id"])
        
    return jsonify(logs)


@app.route("/debug/batch", methods=["POST"])
def debug_batch():
    data = request.get_json(force=True)
    try:
        batch_doc = {
            "item_name": data.get("item_name"),
            "branch": data.get("branch"),
            "current_stock": data.get("current_stock", 0),
            "category": data.get("category") or "Uncategorized",
        }
        return jsonify({"ok": True}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
    # ---------- AUTHENTICATION APIs (Missing!) ----------


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"message": "Logged out"}), 200

# ---------- OWNER SETTINGS (GOVERNANCE) ----------

@app.route("/api/admin/settings", methods=["GET"])
def get_system_settings():
    if session.get("role") != "owner":
        return jsonify({"error": "Unauthorized"}), 403
    
    doc = settings_collection.find_one({"_id": "global_config"}) or {}
    return jsonify({"lockdown": doc.get("lockdown", False)})

@app.route("/api/admin/lockdown", methods=["POST"])
def toggle_lockdown():
    if session.get("role") != "owner":
        return jsonify({"error": "Unauthorized"}), 403
    
    data = request.json
    new_status = data.get("status", False)
    
    settings_collection.update_one(
        {"_id": "global_config"},
        {"$set": {"lockdown": new_status}},
        upsert=True
    )
    
    action = "Enabled" if new_status else "Disabled"
    log_behavior(session.get("user_email"), "System Lockdown", f"Owner {action} Maintenance Mode")
    return jsonify({"message": f"System Lockdown {action}"})

@app.route("/api/admin/clear-logs", methods=["DELETE"])
def clear_audit_logs():
    if session.get("role") != "owner":
        return jsonify({"error": "Unauthorized"}), 403
    
    audit_collection.delete_many({})
    
    # Log that we cleared the logs (so there's at least one record of the wipe)
    log_behavior(session.get("user_email"), "Wipe Data", "Owner cleared all audit logs")
    
    return jsonify({"message": "Audit logs wiped successfully"})


# ==========================================
# OWNER GOVERNANCE ROUTES
# ==========================================

@app.route("/api/admin/broadcast", methods=["POST"])
def admin_broadcast():
    if session.get("role") != "owner":
        return jsonify({"error": "Unauthorized"}), 403
    
    data = request.json
    message = data.get("message", "System Alert")
    
    # Send to ALL connected clients
    socketio.emit("system_broadcast", {"message": message, "sender": "Owner"})
    return jsonify({"message": "Broadcast sent"})

@app.route("/api/admin/kill-sessions", methods=["POST"])
def admin_kill_sessions():
    if session.get("role") != "owner":
        return jsonify({"error": "Unauthorized"}), 403
    
    # Emit event to force clients to logout themselves
    socketio.emit("force_logout_event", {"exclude_role": "owner"})
    return jsonify({"message": "Kill command sent to all clients"})

@app.route("/api/admin/backup", methods=["GET"])
def admin_backup_data():
    if session.get("role") != "owner":
        return jsonify({"error": "Unauthorized"}), 403
    
    # 1. Fetch Data
    inventory = list(inventory_collection.find({}, {"_id": 0}))
    batches = list(batches_collection.find({}, {"_id": 0}))
    suppliers = list(suppliers_collection.find({}, {"_id": 0}))
    
    # 2. Bundle it
    backup_data = {
        "timestamp": datetime.now().isoformat(),
        "inventory": inventory,
        "batches": batches,
        "suppliers": suppliers
    }
    
    # 3. Create JSON response
    return jsonify(backup_data)


# Import Groq at the top of your file
from groq import Groq # <--- ADD THIS TO IMPORTS

# ==========================================
#  🧠 GROQ (LLAMA 3) ANALYZER
# ==========================================

@app.route('/api/ai/analyze', methods=['GET'])
def ai_analyze_inventory():
    try:
        # 1. SETUP CLIENT (Paste your key directly here for testing)
        # REPLACE 'gsk_...' with your actual key inside the quotes
        GROQ_API_KEY = "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" 
        
        if not GROQ_API_KEY or "YOUR_ACTUAL" in GROQ_API_KEY:
             return jsonify({
                "insight_text": "Configuration Error: Groq API Key is missing in app.py.",
                "status_badge": "Config Error",
                "recommended_order": []
            }), 200

        # 2. CHECK CACHE (Prevent spamming the API)
        cache_key = "latest_ai_analysis"
        cached_doc = ai_dashboard_collection.find_one({"_id": cache_key})
        
        if cached_doc:
            last_update = cached_doc.get("timestamp")
            # Cache for 15 minutes
            if last_update and (datetime.now() - last_update).seconds < 900:
                print("Returning CACHED Groq response")
                return jsonify(cached_doc["data"]), 200

        # 3. PREPARE DATA
        # Limit to 30 items to keep it fast
        cursor = inventory_collection.find({}, {
            "_id": 0, "name": 1, "quantity": 1, "reorder_level": 1, 
            "monthly_usage": 1
        }).sort("quantity", 1).limit(30)
        
        items = list(cursor)
        data_str = json.dumps(items)

        # 4. CALL GROQ (Llama 3)
        client = Groq(api_key=GROQ_API_KEY)
        
        completion = client.chat.completions.create(
            messages=[
                {
                    "role": "system", 
                    "content": "You are a supply chain assistant. Output ONLY valid JSON."
                },
                {
                    "role": "user",
                    "content": f"""
                    Analyze this inventory list: {data_str}
                    
                    Return a JSON object with this EXACT structure (no markdown):
                    {{
                        "insight_text": "Write a 2-sentence summary of the stock health.",
                        "status_badge": "Healthy" or "Critical",
                        "recommended_order": [
                            {{"item": "Item Name", "qty": 10, "reason": "Low stock"}}
                        ]
                    }}
                    """
                }
            ],
            model="llama-3.3-70b-versatile",
            temperature=0.3,
            response_format={"type": "json_object"}
        )

        # 5. PARSE & SAVE
        ai_content = completion.choices[0].message.content
        ai_data = json.loads(ai_content)

        ai_dashboard_collection.update_one(
            {"_id": cache_key},
            {"$set": {"data": ai_data, "timestamp": datetime.now()}},
            upsert=True
        )

        return jsonify(ai_data), 200

    except Exception as e:
        print(f"Groq Error: {e}")
        # FALLBACK: Return a safe object so frontend doesn't say "undefined"
        return jsonify({
            "insight_text": f"System Error: {str(e)}",
            "status_badge": "Error",
            "recommended_order": []
        }), 200
    
# // ////////////////////////////////////////////////////// //
# //      🧠 LUX MARKET INTELLIGENCE (SUPPLIER SPECIFIC)      //
# // ////////////////////////////////////////////////////// //

@app.route('/api/ai/market-intelligence', methods=['GET'])
def ai_market_intelligence():
    try:
        # 1. Group price history by Item + Supplier (formerly supplier_batch)
        pipeline = [
            {"$sort": {"mfg_date": 1}},
            {"$group": {
                "_id": {
                    "item": "$item_name",
                    "supplier": "$supplier_batch" 
                },
                "price_history": {"$push": "$price"},
                "last_price": {"$last": "$price"},
                "avg_price": {"$avg": "$price"}
            }},
            {"$limit": 20}
        ]
        market_data = list(batches_collection.aggregate(pipeline))
        data_str = json.dumps(market_data)

        # 2. LUX Analysis via Groq
        GROQ_API_KEY = "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" 
        client = Groq(api_key=GROQ_API_KEY)
        
        completion = client.chat.completions.create(
            messages=[
                {
                    "role": "system", 
                    "content": "You are LUX, a Dental Procurement Expert. You track prices per specific supplier. Output ONLY JSON."
                },
                {
                    "role": "user",
                    "content": f"""
                    Analyze this supplier price data: {data_str}
                    
                    Identify which specific suppliers are raising prices and which are cheapest.
                    Return JSON:
                    {{
                        "market_summary": "1-sentence summary of supplier behavior.",
                        "predictions": [
                            {{
                                "item": "Item Name",
                                "supplier": "Supplier Name",
                                "trend": "Rising/Falling/Stable",
                                "forecast": "Predicted next price",
                                "advice": "Tactical advice for this specific supplier."
                            }}
                        ]
                    }}
                    """
                }
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"}
        )

        return jsonify(json.loads(completion.choices[0].message.content)), 200

    except Exception as e:
        print(f"LUX Market Error: {e}")
        return jsonify({"error": "LUX is currently analyzing supplier catalogs."}), 500
# ---------- Run server ----------

if __name__ == "__main__":
    # Start your background analytics thread
    t = threading.Thread(target=analytics_broadcaster, daemon=True)
    t.start()
    
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False)