// Planday / Tudor Local Rota Application Core Engine with Auth & Access Control

(function () {
  "use strict";

  // Clean Slate Default Data
  const CLEAN_DATA = {
    settings: {
      currency: "£",
      targetLaborPercentage: 20.0,
      projectedWeeklyRevenue: 0,
      businessName: "Tudor Local"
    },
    departments: [
      { id: "general", name: "General Staff", color: "#0ea5e9" },
      { id: "foh", name: "Front of House", color: "#10b981" },
      { id: "boh", name: "Back of House / Kitchen", color: "#f59e0b" },
      { id: "mgmt", name: "Management", color: "#8b5cf6" }
    ],
    employees: [],
    shifts: [],
    requests: [],
    punches: [],
    users: [
      {
        id: "user_admin",
        username: "admin",
        passwordHash: "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9",
        role: "admin",
        name: "Manager (Admin)",
        employeeId: null,
        hasRotaAccess: true,
        isActive: true,
        mustChangePassword: false
      },
      {
        id: "user_mantresh",
        username: "mantresh",
        passwordHash: "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9",
        role: "admin",
        name: "Mantresh",
        employeeId: "emp_1790267945703",
        hasRotaAccess: true,
        isActive: true,
        mustChangePassword: false
      }
    ],
    resetRequests: []
  };

  // Application State
  const state = {
    currentUser: JSON.parse(localStorage.getItem("tudor_rota_user") || "null"),
    authView: "login", // 'login' | 'forgot' | 'reset_otp'
    authError: "",
    authSuccess: "",
    activeTab: "schedule",
    currentMonday: getMonday(new Date("2026-09-21")),
    groupingMode: "employee", // 'employee' or 'department'
    selectedDepartment: "all",
    searchQuery: "",
    timeFormat: localStorage.getItem("tudor_time_format") || "24h", // '12h' | '24h'
    theme: localStorage.getItem("tudor_theme") || "light", // 'light' | 'dark'
    showProfileMenu: false,
    data: JSON.parse(JSON.stringify(CLEAN_DATA)),
    editingShift: null,
    editingEmployee: null,
    showSettingsModal: false,
    showGrantAccessModal: null, // employee object
    showOtpModal: null, // { name, username, otp }
    showMustChangePasswordModal: false
  };

  // Apply theme immediately
  document.documentElement.setAttribute("data-theme", state.theme);

  // Time format helper (12h vs 24h)
  function formatShiftTime(t) {
    if (!t) return "";
    if (state.timeFormat === "12h") {
      const [hStr, mStr] = t.split(":");
      const h = Number(hStr);
      const m = Number(mStr);
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h % 12 || 12;
      return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
    }
    return t;
  }

  function formatShiftRange(s, e) {
    if (!s || !e) return "";
    return `${formatShiftTime(s)} – ${formatShiftTime(e)}`;
  }

  // Utility: SHA-256 for browser fallback
  async function sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Utility: Get Monday of a given date
  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    const mon = new Date(date.setDate(diff));
    mon.setHours(0, 0, 0, 0);
    return mon;
  }

  // Format date YYYY-MM-DD
  function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // Parse YYYY-MM-DD to Date
  function parseDate(str) {
    const [y, m, d] = str.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  // Calculate Net Hours from start, end, break
  function calculateNetHours(startTime, endTime, breakMinutes = 0) {
    if (!startTime || !endTime) return 0;
    const [startH, startM] = startTime.split(":").map(Number);
    const [endH, endM] = endTime.split(":").map(Number);

    let startTotal = startH * 60 + startM;
    let endTotal = endH * 60 + endM;

    // Overnight shifts
    if (endTotal <= startTotal) {
      endTotal += 24 * 60;
    }

    const netMinutes = Math.max(0, endTotal - startTotal - Number(breakMinutes || 0));
    return Number((netMinutes / 60).toFixed(2));
  }

  // Persistence: Save to backend / localStorage
  async function saveData() {
    localStorage.setItem("planday_rota_data", JSON.stringify(state.data));
    try {
      await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.data)
      });
    } catch (err) {
      console.warn("Server sync skipped, cached locally:", err);
    }
    renderApp();
  }

  // Load Data
  async function loadData() {
    try {
      const res = await fetch("/api/data");
      if (res.ok) {
        state.data = await res.json();
        if (!state.data.employees) state.data.employees = [];
        if (!state.data.shifts) state.data.shifts = [];
        if (!state.data.users) state.data.users = CLEAN_DATA.users;
        if (!state.data.resetRequests) state.data.resetRequests = [];
        if (!state.data.settings) state.data.settings = CLEAN_DATA.settings;
        if (!state.data.departments) state.data.departments = CLEAN_DATA.departments;
        renderApp();
        return;
      }
    } catch (e) {
      console.log("Loading from localStorage fallback...");
    }

    const local = localStorage.getItem("planday_rota_data");
    if (local) {
      try {
        state.data = JSON.parse(local);
        if (!state.data.users) state.data.users = CLEAN_DATA.users;
        if (!state.data.resetRequests) state.data.resetRequests = [];
        renderApp();
        return;
      } catch (e) {}
    }

    // Direct data.json fetch
    try {
      const res = await fetch("./data.json");
      if (res.ok) {
        state.data = await res.json();
        if (!state.data.users) state.data.users = CLEAN_DATA.users;
        if (!state.data.resetRequests) state.data.resetRequests = [];
        renderApp();
        return;
      }
    } catch (e) {}

    state.data = JSON.parse(JSON.stringify(CLEAN_DATA));
    renderApp();
  }

  // Calculate Week Dates (Mon to Sun)
  function getWeekDates() {
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(state.currentMonday);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }
    return dates;
  }

  // KPI calculations for current week
  function getWeekKPIs() {
    const weekDates = getWeekDates().map(formatDate);
    const weekShifts = (state.data.shifts || []).filter(s => weekDates.includes(s.date));

    let totalHours = 0;
    let totalCost = 0;
    let draftCount = 0;
    const staffSet = new Set();

    weekShifts.forEach(shift => {
      const hours = calculateNetHours(shift.startTime, shift.endTime, shift.breakMinutes);
      totalHours += hours;
      totalCost += hours * (shift.rate || 0);
      if (shift.status === "draft") draftCount++;
      if (shift.employeeId) staffSet.add(shift.employeeId);
    });

    const revenue = state.data.settings.projectedWeeklyRevenue || 0;
    const laborPercentage = revenue > 0 ? ((totalCost / revenue) * 100).toFixed(1) : "0.0";

    return {
      totalHours: totalHours.toFixed(1),
      totalCost: totalCost.toFixed(2),
      draftCount,
      activeStaffCount: staffSet.size,
      totalStaffCount: (state.data.employees || []).length,
      laborPercentage,
      currency: state.data.settings.currency || "£"
    };
  }

  // Conflict Detection Engine
  function checkShiftConflicts(shiftData, excludeShiftId = null) {
    const conflicts = [];
    if (!shiftData.employeeId || !shiftData.date || !shiftData.startTime || !shiftData.endTime) {
      return conflicts;
    }

    const employee = (state.data.employees || []).find(e => e.id === shiftData.employeeId);
    if (!employee) return conflicts;

    // 1. Day of week availability
    const d = parseDate(shiftData.date);
    const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const dayKey = dayKeys[d.getDay()];
    if (employee.availability && employee.availability[dayKey] === false) {
      conflicts.push(`${employee.name} is marked as unavailable on ${dayKey.toUpperCase()}s.`);
    }

    // 2. Overlapping shifts on the same day
    const sameDayShifts = (state.data.shifts || []).filter(
      s => s.employeeId === shiftData.employeeId && s.date === shiftData.date && s.id !== excludeShiftId
    );

    const [newStartH, newStartM] = shiftData.startTime.split(":").map(Number);
    const [newEndH, newEndM] = shiftData.endTime.split(":").map(Number);
    let newStart = newStartH * 60 + newStartM;
    let newEnd = newEndH * 60 + newEndM;
    if (newEnd <= newStart) newEnd += 24 * 60;

    for (const other of sameDayShifts) {
      const [oStartH, oStartM] = other.startTime.split(":").map(Number);
      const [oEndH, oEndM] = other.endTime.split(":").map(Number);
      let oStart = oStartH * 60 + oStartM;
      let oEnd = oEndH * 60 + oEndM;
      if (oEnd <= oStart) oEnd += 24 * 60;

      if (Math.max(newStart, oStart) < Math.min(newEnd, oEnd)) {
        conflicts.push(`Overlaps with another shift (${other.startTime} - ${other.endTime} as ${other.role}).`);
        break;
      }
    }

    // 3. Weekly Overtime Check
    const weekDates = getWeekDates().map(formatDate);
    if (weekDates.includes(shiftData.date)) {
      let weeklyHours = 0;
      (state.data.shifts || [])
        .filter(s => s.employeeId === shiftData.employeeId && weekDates.includes(s.date) && s.id !== excludeShiftId)
        .forEach(s => {
          weeklyHours += calculateNetHours(s.startTime, s.endTime, s.breakMinutes);
        });

      const currentHours = calculateNetHours(shiftData.startTime, shiftData.endTime, shiftData.breakMinutes);
      const totalProjected = weeklyHours + currentHours;
      const contracted = employee.contractedHours || 40;

      if (totalProjected > contracted) {
        conflicts.push(`Overtime Alert: ${employee.name} will reach ${totalProjected.toFixed(1)}h (Contract: ${contracted}h).`);
      }
    }

    return conflicts;
  }

  // Toast Notification helper
  function showToast(msg, type = "success") {
    const existing = document.querySelector(".app-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `app-toast toast-${type}`;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 12px 20px;
      border-radius: 8px;
      background: ${type === "success" ? "#065f46" : "#991b1b"};
      color: white;
      font-weight: 500;
      font-size: 14px;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.2);
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 10px;
      animation: toastIn 0.25s ease;
    `;
    toast.innerHTML = `<span>${type === "success" ? "✓" : "⚠️"}</span> <span>${msg}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // Render Authentication Screen (Login / Forgot / Reset OTP)
  function renderAuthScreen() {
    const business = state.data.settings.businessName || "Tudor Local";

    if (state.authView === "forgot") {
      return `
        <div class="login-screen">
          <div class="login-card">
            <div class="login-card-header">
              <div class="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-md mx-auto mb-3">
                P
              </div>
              <h2 style="font-size: 1.25rem; font-weight: 800; color: #0f172a;">Password Recovery</h2>
              <p style="font-size: 0.8rem; color: #64748b; margin-top: 0.25rem;">
                ${business} · Account Access
              </p>
            </div>

            <div class="login-card-body">
              ${
                state.authError
                  ? `<div class="alert-box alert-danger" style="margin-bottom: 1rem;">⚠️ ${state.authError}</div>`
                  : ""
              }
              ${
                state.authSuccess
                  ? `<div class="alert-box" style="background: #ecfdf5; border-color: #a7f3d0; color: #065f46; margin-bottom: 1rem;">✓ ${state.authSuccess}</div>`
                  : ""
              }

              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: var(--radius-sm); padding: 0.75rem; margin-bottom: 1rem; font-size: 0.8rem; color: #475569;">
                <strong>Step 1:</strong> Enter your username below to notify your manager.<br>
                <strong>Step 2:</strong> Your manager will generate your <strong>One-Time Password (OTP)</strong>.<br>
                <strong>Step 3:</strong> Use that OTP to log in and choose your new password.
              </div>

              <form id="form-forgot-request">
                <div class="form-group">
                  <label class="form-label">Your Username</label>
                  <input type="text" class="form-input" id="forgot-username" placeholder="Enter your username" required autofocus>
                </div>
                <button type="submit" class="btn btn-primary" style="width: 100%; padding: 0.65rem; margin-top: 0.5rem; font-weight: 600;">
                  📢 Notify Manager for Password Reset
                </button>
              </form>

              <div style="border-top: 1px solid #e2e8f0; margin-top: 1.25rem; padding-top: 1rem; text-align: center;">
                <p style="font-size: 0.8rem; color: #64748b; margin-bottom: 0.5rem;">Already have your One-Time Password from your manager?</p>
                <button class="btn btn-secondary btn-sm" id="btn-goto-otp-login" style="width: 100%;">
                  🔑 Log In with One-Time Password (OTP)
                </button>
                <div style="margin-top: 0.75rem;">
                  <a href="#" id="link-back-login" style="font-size: 0.8rem; color: #2563eb; text-decoration: none; font-weight: 600;">
                    ← Back to Sign In
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    if (state.authView === "reset_otp") {
      return `
        <div class="login-screen">
          <div class="login-card">
            <div class="login-card-header">
              <div class="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-md mx-auto mb-3">
                P
              </div>
              <h2 style="font-size: 1.25rem; font-weight: 800; color: #0f172a;">One-Time Password Login</h2>
              <p style="font-size: 0.8rem; color: #64748b; margin-top: 0.25rem;">
                Enter the OTP given by your manager
              </p>
            </div>

            <div class="login-card-body">
              ${
                state.authError
                  ? `<div class="alert-box alert-danger" style="margin-bottom: 1rem;">⚠️ ${state.authError}</div>`
                  : ""
              }

              <form id="form-otp-login">
                <div class="form-group">
                  <label class="form-label">Username</label>
                  <input type="text" class="form-input" id="otp-login-username" placeholder="Enter your username" required autofocus>
                </div>
                <div class="form-group">
                  <label class="form-label">One-Time Password (OTP)</label>
                  <input type="text" class="form-input" id="otp-login-code" placeholder="e.g. TL-7294" style="font-family: monospace; letter-spacing: 0.1em; font-weight: 700;" required>
                </div>
                <button type="submit" class="btn btn-primary" style="width: 100%; padding: 0.65rem; margin-top: 0.5rem; font-weight: 600;">
                  Verify OTP & Log In
                </button>
              </form>

              <div style="text-align: center; margin-top: 1.25rem;">
                <a href="#" id="link-back-login" style="font-size: 0.8rem; color: #2563eb; text-decoration: none; font-weight: 600;">
                  ← Back to Sign In
                </a>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // Default Login View
    return `
      <div class="login-screen">
        <div class="login-card">
          <div class="login-card-header">
            <div class="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-md mx-auto mb-3">
              P
            </div>
            <h2 style="font-size: 1.35rem; font-weight: 800; color: #0f172a;">${business}</h2>
            <p style="font-size: 0.8rem; color: #64748b; margin-top: 0.25rem;">
              Sign in to view your rota & punch clock
            </p>
          </div>

          <div class="login-card-body">
            ${
              state.authError
                ? `<div class="alert-box alert-danger" style="margin-bottom: 1rem;">⚠️ ${state.authError}</div>`
                : ""
            }
            ${
              state.authSuccess
                ? `<div class="alert-box" style="background: #ecfdf5; border-color: #a7f3d0; color: #065f46; margin-bottom: 1rem;">✓ ${state.authSuccess}</div>`
                : ""
            }

            <form id="form-login">
              <div class="form-group">
                <label class="form-label">Username</label>
                <input type="text" class="form-input" id="login-username" placeholder="Enter your username" required autofocus>
              </div>

              <div class="form-group">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
                  <label class="form-label" style="margin-bottom: 0;">Password</label>
                  <a href="#" id="link-forgot-password" style="font-size: 0.75rem; color: #2563eb; text-decoration: none; font-weight: 500;">
                    Forgot Password?
                  </a>
                </div>
                <input type="password" class="form-input" id="login-password" placeholder="••••••••" required>
              </div>

              <button type="submit" class="btn btn-primary" id="btn-submit-login" style="width: 100%; padding: 0.65rem; margin-top: 0.5rem; font-weight: 600;">
                Sign In
              </button>
            </form>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Render Header
  function renderHeader() {
    const user = state.currentUser;
    const isAdmin = user && user.role === "admin";
    const pendingResets = (state.data.resetRequests || []).filter(r => r.status === "pending").length;
    const userInitial = ((user ? user.name || user.username : "U")[0] || "U").toUpperCase();

    return `
      <header class="app-header">
        <div class="brand-section">
          <div class="brand-logo">TL</div>
          <div class="brand-title">
            <span id="header-business-title">${state.data.settings.businessName || "Tudor Local"}</span>
          </div>
        </div>

        <nav class="main-nav">
          <button class="nav-tab ${state.activeTab === "schedule" ? "active" : ""}" data-tab="schedule">
            📅 Schedule
          </button>
          ${
            isAdmin
              ? `
            <button class="nav-tab ${state.activeTab === "staff" ? "active" : ""}" data-tab="staff">
              👥 Staff & Access (${(state.data.employees || []).length})
              ${pendingResets > 0 ? `<span class="nav-badge" style="background:#fef3c7;color:#b45309;">🔔 ${pendingResets}</span>` : ""}
            </button>
          `
              : ""
          }
        </nav>

        <div class="header-actions">
          ${
            isAdmin
              ? `
            <button class="btn btn-primary btn-sm" id="btn-add-shift-header">
              + Add Shift
            </button>
          `
              : ""
          }

          <!-- Profile Circle Avatar with Dropdown -->
          <div class="profile-menu-container">
            <button class="profile-circle-btn" id="btn-profile-toggle" title="${user ? user.name || user.username : "Account"}">
              <span>${userInitial}</span>
            </button>

            <div class="profile-dropdown-menu ${state.showProfileMenu ? "" : "hidden"}" id="profile-dropdown">
              <div class="profile-dropdown-header">
                <div class="dropdown-avatar-circle">${userInitial}</div>
                <div class="dropdown-user-info">
                  <div class="dropdown-name">${user ? user.name || user.username : "User"}</div>
                  <div class="dropdown-meta">
                    <span class="dropdown-role ${isAdmin ? "admin" : "staff"}">${isAdmin ? "Admin" : "Staff"}</span>
                    <span class="dropdown-username">@${user ? user.username : ""}</span>
                  </div>
                </div>
              </div>

              <div class="dropdown-divider"></div>

              <button class="dropdown-item" id="menu-open-settings">
                <span class="dropdown-icon">⚙️</span>
                <span>Settings & Preferences</span>
              </button>

              <div class="dropdown-divider"></div>

              <button class="dropdown-item dropdown-item-danger" id="menu-logout">
                <span class="dropdown-icon">🚪</span>
                <span>Log Out</span>
              </button>
            </div>
          </div>
        </div>
      </header>
    `;
  }

  // Render Top KPI Metrics Bar - Removed per user request
  function renderKpiBar() {
    return "";
  }

  // Render Admin Password Reset Alert Banner
  function renderAdminResetBanner() {
    const isAdmin = state.currentUser && state.currentUser.role === "admin";
    if (!isAdmin) return "";

    const pending = (state.data.resetRequests || []).filter(r => r.status === "pending");
    if (pending.length === 0) return "";

    const first = pending[0];
    return `
      <div class="reset-alert-banner">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.25rem;">🔔</span>
          <div>
            <strong style="color: #1e3a8a;">Password Reset Request:</strong>
            <span style="color: #1e40af;"> ${first.name || first.username} requested a password reset (${first.requestedAt || "recently"}).</span>
          </div>
        </div>
        <button class="btn btn-primary btn-sm btn-generate-otp-banner" data-user-id="${first.userId}" style="white-space: nowrap;">
          🔑 Generate One-Time Password
        </button>
      </div>
    `;
  }

  // Render Rota Controls Bar (Clean Minimalist Week Navigator)
  function renderRotaControls() {
    const weekDates = getWeekDates();
    const startStr = weekDates[0].toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const endStr = weekDates[6].toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const kpis = getWeekKPIs();
    const isAdmin = state.currentUser && state.currentUser.role === "admin";

    return `
      <div class="rota-controls-bar">
        <div class="date-navigator">
          <button class="nav-arrow-btn" id="btn-prev-week" title="Previous Week">◀</button>
          <button class="btn btn-secondary btn-sm" id="btn-today">Today</button>
          <button class="nav-arrow-btn" id="btn-next-week" title="Next Week">▶</button>
          <div class="current-range">Week: ${startStr} – ${endStr}</div>
        </div>
        ${
          isAdmin && kpis.draftCount > 0
            ? `<button class="btn btn-success btn-sm" id="btn-publish-rota">🚀 Publish Rota (${kpis.draftCount})</button>`
            : ""
        }
      </div>
    `;
  }

  // Render Open Shifts Banner - Removed per user request
  function renderOpenShifts() {
    return "";
  }

  // Render Schedule Grid (Rota Table)
  function renderScheduleGrid() {
    const weekDates = getWeekDates();
    const todayStr = formatDate(new Date("2026-09-24"));
    const currency = state.data.settings.currency || "£";
    const isAdmin = state.currentUser && state.currentUser.role === "admin";
    const myEmpId = state.currentUser ? state.currentUser.employeeId : null;

    if ((state.data.employees || []).length === 0) {
      return `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 4rem 2rem; text-align: center; box-shadow: var(--shadow-sm);">
          <div style="font-size: 3rem; margin-bottom: 1rem;">✨</div>
          <h2 style="font-size: 1.35rem; font-weight: 700; color: #0f172a; margin-bottom: 0.5rem;">Your Rota is Clean & Blank</h2>
          <p style="color: #64748b; font-size: 0.9rem; max-width: 480px; margin: 0 auto 1.5rem;">
            Add your staff members in the Staff tab to begin scheduling.
          </p>
          ${
            isAdmin
              ? `
            <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
              <button class="btn btn-primary" id="btn-empty-add-emp">+ Add Your First Employee</button>
            </div>
          `
              : ""
          }
        </div>
      `;
    }

    // Daily totals
    const dailyStats = weekDates.map(d => {
      const dateStr = formatDate(d);
      const shiftsOnDay = (state.data.shifts || []).filter(s => s.date === dateStr);
      let dayHours = 0;
      let dayCost = 0;
      shiftsOnDay.forEach(s => {
        const h = calculateNetHours(s.startTime, s.endTime, s.breakMinutes);
        dayHours += h;
        dayCost += h * (s.rate || 0);
      });
      return {
        hours: dayHours.toFixed(1),
        cost: Math.round(dayCost),
        staffCount: shiftsOnDay.filter(s => s.employeeId).length
      };
    });

    // Headers
    const dayHeadersHtml = weekDates
      .map((d, index) => {
        const dateStr = formatDate(d);
        const dayName = d.toLocaleDateString("en-GB", { weekday: "short" });
        const dayNumber = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        const isToday = dateStr === todayStr;
        const stats = dailyStats[index];

        return `
          <th class="col-day ${isToday ? "is-today" : ""}">
            <div class="day-header">
              <span class="day-name">${dayName}</span>
              <span class="day-date">${dayNumber}</span>
              <span class="day-stats">${stats.hours}h ${isAdmin ? `· ${currency}${stats.cost}` : ""}</span>
            </div>
          </th>
        `;
      })
      .join("");

    // Rows according to groupingMode
    let rowsHtml = "";

    if (state.groupingMode === "employee") {
      let filteredEmployees = state.data.employees || [];
      if (state.selectedDepartment !== "all") {
        filteredEmployees = filteredEmployees.filter(e => e.departmentId === state.selectedDepartment);
      }
      if (state.searchQuery.trim()) {
        const q = state.searchQuery.toLowerCase();
        filteredEmployees = filteredEmployees.filter(
          e => e.name.toLowerCase().includes(q) || e.role.toLowerCase().includes(q)
        );
      }

      rowsHtml = filteredEmployees
        .map(emp => {
          const dept = (state.data.departments || []).find(d => d.id === emp.departmentId) || { name: "", color: "#64748b" };
          const isMe = myEmpId && emp.id === myEmpId;

          // Total hours for employee this week
          const weekDateStrs = weekDates.map(formatDate);
          let empWeeklyHours = 0;
          (state.data.shifts || [])
            .filter(s => s.employeeId === emp.id && weekDateStrs.includes(s.date))
            .forEach(s => {
              empWeeklyHours += calculateNetHours(s.startTime, s.endTime, s.breakMinutes);
            });

          const contracted = emp.contractedHours || 40;
          const isOvertime = empWeeklyHours > contracted;

          const daysCells = weekDates
            .map(d => {
              const dateStr = formatDate(d);
              const shifts = (state.data.shifts || []).filter(s => s.employeeId === emp.id && s.date === dateStr);

              const shiftCards = shifts
                .map(shift => {
                  const sDept = (state.data.departments || []).find(dep => dep.id === shift.departmentId) || dept;
                  const hours = calculateNetHours(shift.startTime, shift.endTime, shift.breakMinutes);
                  const isDraft = shift.status === "draft";
                  const isMyShift = isMe;

                  return `
                    <div class="shift-card ${isDraft ? "status-draft" : "status-published"} ${isMyShift ? "my-shift" : ""}" 
                         style="border-left-color: ${sDept.color};" 
                         data-shift-id="${shift.id}" 
                         title="${shift.notes ? `Note: ${shift.notes}` : "Shift details"}">
                      <div class="shift-time">
                        <span>${formatShiftRange(shift.startTime, shift.endTime)}</span>
                        ${shift.breakMinutes ? `<span class="shift-break">-${shift.breakMinutes}m</span>` : ""}
                      </div>
                      <div class="shift-role-title">
                        ${shift.role} ${isMyShift ? `<span style="color:#2563eb;font-weight:700;">★ Me</span>` : ""}
                      </div>
                      <div class="shift-footer">
                        <span>${hours}h net ${isAdmin ? `· ${currency}${(hours * (shift.rate || emp.hourlyRate || 0)).toFixed(0)}` : ""}</span>
                        ${
                          isDraft
                            ? `<span class="shift-badge badge-draft">Draft</span>`
                            : `<span class="shift-badge badge-published">Live</span>`
                        }
                      </div>
                    </div>
                  `;
                })
                .join("");

              return `
                <td class="shift-cell ${isMe ? "bg-blue-50/20" : ""}" data-emp-id="${emp.id}" data-date="${dateStr}">
                  <div class="shift-cards-wrap">
                    ${shiftCards}
                  </div>
                  ${
                    isAdmin
                      ? `
                    <button class="add-shift-btn btn-cell-add" data-emp-id="${emp.id}" data-date="${dateStr}">
                      + Shift
                    </button>
                  `
                      : ""
                  }
                </td>
              `;
            })
            .join("");

          return `
            <tr class="${isMe ? "bg-blue-50/30" : ""}">
              <td class="entity-cell ${isMe ? "bg-blue-50/40" : ""}">
                <div class="employee-row-info">
                  <div class="emp-avatar" style="background-color: ${emp.avatarColor || dept.color};">
                    ${(emp.name || "E").split(" ").map(n => n[0]).join("")}
                  </div>
                  <div class="emp-details">
                    <div class="emp-name" title="${emp.name}">
                      ${emp.name} ${isMe ? `<span style="font-size:10px;background:#2563eb;color:white;padding:1px 5px;border-radius:4px;font-weight:bold;">YOU</span>` : ""}
                    </div>
                    <div class="emp-role-tag">${emp.role} ${isAdmin ? `· ${currency}${emp.hourlyRate}/h` : ""}</div>
                    <div class="emp-stats-pill">
                      <span class="${isOvertime ? "overtime" : ""}">${empWeeklyHours.toFixed(1)} / ${contracted} hrs</span>
                      ${isOvertime ? " (Overtime)" : ""}
                    </div>
                  </div>
                </div>
              </td>
              ${daysCells}
            </tr>
          `;
        })
        .join("");
    } else {
      // Grouping by Department
      rowsHtml = (state.data.departments || [])
        .map(dept => {
          const daysCells = weekDates
            .map(d => {
              const dateStr = formatDate(d);
              const shifts = (state.data.shifts || []).filter(s => s.departmentId === dept.id && s.date === dateStr);

              const shiftCards = shifts
                .map(shift => {
                  const emp = (state.data.employees || []).find(e => e.id === shift.employeeId);
                  const hours = calculateNetHours(shift.startTime, shift.endTime, shift.breakMinutes);
                  const isMe = myEmpId && shift.employeeId === myEmpId;

                  return `
                    <div class="shift-card ${shift.status === "draft" ? "status-draft" : "status-published"} ${isMe ? "my-shift" : ""}" 
                         style="border-left-color: ${dept.color};" 
                         data-shift-id="${shift.id}">
                      <div class="shift-time">
                        <span>${formatShiftRange(shift.startTime, shift.endTime)}</span>
                        ${shift.status === "draft" ? `<span class="shift-badge badge-draft">Draft</span>` : ""}
                      </div>
                      <div class="shift-role-title"><strong>${emp ? emp.name : "Unassigned"}</strong></div>
                      <div style="font-size:0.7rem;color:#64748b;">${shift.role} · ${hours}h</div>
                    </div>
                  `;
                })
                .join("");

              return `
                <td class="shift-cell" data-dept-id="${dept.id}" data-date="${dateStr}">
                  <div class="shift-cards-wrap">
                    ${shiftCards}
                  </div>
                  ${
                    isAdmin
                      ? `
                    <button class="add-shift-btn btn-cell-add" data-dept-id="${dept.id}" data-date="${dateStr}">
                      + Shift
                    </button>
                  `
                      : ""
                  }
                </td>
              `;
            })
            .join("");

          return `
            <tr>
              <td class="entity-cell">
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="width:14px;height:14px;border-radius:4px;background:${dept.color};"></span>
                  <div>
                    <strong style="font-size:0.9rem;">${dept.name}</strong>
                  </div>
                </div>
              </td>
              ${daysCells}
            </tr>
          `;
        })
        .join("");
    }

    return `
      <div class="rota-table-container">
        <table class="rota-table">
          <thead>
            <tr>
              <th class="col-entity">
                ${state.groupingMode === "employee" ? "Team Member & Contract" : "Department"}
              </th>
              ${dayHeadersHtml}
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  }

  // Render Punch Clock & Timesheets Tab
  function renderPunchClockTab() {
    const activePunches = (state.data.punches || []).filter(p => p.status === "active");
    const isAdmin = state.currentUser && state.currentUser.role === "admin";
    const myEmpId = state.currentUser ? state.currentUser.employeeId : null;

    let empOptions = "";
    if (isAdmin) {
      empOptions = (state.data.employees || []).length > 0
        ? (state.data.employees || []).map(e => `<option value="${e.id}">${e.name} (${e.role})</option>`).join("")
        : `<option value="">-- No Employees Available --</option>`;
    } else {
      const myEmp = (state.data.employees || []).find(e => e.id === myEmpId);
      empOptions = myEmp
        ? `<option value="${myEmp.id}" selected>${myEmp.name} (${myEmp.role})</option>`
        : `<option value="">-- No Profile Linked --</option>`;
    }

    const activeListHtml = activePunches.length === 0
      ? `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">No employees are currently clocked in.</td></tr>`
      : activePunches
          .map(punch => {
            const emp = (state.data.employees || []).find(e => e.id === punch.employeeId) || { name: "Unknown", role: "" };
            const clockInTime = new Date(punch.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const canClockOut = isAdmin || (myEmpId && punch.employeeId === myEmpId);

            return `
              <tr>
                <td><strong>${emp.name}</strong></td>
                <td>${emp.role}</td>
                <td><span style="color:#16a34a;font-weight:600;">● Active</span></td>
                <td>${clockInTime}</td>
                <td>
                  ${
                    canClockOut
                      ? `<button class="btn btn-secondary btn-sm btn-clock-out" data-punch-id="${punch.id}">Clock Out</button>`
                      : `<span style="color:#94a3b8;font-size:0.75rem;">On Duty</span>`
                  }
                </td>
              </tr>
            `;
          })
          .join("");

    return `
      <div class="punch-clock-container">
        <div class="kiosk-card">
          <div style="font-size: 0.85rem; font-weight: 700; color: #64748b; text-transform: uppercase;">
            Live Punch Terminal
          </div>
          <div class="kiosk-clock" id="live-digital-clock">--:--:--</div>
          <div class="kiosk-date" id="live-digital-date">Today</div>

          <div class="form-group" style="text-align: left;">
            <label class="form-label">${isAdmin ? "Select Employee" : "Your Account"}</label>
            <select class="form-select" id="punch-employee-select" ${!isAdmin ? "disabled" : ""}>
              ${empOptions}
            </select>
          </div>

          <div style="display:flex;gap:10px;margin-top:1.5rem;">
            <button class="btn btn-success" id="btn-terminal-clock-in" style="flex:1;padding:10px;">
              ▶ Clock In
            </button>
            <button class="btn btn-secondary" id="btn-terminal-break" style="padding:10px;">
              ☕ Break
            </button>
          </div>
          <p style="font-size:0.75rem;color:#94a3b8;margin-top:1rem;">
            GPS & attendance verified. Punches record directly to timesheets.
          </p>
        </div>

        <div class="live-punches-card">
          <h3 style="font-size:1.05rem;font-weight:700;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;">
            <span>Staff Currently On Duty (${activePunches.length})</span>
            <span style="font-size:0.8rem;font-weight:normal;color:#16a34a;">● Real-time Attendance</span>
          </h3>

          <table class="table-standard">
            <thead>
              <tr>
                <th>Staff Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Clock In Time</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${activeListHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // Render Requests Tab
  function renderRequestsTab() {
    const swapRequests = (state.data.requests || []).filter(r => r.type === "swap");
    const leaveRequests = (state.data.requests || []).filter(r => r.type === "time_off");
    const isAdmin = state.currentUser && state.currentUser.role === "admin";

    const swapHtml = swapRequests.length === 0
      ? `<div style="padding: 30px; text-align: center; color: #94a3b8; font-size: 0.85rem; background: white; border: 1px solid var(--border-color); border-radius: var(--radius-md);">No shift swap requests at this time.</div>`
      : swapRequests
          .map(req => {
            const shift = (state.data.shifts || []).find(s => s.id === req.shiftId);
            const requester = (state.data.employees || []).find(e => e.id === req.requestingEmployeeId) || { name: "Staff" };
            const target = (state.data.employees || []).find(e => e.id === req.targetEmployeeId) || { name: "Anyone" };

            return `
              <div class="request-card">
                <div class="request-meta">
                  <span>Shift Swap Request</span>
                  <span class="shift-badge ${req.status === "pending" ? "badge-draft" : "badge-published"}">${req.status.toUpperCase()}</span>
                </div>
                <div style="font-weight:600;font-size:0.9rem;">
                  ${requester.name} ➔ ${target.name}
                </div>
                <div style="font-size:0.8rem;color:#475569;">
                  Shift: ${shift ? `${shift.date} (${shift.startTime} - ${shift.endTime} as ${shift.role})` : "Custom Shift"}
                </div>
                <div style="font-size:0.775rem;color:#64748b;font-style:italic;">
                  "${req.reason}"
                </div>
                ${
                  isAdmin && req.status === "pending"
                    ? `
                  <div style="display:flex;gap:8px;margin-top:0.5rem;">
                    <button class="btn btn-success btn-sm btn-approve-swap" data-req-id="${req.id}">Approve Swap</button>
                    <button class="btn btn-danger-outline btn-sm btn-reject-swap" data-req-id="${req.id}">Decline</button>
                  </div>
                `
                    : ""
                }
              </div>
            `;
          })
          .join("");

    const leaveHtml = leaveRequests.length === 0
      ? `<div style="padding: 30px; text-align: center; color: #94a3b8; font-size: 0.85rem; background: white; border: 1px solid var(--border-color); border-radius: var(--radius-md);">No leave requests pending.</div>`
      : leaveRequests
          .map(req => {
            const emp = (state.data.employees || []).find(e => e.id === req.employeeId) || { name: "Staff" };
            return `
              <div class="request-card">
                <div class="request-meta">
                  <span>Leave / Time Off</span>
                  <span class="shift-badge ${req.status === "pending" ? "badge-draft" : "badge-published"}">${req.status.toUpperCase()}</span>
                </div>
                <div style="font-weight:600;font-size:0.9rem;">
                  ${emp.name}
                </div>
                <div style="font-size:0.8rem;color:#475569;">
                  Dates: ${req.startDate} to ${req.endDate}
                </div>
                <div style="font-size:0.775rem;color:#64748b;font-style:italic;">
                  "${req.reason}"
                </div>
                ${
                  isAdmin && req.status === "pending"
                    ? `
                  <div style="display:flex;gap:8px;margin-top:0.5rem;">
                    <button class="btn btn-success btn-sm btn-approve-leave" data-req-id="${req.id}">Approve Leave</button>
                    <button class="btn btn-danger-outline btn-sm btn-reject-leave" data-req-id="${req.id}">Reject</button>
                  </div>
                `
                    : ""
                }
              </div>
            `;
          })
          .join("");

    return `
      <div class="requests-grid">
        <div>
          <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:1rem;">🔄 Shift Swaps</h3>
          ${swapHtml}
        </div>
        <div>
          <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:1rem;">🏖️ Leave & Absence Requests</h3>
          ${leaveHtml}
        </div>
      </div>
    `;
  }

  // Render Staff Roster & Access Control Tab (Admin Only)
  function renderStaffTab() {
    const currency = state.data.settings.currency || "£";
    const employees = state.data.employees || [];
    const users = state.data.users || [];
    const resetRequests = state.data.resetRequests || [];

    const cardsHtml = employees
      .map(emp => {
        const dept = (state.data.departments || []).find(d => d.id === emp.departmentId) || { name: "", color: "#64748b" };
        const user = users.find(u => u.employeeId === emp.id);
        const hasAccess = user && user.hasRotaAccess && user.isActive;
        const pendingReset = resetRequests.find(r => user && r.userId === user.id && r.status === "pending");

        return `
          <div class="staff-card">
            <div class="staff-card-header">
              <div class="emp-avatar" style="background-color: ${emp.avatarColor || dept.color};">
                ${(emp.name || "E").split(" ").map(n => n[0]).join("")}
              </div>
              <div style="overflow:hidden;flex:1;">
                <h4 style="font-size:0.95rem;font-weight:700;color:#0f172a;">${emp.name}</h4>
                <div style="font-size:0.75rem;color:#64748b;">${emp.role}</div>
              </div>
              <div>
                ${
                  user
                    ? hasAccess
                      ? `<span class="access-badge access-active" style="background:#dcfce7;color:#166534;font-size:11px;padding:2px 7px;border-radius:9999px;">● Active</span>`
                      : `<span class="access-badge access-revoked" style="background:#fee2e2;color:#991b1b;font-size:11px;padding:2px 7px;border-radius:9999px;">Revoked</span>`
                    : `<span class="access-badge" style="background:#f1f5f9;color:#64748b;font-size:11px;padding:2px 7px;border-radius:9999px;">No Login</span>`
                }
              </div>
            </div>

            <div class="staff-info-row">
              <span>Department</span>
              <strong style="color:${dept.color};">${dept.name}</strong>
            </div>
            <div class="staff-info-row">
              <span>Hourly Wage</span>
              <strong>${currency}${Number(emp.hourlyRate || 0).toFixed(2)}/hr</strong>
            </div>
            <div class="staff-info-row">
              <span>Contracted</span>
              <strong>${emp.contractedHours || 0} hrs/wk</strong>
            </div>

            <!-- Login & Access Section -->
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;margin-top:4px;">
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;">
                <span style="font-weight:600;color:#475569;">Rota Login Access:</span>
                <strong>${user ? user.username : "Not Set"}</strong>
              </div>
              ${
                pendingReset
                  ? `
                <div style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;padding:4px 6px;border-radius:4px;font-size:10px;margin-top:6px;font-weight:600;">
                  ⚠️ Requested password reset!
                </div>
              `
                  : ""
              }
            </div>

            <div style="display:flex;gap:6px;margin-top:0.5rem;flex-wrap:wrap;">
              <button class="btn btn-secondary btn-sm btn-edit-emp" data-emp-id="${emp.id}" style="flex:1;">
                Edit Profile
              </button>

              ${
                !user
                  ? `
                <button class="btn btn-primary btn-sm btn-grant-access" data-emp-id="${emp.id}" style="flex:1;background:#2563eb;">
                  🔑 Grant Access
                </button>
              `
                  : `
                <button class="btn btn-secondary btn-sm btn-toggle-access" data-user-id="${user.id}" data-current="${hasAccess}">
                  ${hasAccess ? "Revoke" : "Restore"}
                </button>
                <button class="btn btn-secondary btn-sm btn-generate-otp" data-user-id="${user.id}" title="Generate One-Time Password for this employee">
                  🔑 Reset OTP
                </button>
              `
              }
            </div>
          </div>
        `;
      })
      .join("");

    return `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
          <div>
            <h3 style="font-size:1.15rem;font-weight:700;">Staff Roster & Rota Access (${employees.length})</h3>
            <p style="font-size:0.8rem;color:#64748b;">
              Manage employee profiles and grant user ID / passwords for mobile rota access.
            </p>
          </div>
          <button class="btn btn-primary btn-sm" id="btn-add-employee">+ New Staff Member</button>
        </div>
        <div class="staff-grid">
          ${cardsHtml}
        </div>
      </div>
    `;
  }

  // Render One-Time Password Display Modal
  function renderOtpModal() {
    if (!state.showOtpModal) return "";
    const info = state.showOtpModal;

    return `
      <div class="modal-overlay" id="otp-modal-overlay">
        <div class="modal-content" style="max-width: 440px;">
          <div class="modal-header">
            <h3 class="modal-title">🔑 One-Time Password Generated</h3>
            <button class="modal-close" id="btn-close-otp-modal">&times;</button>
          </div>

          <div class="modal-body" style="text-align: center;">
            <p style="font-size: 0.85rem; color: #475569;">
              One-Time Temporary Password for <strong>${info.name || info.username}</strong>:
            </p>

            <div class="otp-display-box">
              <div class="otp-code" id="display-otp-code">${info.otp}</div>
            </div>

            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: var(--radius-sm); padding: 0.75rem; text-align: left; font-size: 0.8rem; color: #1e40af; margin-bottom: 1rem;">
              <strong>Instructions for ${info.name || info.username}:</strong>
              <ol style="margin-left: 18px; margin-top: 4px;">
                <li>Open the Tudor Local app on their phone.</li>
                <li>Tap <strong>"Forgot Password"</strong> ➔ <strong>"Log In with OTP"</strong>.</li>
                <li>Enter their username (<code>${info.username}</code>) and this code.</li>
                <li>They will be prompted to set their new permanent password!</li>
              </ol>
            </div>

            <button class="btn btn-primary" id="btn-copy-otp" style="width: 100%; font-weight: 600;">
              📋 Copy Code & Done
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Render Grant Access Modal
  function renderGrantAccessModal() {
    if (!state.showGrantAccessModal) return "";
    const emp = state.showGrantAccessModal;
    const defaultUsername = emp.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const defaultPassword = defaultUsername + "2026";

    return `
      <div class="modal-overlay" id="grant-access-modal-overlay">
        <div class="modal-content" style="max-width: 440px;">
          <div class="modal-header">
            <h3 class="modal-title">🔑 Grant Rota Access to ${emp.name}</h3>
            <button class="modal-close" id="btn-close-grant-modal">&times;</button>
          </div>

          <div class="modal-body">
            <p style="font-size: 0.825rem; color: #64748b; margin-bottom: 1rem;">
              Create login credentials for ${emp.name} so they can download the app and view their shifts.
            </p>

            <div class="form-group">
              <label class="form-label">Username</label>
              <input type="text" class="form-input" id="grant-username" value="${defaultUsername}" required>
            </div>

            <div class="form-group">
              <label class="form-label">Temporary Initial Password</label>
              <input type="text" class="form-input" id="grant-password" value="${defaultPassword}" required>
              <p style="font-size: 0.75rem; color: #64748b; margin-top: 0.25rem;">
                Share this initial password with ${emp.name}.
              </p>
            </div>

            <div class="form-group">
              <label class="form-label">Access Role</label>
              <select class="form-select" id="grant-role">
                <option value="staff" selected>Staff Member (Can view shifts & punch clock)</option>
                <option value="admin">Manager / Admin (Full rota editing & settings)</option>
              </select>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-secondary" id="btn-cancel-grant">Cancel</button>
            <button class="btn btn-primary" id="btn-save-grant">Grant Access</button>
          </div>
        </div>
      </div>
    `;
  }

  // Render Must Change Password Modal
  function renderMustChangePasswordModal() {
    if (!state.showMustChangePasswordModal) return "";

    return `
      <div class="modal-overlay" id="must-change-modal-overlay">
        <div class="modal-content" style="max-width: 400px;">
          <div class="modal-header">
            <h3 class="modal-title">🔒 Set Your New Password</h3>
          </div>
          <div class="modal-body">
            <p style="font-size: 0.825rem; color: #64748b; margin-bottom: 1rem;">
              You signed in with a temporary One-Time Password. Please choose your new permanent password to continue.
            </p>
            <div class="form-group">
              <label class="form-label">New Password</label>
              <input type="password" class="form-input" id="must-new-password" placeholder="••••••••" required autofocus>
            </div>
            <div class="form-group">
              <label class="form-label">Confirm New Password</label>
              <input type="password" class="form-input" id="must-confirm-password" placeholder="••••••••" required>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" id="btn-save-must-change" style="width: 100%;">
              Save Password & Enter Rota
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Render Settings & Preferences Modal
  function renderSettingsModal() {
    if (!state.showSettingsModal) return "";
    const s = state.data.settings;
    const user = state.currentUser || {};
    const isAdmin = user.role === "admin";
    const currentUrl = window.location.origin;

    return `
      <div class="modal-overlay" id="settings-modal-overlay">
        <div class="modal-content" style="max-width: 480px;">
          <div class="modal-header">
            <h3 class="modal-title">⚙️ Settings & Preferences</h3>
            <button class="modal-close" id="btn-close-settings">&times;</button>
          </div>

          <div class="modal-body">
            <!-- 1. Theme Selection -->
            <div class="settings-section-card">
              <div class="settings-section-title">🎨 Appearance Theme</div>
              <div class="segmented-control" id="theme-toggle-group">
                <button type="button" class="segmented-option ${state.theme === "light" ? "active" : ""}" data-theme-val="light">
                  ☀️ Light
                </button>
                <button type="button" class="segmented-option ${state.theme === "dark" ? "active" : ""}" data-theme-val="dark">
                  🌙 Dark
                </button>
              </div>
            </div>

            <!-- 2. Time Format -->
            <div class="settings-section-card">
              <div class="settings-section-title">🕒 Time Format</div>
              <div class="segmented-control" id="time-format-toggle-group">
                <button type="button" class="segmented-option ${state.timeFormat === "12h" ? "active" : ""}" data-time-val="12h">
                  12-Hour (9:00 AM – 10:00 PM)
                </button>
                <button type="button" class="segmented-option ${state.timeFormat === "24h" ? "active" : ""}" data-time-val="24h">
                  24-Hour (09:00 – 22:00)
                </button>
              </div>
            </div>

            <!-- 3. Account Credentials -->
            <div class="settings-section-card">
              <div class="settings-section-title">👤 My Account Details</div>
              <div class="form-group">
                <label class="form-label">Username</label>
                <input type="text" class="form-input" id="set-account-username" value="${user.username || ""}" placeholder="Enter new username">
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">New Password</label>
                  <input type="password" class="form-input" id="set-account-password" placeholder="Leave blank to keep">
                </div>
                <div class="form-group">
                  <label class="form-label">Confirm Password</label>
                  <input type="password" class="form-input" id="set-account-confirm-password" placeholder="Confirm new password">
                </div>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-save-account-credentials" style="margin-top: 0.25rem; width: 100%;">
                Update Account Credentials
              </button>
            </div>

            <!-- 4. Share Rota Link -->
            <div class="settings-section-card">
              <div class="settings-section-title">🔗 Share Rota with Team</div>
              <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.6rem;">
                Send this link to your team so they can log in and view their shifts:
              </p>
              <div style="display: flex; gap: 8px;">
                <input type="text" class="form-input" readonly value="${currentUrl}" id="settings-share-url" style="font-family: monospace; font-size: 0.825rem;">
                <button type="button" class="btn btn-primary btn-sm" id="btn-settings-copy-url" style="white-space: nowrap;">
                  📋 Copy
                </button>
              </div>
            </div>

            ${
              isAdmin
                ? `
              <!-- 5. Business Settings (Admin Only) -->
              <div class="settings-section-card">
                <div class="settings-section-title">🏢 Business & Currency</div>
                <div class="form-row">
                  <div class="form-group">
                    <label class="form-label">Venue / Business Name</label>
                    <input type="text" class="form-input" id="set-business-name" value="${s.businessName || "Tudor Local"}">
                  </div>
                  <div class="form-group">
                    <label class="form-label">Currency Symbol</label>
                    <select class="form-select" id="set-currency">
                      <option value="£" ${s.currency === "£" ? "selected" : ""}>£ (GBP)</option>
                      <option value="$" ${s.currency === "$" ? "selected" : ""}>$ (USD)</option>
                      <option value="€" ${s.currency === "€" ? "selected" : ""}>€ (EUR)</option>
                      <option value="C$" ${s.currency === "C$" ? "selected" : ""}>C$ (CAD)</option>
                      <option value="A$" ${s.currency === "A$" ? "selected" : ""}>A$ (AUD)</option>
                      <option value="₹" ${s.currency === "₹" ? "selected" : ""}>₹ (INR)</option>
                    </select>
                  </div>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-save-business-details" style="width: 100%;">
                  Save Business Details
                </button>
              </div>

              <!-- 6. Clear All Shifts Tool -->
              <div style="border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
                <button class="btn btn-danger-outline btn-sm" id="btn-action-clear-shifts" style="width: 100%; justify-content: center;">
                  🧹 Clear All Shifts (Keep Staff & Logins)
                </button>
              </div>
            `
                : ""
            }
          </div>

          <div class="modal-footer">
            <button class="btn btn-primary" id="btn-done-settings" style="min-width: 100px;">Done</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderInstallModal() {
    return "";
  }

  function renderShareModal() {
    return "";
  }

  // Render Shift Modal
  function renderShiftModal() {
    if (!state.editingShift) return "";
    const shift = state.editingShift;
    const isNew = !shift.id || shift.isNew;
    const currency = state.data.settings.currency || "£";

    const empOptions = [
      `<option value="" ${!shift.employeeId ? "selected" : ""}>-- Open / Unassigned Shift --</option>`
    ]
      .concat(
        (state.data.employees || []).map(
          e => `<option value="${e.id}" ${shift.employeeId === e.id ? "selected" : ""}>${e.name} (${e.role})</option>`
        )
      )
      .join("");

    const deptOptions = (state.data.departments || [])
      .map(
        d => `<option value="${d.id}" ${shift.departmentId === d.id ? "selected" : ""}>${d.name}</option>`
      )
      .join("");

    const conflicts = checkShiftConflicts(shift, shift.id);
    const netHours = calculateNetHours(shift.startTime, shift.endTime, shift.breakMinutes);
    const rate = shift.rate || (shift.employeeId ? ((state.data.employees || []).find(e => e.id === shift.employeeId) || {}).hourlyRate : 10) || 10;
    const estCost = (netHours * rate).toFixed(2);

    return `
      <div class="modal-overlay" id="shift-modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">${isNew ? "Add Shift" : "Edit Shift"}</h3>
            <button class="modal-close" id="modal-close-btn">&times;</button>
          </div>

          <div class="modal-body">
            ${
              conflicts.length > 0
                ? `
              <div class="alert-box alert-warning">
                <div>⚠️</div>
                <div>
                  <strong>Scheduling Conflict Detected:</strong>
                  <ul style="margin-left:16px;margin-top:4px;">
                    ${conflicts.map(c => `<li>${c}</li>`).join("")}
                  </ul>
                </div>
              </div>
            `
                : ""
            }

            <div class="form-group">
              <label class="form-label">Assigned Employee</label>
              <select class="form-select" id="shift-employee-input">
                ${empOptions}
              </select>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Department</label>
                <select class="form-select" id="shift-department-input">
                  ${deptOptions}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Role / Position</label>
                <input type="text" class="form-input" id="shift-role-input" value="${shift.role || "Staff Member"}">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Date</label>
                <input type="date" class="form-input" id="shift-date-input" value="${shift.date}">
              </div>
              <div class="form-group">
                <label class="form-label">Unpaid Break (Minutes)</label>
                <input type="number" class="form-input" id="shift-break-input" value="${shift.breakMinutes || 0}" min="0" step="5">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Start Time</label>
                <input type="time" class="form-input" id="shift-start-input" value="${shift.startTime || "09:00"}">
              </div>
              <div class="form-group">
                <label class="form-label">End Time</label>
                <input type="time" class="form-input" id="shift-end-input" value="${shift.endTime || "17:00"}">
              </div>
            </div>

            <div class="shift-calc-preview">
              <div>
                <div class="calc-item-label">Net Working Hours</div>
                <div class="calc-item-val" id="calc-preview-hours">${netHours} hrs</div>
              </div>
              <div style="text-align:right;">
                <div class="calc-item-label">Estimated Labor Cost</div>
                <div class="calc-item-val" id="calc-preview-cost">${currency}${estCost}</div>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Hourly Rate (${currency})</label>
                <input type="number" class="form-input" id="shift-rate-input" value="${rate}" step="0.5">
              </div>
              <div class="form-group">
                <label class="form-label">Status</label>
                <select class="form-select" id="shift-status-input">
                  <option value="draft" ${shift.status === "draft" ? "selected" : ""}>Draft (Private)</option>
                  <option value="published" ${shift.status === "published" ? "selected" : ""}>Published (Live for staff)</option>
                  <option value="open" ${shift.status === "open" ? "selected" : ""}>Open Shift (Claimable)</option>
                </select>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Shift Notes & Instructions</label>
              <textarea class="form-textarea" id="shift-notes-input" rows="2" placeholder="e.g. Opening register, floor lead...">${shift.notes || ""}</textarea>
            </div>
          </div>

          <div class="modal-footer">
            ${
              !isNew
                ? `<button class="btn btn-danger-outline" id="btn-delete-shift" style="margin-right:auto;">Delete Shift</button>`
                : ""
            }
            <button class="btn btn-secondary" id="btn-cancel-modal">Cancel</button>
            <button class="btn btn-primary" id="btn-save-shift">Save Shift</button>
          </div>
        </div>
      </div>
    `;
  }

  // Render Employee Modal
  function renderEmployeeModal() {
    if (!state.editingEmployee) return "";
    const emp = state.editingEmployee;
    const isNew = !emp.id || emp.isNew;
    const currency = state.data.settings.currency || "£";

    const deptOptions = (state.data.departments || [])
      .map(d => `<option value="${d.id}" ${emp.departmentId === d.id ? "selected" : ""}>${d.name}</option>`)
      .join("");

    return `
      <div class="modal-overlay" id="emp-modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">${isNew ? "Add Staff Member" : "Edit Staff Member"}</h3>
            <button class="modal-close" id="emp-modal-close-btn">&times;</button>
          </div>

          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Full Name</label>
              <input type="text" class="form-input" id="emp-name-input" value="${emp.name || ""}" placeholder="e.g. John Smith">
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Department</label>
                <select class="form-select" id="emp-dept-input">
                  ${deptOptions}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Primary Role</label>
                <input type="text" class="form-input" id="emp-role-input" value="${emp.role || ""}" placeholder="Staff Member">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Hourly Wage (${currency})</label>
                <input type="number" class="form-input" id="emp-rate-input" value="${emp.hourlyRate || 10}" step="0.5">
              </div>
              <div class="form-group">
                <label class="form-label">Contracted Hours / Wk</label>
                <input type="number" class="form-input" id="emp-hours-input" value="${emp.contractedHours || 35}">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Email</label>
                <input type="email" class="form-input" id="emp-email-input" value="${emp.email || ""}" placeholder="email@example.com">
              </div>
              <div class="form-group">
                <label class="form-label">Phone</label>
                <input type="text" class="form-input" id="emp-phone-input" value="${emp.phone || ""}">
              </div>
            </div>
          </div>

          <div class="modal-footer">
            ${
              !isNew
                ? `<button class="btn btn-danger-outline" id="btn-delete-employee" style="margin-right:auto;">Remove</button>`
                : ""
            }
            <button class="btn btn-secondary" id="btn-cancel-emp-modal">Cancel</button>
            <button class="btn btn-primary" id="btn-save-employee">Save Staff</button>
          </div>
        </div>
      </div>
    `;
  }

  // Master Render Function
  function renderApp() {
    const root = document.getElementById("app-root");
    if (!root) return;

    // 1. If not authenticated, render Login/Auth Screen
    if (!state.currentUser) {
      root.innerHTML = renderAuthScreen();
      bindAuthEvents();
      return;
    }

    // 2. Main Authenticated Application
    let mainContentHtml = "";
    if (state.activeTab === "staff" && state.currentUser && state.currentUser.role === "admin") {
      mainContentHtml = renderStaffTab();
    } else {
      mainContentHtml = `
        ${renderAdminResetBanner()}
        ${renderRotaControls()}
        ${renderScheduleGrid()}
      `;
    }

    root.innerHTML = `
      ${renderHeader()}
      <main class="app-main">
        ${mainContentHtml}
      </main>
      ${renderShiftModal()}
      ${renderEmployeeModal()}
      ${renderSettingsModal()}
      ${renderGrantAccessModal()}
      ${renderOtpModal()}
      ${renderMustChangePasswordModal()}
    `;

    bindEvents();
  }

  // Event Listeners for Authentication Screen
  function bindAuthEvents() {
    // Switch to forgot password
    const linkForgot = document.getElementById("link-forgot-password");
    if (linkForgot) {
      linkForgot.addEventListener("click", e => {
        e.preventDefault();
        state.authView = "forgot";
        state.authError = "";
        state.authSuccess = "";
        renderApp();
      });
    }

    // Back to login
    const linkBack = document.getElementById("link-back-login");
    if (linkBack) {
      linkBack.addEventListener("click", e => {
        e.preventDefault();
        state.authView = "login";
        state.authError = "";
        state.authSuccess = "";
        renderApp();
      });
    }

    // Go to OTP login
    const btnGotoOtp = document.getElementById("btn-goto-otp-login");
    if (btnGotoOtp) {
      btnGotoOtp.addEventListener("click", () => {
        state.authView = "reset_otp";
        state.authError = "";
        renderApp();
      });
    }

    // Submit Login
    const formLogin = document.getElementById("form-login");
    if (formLogin) {
      formLogin.addEventListener("submit", async e => {
        e.preventDefault();
        const username = document.getElementById("login-username").value.trim().toLowerCase();
        const password = document.getElementById("login-password").value;

        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();

          if (data.success) {
            state.currentUser = data.user;
            localStorage.setItem("tudor_rota_user", JSON.stringify(data.user));
            state.authError = "";
            if (data.mustChangePassword) {
              state.showMustChangePasswordModal = true;
            }
            renderApp();
            showToast(`Welcome back, ${data.user.name || data.user.username}!`);
          } else {
            state.authError = data.error || "Login failed.";
            renderApp();
          }
        } catch (err) {
          // Client-side fallback check
          const pwHash = await sha256(password);
          const user = (state.data.users || []).find(u => u.username.toLowerCase() === username);

          if (user && (user.passwordHash === pwHash || user.password === password || user.tempPassword === password)) {
            if (!user.hasRotaAccess || !user.isActive) {
              state.authError = "Access denied. Rota access has not been granted by your manager.";
              renderApp();
              return;
            }
            state.currentUser = user;
            localStorage.setItem("tudor_rota_user", JSON.stringify(user));
            if (user.tempPassword === password || user.mustChangePassword) {
              state.showMustChangePasswordModal = true;
            }
            renderApp();
            showToast(`Welcome, ${user.name || user.username}!`);
          } else {
            state.authError = "Invalid username or password.";
            renderApp();
          }
        }
      });
    }

    // Submit Forgot Password Request
    const formForgot = document.getElementById("form-forgot-request");
    if (formForgot) {
      formForgot.addEventListener("submit", async e => {
        e.preventDefault();
        const username = document.getElementById("forgot-username").value.trim().toLowerCase();

        try {
          const res = await fetch("/api/auth/forgot-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username })
          });
          const data = await res.json();
          if (data.success) {
            state.authSuccess = data.message;
            state.authError = "";
            renderApp();
          } else {
            state.authError = data.error || "Request failed.";
            renderApp();
          }
        } catch (err) {
          // Offline fallback
          const user = (state.data.users || []).find(u => u.username.toLowerCase() === username);
          if (user) {
            state.data.resetRequests.unshift({
              id: "reset_" + Date.now(),
              userId: user.id,
              username: user.username,
              name: user.name || user.username,
              requestedAt: new Date().toLocaleString(),
              status: "pending"
            });
            await saveData();
            state.authSuccess = `Password reset request submitted for ${user.name || username}! Your manager has been notified.`;
            state.authError = "";
          } else {
            state.authError = "Username not found. Please contact your manager.";
          }
          renderApp();
        }
      });
    }

    // Submit OTP Login
    const formOtp = document.getElementById("form-otp-login");
    if (formOtp) {
      formOtp.addEventListener("submit", async e => {
        e.preventDefault();
        const username = document.getElementById("otp-login-username").value.trim().toLowerCase();
        const code = document.getElementById("otp-login-code").value.trim().toUpperCase();

        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password: code })
          });
          const data = await res.json();
          if (data.success) {
            state.currentUser = data.user;
            localStorage.setItem("tudor_rota_user", JSON.stringify(data.user));
            state.showMustChangePasswordModal = true;
            state.authError = "";
            renderApp();
          } else {
            state.authError = "Invalid One-Time Password or username.";
            renderApp();
          }
        } catch (err) {
          const user = (state.data.users || []).find(u => u.username.toLowerCase() === username);
          if (user && user.tempPassword === code) {
            state.currentUser = user;
            localStorage.setItem("tudor_rota_user", JSON.stringify(user));
            state.showMustChangePasswordModal = true;
            state.authError = "";
            renderApp();
          } else {
            state.authError = "Invalid One-Time Password or username.";
            renderApp();
          }
        }
      });
    }
  }

  // Event Listeners for Authenticated Application
  function bindEvents() {
    const isAdmin = state.currentUser && state.currentUser.role === "admin";

    // Profile Circle Button toggle
    const profileToggleBtn = document.getElementById("btn-profile-toggle");
    const profileDropdown = document.getElementById("profile-dropdown");
    if (profileToggleBtn && profileDropdown) {
      profileToggleBtn.addEventListener("click", e => {
        e.stopPropagation();
        state.showProfileMenu = !state.showProfileMenu;
        profileDropdown.classList.toggle("hidden", !state.showProfileMenu);
      });
    }

    // Open Settings from Profile Menu
    const menuSettingsBtn = document.getElementById("menu-open-settings");
    if (menuSettingsBtn) {
      menuSettingsBtn.addEventListener("click", () => {
        state.showProfileMenu = false;
        state.showSettingsModal = true;
        renderApp();
      });
    }

    // Logout from Profile Menu
    const menuLogoutBtn = document.getElementById("menu-logout");
    if (menuLogoutBtn) {
      menuLogoutBtn.addEventListener("click", () => {
        state.currentUser = null;
        state.showProfileMenu = false;
        localStorage.removeItem("tudor_rota_user");
        state.authView = "login";
        renderApp();
        showToast("Signed out successfully.");
      });
    }

    // Close profile dropdown on document click
    document.addEventListener("click", e => {
      if (state.showProfileMenu && !e.target.closest(".profile-menu-container")) {
        state.showProfileMenu = false;
        const menu = document.getElementById("profile-dropdown");
        if (menu) menu.classList.add("hidden");
      }
    });

    // Tab switching
    document.querySelectorAll(".nav-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        state.activeTab = tab.dataset.tab;
        renderApp();
      });
    });

    // Date navigation
    const prevBtn = document.getElementById("btn-prev-week");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        const d = new Date(state.currentMonday);
        d.setDate(d.getDate() - 7);
        state.currentMonday = d;
        renderApp();
      });
    }

    const nextBtn = document.getElementById("btn-next-week");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        const d = new Date(state.currentMonday);
        d.setDate(d.getDate() + 7);
        state.currentMonday = d;
        renderApp();
      });
    }

    const todayBtn = document.getElementById("btn-today");
    if (todayBtn) {
      todayBtn.addEventListener("click", () => {
        state.currentMonday = getMonday(new Date());
        renderApp();
      });
    }

    // View toggles
    const toggleEmp = document.getElementById("toggle-group-employee");
    if (toggleEmp) {
      toggleEmp.addEventListener("click", () => {
        state.groupingMode = "employee";
        renderApp();
      });
    }

    const toggleDept = document.getElementById("toggle-group-dept");
    if (toggleDept) {
      toggleDept.addEventListener("click", () => {
        state.groupingMode = "department";
        renderApp();
      });
    }

    // Filter by department
    const deptFilter = document.getElementById("dept-filter");
    if (deptFilter) {
      deptFilter.addEventListener("change", e => {
        state.selectedDepartment = e.target.value;
        renderApp();
      });
    }

    // Search input
    const searchFilter = document.getElementById("search-filter");
    if (searchFilter) {
      searchFilter.addEventListener("input", e => {
        state.searchQuery = e.target.value;
        renderApp();
        const ref = document.getElementById("search-filter");
        if (ref) {
          ref.focus();
          ref.setSelectionRange(ref.value.length, ref.value.length);
        }
      });
    }

    // Generate OTP from Admin Alert Banner
    document.querySelectorAll(".btn-generate-otp-banner").forEach(btn => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userId;
        await generateOtpForUser(userId);
      });
    });

    // Generate OTP from Staff Roster
    document.querySelectorAll(".btn-generate-otp").forEach(btn => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userId;
        await generateOtpForUser(userId);
      });
    });

    // Grant Access button in Staff Roster
    document.querySelectorAll(".btn-grant-access").forEach(btn => {
      btn.addEventListener("click", () => {
        const empId = btn.dataset.empId;
        const emp = (state.data.employees || []).find(e => e.id === empId);
        if (emp) {
          state.showGrantAccessModal = emp;
          renderApp();
        }
      });
    });

    // Toggle Access (Revoke/Enable) in Staff Roster
    document.querySelectorAll(".btn-toggle-access").forEach(btn => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userId;
        const currentAccess = btn.dataset.current === "true";
        const newAccess = !currentAccess;

        try {
          const res = await fetch("/api/auth/toggle-access", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, hasRotaAccess: newAccess })
          });
          const data = await res.json();
          if (data.success) {
            const user = (state.data.users || []).find(u => u.id === userId);
            if (user) user.hasRotaAccess = newAccess;
            await saveData();
            showToast(data.message);
          }
        } catch (e) {
          const user = (state.data.users || []).find(u => u.id === userId);
          if (user) {
            user.hasRotaAccess = newAccess;
            user.isActive = newAccess;
            await saveData();
            showToast(`Access ${newAccess ? "granted" : "revoked"}!`);
          }
        }
      });
    });

    // Grant Access Modal Save
    const saveGrantBtn = document.getElementById("btn-save-grant");
    if (saveGrantBtn) {
      saveGrantBtn.addEventListener("click", async () => {
        const emp = state.showGrantAccessModal;
        const username = document.getElementById("grant-username").value.trim().toLowerCase();
        const password = document.getElementById("grant-password").value.trim();
        const role = document.getElementById("grant-role").value;

        if (!username || !password) {
          alert("Please provide username and initial password.");
          return;
        }

        try {
          const res = await fetch("/api/auth/grant-access", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              employeeId: emp.id,
              username,
              password,
              role
            })
          });
          const data = await res.json();
          if (data.success) {
            state.showGrantAccessModal = null;
            await loadData();
            showToast(data.message);
          } else {
            alert(data.error || "Failed to grant access.");
          }
        } catch (err) {
          // Client fallback
          const pwHash = await sha256(password);
          let user = (state.data.users || []).find(u => u.employeeId === emp.id);
          if (user) {
            user.username = username;
            user.passwordHash = pwHash;
            user.hasRotaAccess = true;
            user.role = role;
          } else {
            user = {
              id: "user_" + Date.now(),
              username,
              passwordHash: pwHash,
              role,
              employeeId: emp.id,
              name: emp.name,
              hasRotaAccess: true,
              isActive: true,
              mustChangePassword: false
            };
            if (!state.data.users) state.data.users = [];
            state.data.users.push(user);
          }
          state.showGrantAccessModal = null;
          await saveData();
          showToast(`Rota access granted to ${emp.name}!`);
        }
      });
    }

    const cancelGrantBtn = document.getElementById("btn-cancel-grant");
    const closeGrantBtn = document.getElementById("btn-close-grant-modal");
    if (cancelGrantBtn) cancelGrantBtn.addEventListener("click", () => { state.showGrantAccessModal = null; renderApp(); });
    if (closeGrantBtn) closeGrantBtn.addEventListener("click", () => { state.showGrantAccessModal = null; renderApp(); });

    // OTP Modal close & copy
    const closeOtpBtn = document.getElementById("btn-close-otp-modal");
    if (closeOtpBtn) closeOtpBtn.addEventListener("click", () => { state.showOtpModal = null; renderApp(); });

    const copyOtpBtn = document.getElementById("btn-copy-otp");
    if (copyOtpBtn) {
      copyOtpBtn.addEventListener("click", () => {
        const code = document.getElementById("display-otp-code").innerText.trim();
        navigator.clipboard.writeText(code);
        state.showOtpModal = null;
        renderApp();
        showToast("One-Time Password copied to clipboard!");
      });
    }

    // Must Change Password Modal save
    const saveMustChangeBtn = document.getElementById("btn-save-must-change");
    if (saveMustChangeBtn) {
      saveMustChangeBtn.addEventListener("click", async () => {
        const newPw = document.getElementById("must-new-password").value;
        const confirmPw = document.getElementById("must-confirm-password").value;

        if (newPw.length < 4) {
          alert("Password must be at least 4 characters long.");
          return;
        }
        if (newPw !== confirmPw) {
          alert("Passwords do not match.");
          return;
        }

        const userId = state.currentUser.id;
        try {
          const res = await fetch("/api/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, newPassword: newPw })
          });
          const data = await res.json();
          if (data.success) {
            state.showMustChangePasswordModal = false;
            state.currentUser.mustChangePassword = false;
            state.currentUser.tempPassword = null;
            localStorage.setItem("tudor_rota_user", JSON.stringify(state.currentUser));
            renderApp();
            showToast("Password updated successfully! Welcome to your rota.");
          } else {
            alert(data.error || "Failed to update password.");
          }
        } catch (e) {
          const user = (state.data.users || []).find(u => u.id === userId);
          if (user) {
            user.passwordHash = await sha256(newPw);
            user.tempPassword = null;
            user.mustChangePassword = false;
            await saveData();
          }
          state.showMustChangePasswordModal = false;
          renderApp();
          showToast("New password saved!");
        }
      });
    }

    // Settings Modal: Theme toggle
    document.querySelectorAll("#theme-toggle-group .segmented-option").forEach(btn => {
      btn.addEventListener("click", () => {
        const themeVal = btn.dataset.themeVal;
        state.theme = themeVal;
        localStorage.setItem("tudor_theme", themeVal);
        document.documentElement.setAttribute("data-theme", themeVal);
        renderApp();
        showToast(`Theme changed to ${themeVal === "dark" ? "Dark Mode 🌙" : "Light Mode ☀️"}`);
      });
    });

    // Settings Modal: Time Format toggle
    document.querySelectorAll("#time-format-toggle-group .segmented-option").forEach(btn => {
      btn.addEventListener("click", () => {
        const formatVal = btn.dataset.timeVal;
        state.timeFormat = formatVal;
        localStorage.setItem("tudor_time_format", formatVal);
        renderApp();
        showToast(`Time format set to ${formatVal === "12h" ? "12-Hour" : "24-Hour"}`);
      });
    });

    // Settings Modal: Update Account Credentials (Username & Password)
    const saveAccountBtn = document.getElementById("btn-save-account-credentials");
    if (saveAccountBtn) {
      saveAccountBtn.addEventListener("click", async () => {
        const username = document.getElementById("set-account-username").value.trim().toLowerCase();
        const password = document.getElementById("set-account-password").value.trim();
        const confirmPw = document.getElementById("set-account-confirm-password").value.trim();

        if (!username) {
          alert("Username cannot be empty.");
          return;
        }

        if (password && password !== confirmPw) {
          alert("Passwords do not match.");
          return;
        }

        if (password && password.length < 4) {
          alert("Password must be at least 4 characters long.");
          return;
        }

        try {
          const res = await fetch("/api/auth/update-account", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: state.currentUser.id,
              username,
              password
            })
          });
          const data = await res.json();
          if (data.success) {
            state.currentUser = data.user;
            localStorage.setItem("tudor_rota_user", JSON.stringify(data.user));
            const u = (state.data.users || []).find(x => x.id === data.user.id);
            if (u) {
              u.username = data.user.username;
              if (password) u.passwordHash = await sha256(password);
            }
            renderApp();
            showToast("Account credentials updated successfully!");
          } else {
            alert(data.error || "Failed to update account.");
          }
        } catch (e) {
          if (username) state.currentUser.username = username;
          localStorage.setItem("tudor_rota_user", JSON.stringify(state.currentUser));
          renderApp();
          showToast("Account credentials updated!");
        }
      });
    }

    // Settings Modal: Copy Share Link
    const copySettingsUrlBtn = document.getElementById("btn-settings-copy-url");
    if (copySettingsUrlBtn) {
      copySettingsUrlBtn.addEventListener("click", () => {
        const inp = document.getElementById("settings-share-url");
        if (inp) {
          navigator.clipboard.writeText(inp.value);
          showToast("Rota link copied to clipboard!");
        }
      });
    }

    // Settings Modal: Save Business Details (Admin only)
    const saveBusinessBtn = document.getElementById("btn-save-business-details");
    if (saveBusinessBtn) {
      saveBusinessBtn.addEventListener("click", async () => {
        const name = document.getElementById("set-business-name").value.trim() || "Tudor Local";
        const curr = document.getElementById("set-currency").value;
        state.data.settings.businessName = name;
        state.data.settings.currency = curr;
        await saveData();
        showToast("Business details updated!");
      });
    }

    // Settings Modal: Close & Done
    const closeSettingsBtn = document.getElementById("btn-close-settings");
    const doneSettingsBtn = document.getElementById("btn-done-settings");
    if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", () => { state.showSettingsModal = false; renderApp(); });
    if (doneSettingsBtn) doneSettingsBtn.addEventListener("click", () => { state.showSettingsModal = false; renderApp(); });

    // Clear All Shifts Action
    const clearShiftsBtn = document.getElementById("btn-action-clear-shifts");
    if (clearShiftsBtn) {
      clearShiftsBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to remove all shifts? Staff and logins will be kept.")) return;
        state.data.shifts = [];
        state.showSettingsModal = false;
        await saveData();
        showToast("All shifts removed. Rota schedule is clear!");
      });
    }

    // Publish Rota
    const publishBtn = document.getElementById("btn-publish-rota");
    if (publishBtn) {
      publishBtn.addEventListener("click", async () => {
        const weekDates = getWeekDates().map(formatDate);
        let count = 0;
        (state.data.shifts || []).forEach(s => {
          if (weekDates.includes(s.date) && s.status === "draft") {
            s.status = "published";
            count++;
          }
        });
        await saveData();
        showToast(`Published ${count} shift(s)! Employees have been notified.`, "success");
      });
    }

    // Add Shift header
    const addHeaderBtn = document.getElementById("btn-add-shift-header");
    if (addHeaderBtn) {
      addHeaderBtn.addEventListener("click", () => {
        const firstEmp = (state.data.employees || [])[0];
        openShiftModal({
          isNew: true,
          date: formatDate(state.currentMonday),
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 0,
          role: firstEmp ? firstEmp.role : "Staff Member",
          departmentId: state.data.departments[0]?.id || "general",
          status: firstEmp ? "draft" : "open",
          employeeId: firstEmp ? firstEmp.id : null,
          rate: firstEmp ? firstEmp.hourlyRate : 10.0
        });
      });
    }

    // Cell Add Shift Buttons (Admin only)
    document.querySelectorAll(".btn-cell-add").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const empId = btn.dataset.empId || null;
        const date = btn.dataset.date;
        const deptId = btn.dataset.deptId || (empId ? ((state.data.employees || []).find(x => x.id === empId) || {}).departmentId : "general");
        const emp = (state.data.employees || []).find(x => x.id === empId);

        openShiftModal({
          isNew: true,
          date: date,
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 0,
          role: emp ? emp.role : "Staff Member",
          departmentId: deptId,
          status: empId ? "draft" : "open",
          employeeId: empId,
          rate: emp ? emp.hourlyRate : 10.0
        });
      });
    });

    // Edit Shift on card click
    document.querySelectorAll(".shift-card").forEach(card => {
      card.addEventListener("click", e => {
        if (e.target.closest(".btn-claim-shift") || e.target.closest(".btn-request-claim")) return;
        const shiftId = card.dataset.shiftId;
        const shift = (state.data.shifts || []).find(s => s.id === shiftId);
        if (shift && isAdmin) {
          openShiftModal(JSON.parse(JSON.stringify(shift)));
        }
      });
    });

    // Claim / Assign Open Shift
    document.querySelectorAll(".btn-claim-shift").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const shiftId = btn.dataset.shiftId;
        const shift = (state.data.shifts || []).find(s => s.id === shiftId);
        if (shift) {
          openShiftModal(JSON.parse(JSON.stringify(shift)));
        }
      });
    });

    // Staff Claim open shift request
    document.querySelectorAll(".btn-request-claim").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const shiftId = btn.dataset.shiftId;
        const myEmpId = state.currentUser ? state.currentUser.employeeId : null;
        if (!myEmpId) {
          alert("Your user account is not linked to an employee profile.");
          return;
        }
        const shift = (state.data.shifts || []).find(s => s.id === shiftId);
        if (shift) {
          shift.employeeId = myEmpId;
          shift.status = "draft";
          await saveData();
          showToast("You claimed this shift! Pending manager sign-off.");
        }
      });
    });

    // Shift Modal Controls
    const closeShiftModal = () => {
      state.editingShift = null;
      renderApp();
    };

    const modalCloseBtn = document.getElementById("modal-close-btn");
    const cancelModalBtn = document.getElementById("btn-cancel-modal");
    if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeShiftModal);
    if (cancelModalBtn) cancelModalBtn.addEventListener("click", closeShiftModal);

    // Dynamic calculation updates inside Shift Modal
    const startInput = document.getElementById("shift-start-input");
    const endInput = document.getElementById("shift-end-input");
    const breakInput = document.getElementById("shift-break-input");
    const rateInput = document.getElementById("shift-rate-input");
    const empInput = document.getElementById("shift-employee-input");

    const updateModalPreview = () => {
      if (!startInput || !endInput) return;
      const s = startInput.value;
      const e = endInput.value;
      const b = Number(breakInput?.value || 0);
      const r = Number(rateInput?.value || 0);
      const net = calculateNetHours(s, e, b);
      const cost = (net * r).toFixed(2);

      const previewHours = document.getElementById("calc-preview-hours");
      const previewCost = document.getElementById("calc-preview-cost");
      const currency = state.data.settings.currency || "£";

      if (previewHours) previewHours.textContent = `${net} hrs`;
      if (previewCost) previewCost.textContent = `${currency}${cost}`;
    };

    [startInput, endInput, breakInput, rateInput].forEach(inp => {
      if (inp) inp.addEventListener("input", updateModalPreview);
    });

    if (empInput) {
      empInput.addEventListener("change", e => {
        const empId = e.target.value;
        const emp = (state.data.employees || []).find(x => x.id === empId);
        if (emp) {
          if (rateInput) rateInput.value = emp.hourlyRate;
          const roleInput = document.getElementById("shift-role-input");
          if (roleInput && !roleInput.value) roleInput.value = emp.role;
          const deptInput = document.getElementById("shift-department-input");
          if (deptInput) deptInput.value = emp.departmentId;
        }
        updateModalPreview();
      });
    }

    // Save Shift
    const saveShiftBtn = document.getElementById("btn-save-shift");
    if (saveShiftBtn) {
      saveShiftBtn.addEventListener("click", async () => {
        const empId = document.getElementById("shift-employee-input").value || null;
        const deptId = document.getElementById("shift-department-input").value;
        const role = document.getElementById("shift-role-input").value.trim();
        const date = document.getElementById("shift-date-input").value;
        const startTime = document.getElementById("shift-start-input").value;
        const endTime = document.getElementById("shift-end-input").value;
        const breakMinutes = Number(document.getElementById("shift-break-input").value || 0);
        const rate = Number(document.getElementById("shift-rate-input").value || 0);
        const notes = document.getElementById("shift-notes-input").value.trim();
        const status = document.getElementById("shift-status-input").value;

        if (!date || !startTime || !endTime) {
          alert("Please fill in Date, Start Time, and End Time.");
          return;
        }

        const shiftPayload = {
          id: state.editingShift.id || "shift_" + Date.now(),
          employeeId: empId,
          departmentId: deptId,
          role: role || "Staff",
          date,
          startTime,
          endTime,
          breakMinutes,
          rate,
          notes,
          status: empId === null ? "open" : status
        };

        if (state.editingShift.isNew) {
          if (!state.data.shifts) state.data.shifts = [];
          state.data.shifts.push(shiftPayload);
        } else {
          const index = state.data.shifts.findIndex(s => s.id === state.editingShift.id);
          if (index !== -1) {
            state.data.shifts[index] = shiftPayload;
          }
        }

        state.editingShift = null;
        await saveData();
        showToast("Shift saved successfully!");
      });
    }

    // Delete Shift
    const deleteShiftBtn = document.getElementById("btn-delete-shift");
    if (deleteShiftBtn) {
      deleteShiftBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to delete this shift?")) return;
        state.data.shifts = state.data.shifts.filter(s => s.id !== state.editingShift.id);
        state.editingShift = null;
        await saveData();
        showToast("Shift deleted.", "error");
      });
    }

    // Staff Directory Modal controls
    const addEmpBtn = document.getElementById("btn-add-employee");
    if (addEmpBtn) {
      addEmpBtn.addEventListener("click", () => {
        state.editingEmployee = {
          isNew: true,
          name: "",
          departmentId: state.data.departments[0]?.id || "general",
          role: "Staff Member",
          hourlyRate: 10.0,
          contractedHours: 35,
          email: "",
          phone: ""
        };
        renderApp();
      });
    }

    document.querySelectorAll(".btn-edit-emp").forEach(btn => {
      btn.addEventListener("click", () => {
        const emp = (state.data.employees || []).find(e => e.id === btn.dataset.empId);
        if (emp) {
          state.editingEmployee = JSON.parse(JSON.stringify(emp));
          renderApp();
        }
      });
    });

    const closeEmpModal = () => {
      state.editingEmployee = null;
      renderApp();
    };

    const empCloseBtn = document.getElementById("emp-modal-close-btn");
    const cancelEmpModalBtn = document.getElementById("btn-cancel-emp-modal");
    if (empCloseBtn) empCloseBtn.addEventListener("click", closeEmpModal);
    if (cancelEmpModalBtn) cancelEmpModalBtn.addEventListener("click", closeEmpModal);

    const saveEmpBtn = document.getElementById("btn-save-employee");
    if (saveEmpBtn) {
      saveEmpBtn.addEventListener("click", async () => {
        const name = document.getElementById("emp-name-input").value.trim();
        const deptId = document.getElementById("emp-dept-input").value;
        const role = document.getElementById("emp-role-input").value.trim();
        const rate = Number(document.getElementById("emp-rate-input").value || 10);
        const hours = Number(document.getElementById("emp-hours-input").value || 35);
        const email = document.getElementById("emp-email-input").value.trim();
        const phone = document.getElementById("emp-phone-input").value.trim();

        if (!name) {
          alert("Please enter employee name.");
          return;
        }

        const colors = ["#0ea5e9", "#f59e0b", "#8b5cf6", "#10b981", "#ec4899", "#06b6d4"];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];

        const payload = {
          id: state.editingEmployee.id || "emp_" + Date.now(),
          name,
          departmentId: deptId,
          role: role || "Staff Member",
          hourlyRate: rate,
          contractedHours: hours,
          email,
          phone,
          avatarColor: state.editingEmployee.avatarColor || randomColor,
          availability: state.editingEmployee.availability || {
            mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true
          }
        };

        if (!state.data.employees) state.data.employees = [];

        if (state.editingEmployee.isNew) {
          state.data.employees.push(payload);
        } else {
          const index = state.data.employees.findIndex(e => e.id === state.editingEmployee.id);
          if (index !== -1) state.data.employees[index] = payload;
        }

        state.editingEmployee = null;
        await saveData();
        showToast("Staff member saved!");
      });
    }

    // Delete Employee
    const deleteEmpBtn = document.getElementById("btn-delete-employee");
    if (deleteEmpBtn) {
      deleteEmpBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to remove this employee?")) return;
        const empId = state.editingEmployee.id;
        state.data.employees = state.data.employees.filter(e => e.id !== empId);
        (state.data.shifts || []).forEach(s => {
          if (s.employeeId === empId) {
            s.employeeId = null;
            s.status = "open";
          }
        });
        state.editingEmployee = null;
        await saveData();
        showToast("Employee removed.", "error");
      });
    }

    // Terminal Punch Clock actions
    const terminalClockInBtn = document.getElementById("btn-terminal-clock-in");
    if (terminalClockInBtn) {
      terminalClockInBtn.addEventListener("click", async () => {
        const empSelect = document.getElementById("punch-employee-select");
        const empId = empSelect.value;
        if (!empId) {
          alert("Please select or configure an employee first.");
          return;
        }
        const emp = (state.data.employees || []).find(e => e.id === empId);

        const existing = (state.data.punches || []).find(p => p.employeeId === empId && p.status === "active");
        if (existing) {
          alert(`${emp ? emp.name : "Staff"} is already clocked in.`);
          return;
        }

        if (!state.data.punches) state.data.punches = [];
        state.data.punches.push({
          id: "punch_" + Date.now(),
          employeeId: empId,
          clockIn: new Date().toISOString(),
          clockOut: null,
          breaks: [],
          status: "active"
        });

        await saveData();
        showToast(`${emp ? emp.name : "Staff"} clocked in!`);
      });
    }

    document.querySelectorAll(".btn-clock-out").forEach(btn => {
      btn.addEventListener("click", async () => {
        const punchId = btn.dataset.punchId;
        const punch = (state.data.punches || []).find(p => p.id === punchId);
        if (punch) {
          punch.status = "completed";
          punch.clockOut = new Date().toISOString();
          await saveData();
          showToast("Clocked out successfully!");
        }
      });
    });
  }

  // Generate OTP helper for Admin
  async function generateOtpForUser(userId) {
    try {
      const res = await fetch("/api/auth/generate-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId })
      });
      const data = await res.json();
      if (data.success) {
        state.showOtpModal = {
          name: data.name,
          username: data.username,
          otp: data.otp
        };
        await loadData();
      } else {
        alert(data.error || "Failed to generate OTP.");
      }
    } catch (e) {
      // Offline fallback
      const user = (state.data.users || []).find(u => u.id === userId);
      if (user) {
        const otp = "TL-" + Math.floor(1000 + Math.random() * 9000);
        user.tempPassword = otp;
        user.mustChangePassword = true;
        for (const r of state.data.resetRequests) {
          if (r.userId === userId) {
            r.status = "otp_generated";
            r.otp = otp;
          }
        }
        await saveData();
        state.showOtpModal = {
          name: user.name || user.username,
          username: user.username,
          otp: otp
        };
        renderApp();
      }
    }
  }

  // Open Shift Modal helper
  function openShiftModal(shift) {
    state.editingShift = shift;
    renderApp();
  }

  // Real-time clock updater for Punch terminal
  setInterval(() => {
    const clockEl = document.getElementById("live-digital-clock");
    const dateEl = document.getElementById("live-digital-date");
    if (clockEl) {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString();
      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric"
        });
      }
    }
  }, 1000);

  // Initialize
  document.addEventListener("DOMContentLoaded", () => {
    loadData();
  });
})();
