// Planday Rota Application Core Engine

(function () {
  "use strict";

  // Clean Slate Default Data
  const CLEAN_DATA = {
    settings: {
      currency: "£",
      targetLaborPercentage: 20.0,
      projectedWeeklyRevenue: 0,
      businessName: "My Business"
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
    punches: []
  };

  // Application State
  const state = {
    activeTab: "schedule",
    currentMonday: getMonday(new Date("2026-09-21")),
    groupingMode: "employee", // 'employee' or 'department'
    selectedDepartment: "all",
    searchQuery: "",
    data: JSON.parse(JSON.stringify(CLEAN_DATA)),
    editingShift: null,
    editingEmployee: null,
    showSettingsModal: false,
    showInstallModal: false,
    showShareModal: false
  };

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
        // Ensure structure exists
        if (!state.data.employees) state.data.employees = [];
        if (!state.data.shifts) state.data.shifts = [];
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
        renderApp();
        return;
      } catch (e) {}
    }

    // Direct data.json fetch
    try {
      const res = await fetch("./data.json");
      if (res.ok) {
        state.data = await res.json();
        renderApp();
        return;
      }
    } catch (e) {}

    // Fallback to clean state
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

  // Render Header
  function renderHeader() {
    const pendingRequests = (state.data.requests || []).filter(r => r.status === "pending").length;
    const activePunches = (state.data.punches || []).filter(p => p.status === "active").length;

    return `
      <header class="app-header">
        <div class="brand-section">
          <div class="brand-logo">P</div>
          <div>
            <div class="brand-title">
              <span id="header-business-title">${state.data.settings.businessName || "My Business"}</span>
              <span class="brand-tag">ROTA PRO</span>
            </div>
          </div>
        </div>

        <nav class="main-nav">
          <button class="nav-tab ${state.activeTab === "schedule" ? "active" : ""}" data-tab="schedule">
            📅 Schedule
          </button>
          <button class="nav-tab ${state.activeTab === "punch" ? "active" : ""}" data-tab="punch">
            ⏱️ Punch Clock
            ${activePunches > 0 ? `<span class="nav-badge" style="background:#dcfce7;color:#15803d">${activePunches} on shift</span>` : ""}
          </button>
          <button class="nav-tab ${state.activeTab === "requests" ? "active" : ""}" data-tab="requests">
            🔄 Shift Swaps & Leave
            ${pendingRequests > 0 ? `<span class="nav-badge" style="background:#fee2e2;color:#b91c1c">${pendingRequests}</span>` : ""}
          </button>
          <button class="nav-tab ${state.activeTab === "staff" ? "active" : ""}" data-tab="staff">
            👥 Staff Roster (${(state.data.employees || []).length})
          </button>
        </nav>

        <div class="header-actions">
          <button class="btn btn-secondary btn-sm" id="btn-share-team-header" style="font-weight: 600; color: #2563eb; background: #eff6ff; border-color: #bfdbfe;" title="Share link with team members">
            🔗 Share with Team
          </button>
          <button class="btn-install-pwa" id="btn-install-app-header" title="Download & Install Rota on iPhone or Android">
            📱 Install App
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-open-settings" title="Change Currency, Business Name, Labor Budget, or Reset Rota">
            ⚙️ Settings & Budget
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-print-rota" title="Print physical rota sheet">
            🖨️ Print
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-export-csv" title="Export current schedule as CSV">
            📥 Export CSV
          </button>
          <button class="btn btn-primary btn-sm" id="btn-add-shift-header">
            + Add Shift
          </button>
        </div>
      </header>
    `;
  }

  // Render Top KPI Metrics Bar
  function renderKpiBar() {
    const kpis = getWeekKPIs();
    return `
      <div class="kpi-bar">
        <div class="kpi-card">
          <div class="kpi-icon" style="background:#eff6ff; color:#2563eb;">🕒</div>
          <div class="kpi-info">
            <h4>Scheduled Hours</h4>
            <div class="kpi-value">${kpis.totalHours} hrs</div>
            <div class="kpi-sub">Across 7 days</div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-icon" style="background:#f0fdf4; color:#16a34a;">💰</div>
          <div class="kpi-info">
            <h4>Est. Wage Cost</h4>
            <div class="kpi-value">${kpis.currency}${kpis.totalCost}</div>
            <div class="kpi-sub">Live labor total</div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-icon" style="background:#f5f3ff; color:#7c3aed;">📊</div>
          <div class="kpi-info">
            <h4>Labor Cost %</h4>
            <div class="kpi-value">${kpis.laborPercentage}%</div>
            <div class="kpi-sub">Target: ${state.data.settings.targetLaborPercentage || 20.0}%</div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-icon" style="background:#ecfdf5; color:#059669;">👥</div>
          <div class="kpi-info">
            <h4>Active Roster</h4>
            <div class="kpi-value">${kpis.activeStaffCount} / ${kpis.totalStaffCount} Staff</div>
            <div class="kpi-sub">Scheduled this week</div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-icon" style="background:${kpis.draftCount > 0 ? "#fffbeb" : "#f8fafc"}; color:${kpis.draftCount > 0 ? "#d97706" : "#64748b"};">
            ${kpis.draftCount > 0 ? "⚠️" : "✓"}
          </div>
          <div class="kpi-info">
            <h4>Publish Status</h4>
            <div class="kpi-value">${kpis.draftCount > 0 ? `${kpis.draftCount} Drafts` : (kpis.totalHours > 0 ? "Published" : "Clean Rota")}</div>
            <div class="kpi-sub">${kpis.draftCount > 0 ? "Ready to publish" : (kpis.totalHours > 0 ? "All staff notified" : "Ready for shifts")}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Render Rota Controls Bar
  function renderRotaControls() {
    const weekDates = getWeekDates();
    const startStr = weekDates[0].toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const endStr = weekDates[6].toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const kpis = getWeekKPIs();

    const deptOptions = (state.data.departments || [])
      .map(d => `<option value="${d.id}" ${state.selectedDepartment === d.id ? "selected" : ""}>${d.name}</option>`)
      .join("");

    return `
      <div class="rota-controls-bar">
        <div class="date-navigator">
          <button class="btn btn-secondary btn-sm" id="btn-prev-week" title="Previous Week">◀</button>
          <button class="btn btn-secondary btn-sm" id="btn-today">Today</button>
          <button class="btn btn-secondary btn-sm" id="btn-next-week" title="Next Week">▶</button>
          <div class="current-range">Week: ${startStr} – ${endStr}</div>
        </div>

        <div class="filter-group">
          <select class="select-input" id="dept-filter">
            <option value="all">All Departments</option>
            ${deptOptions}
          </select>

          <input type="text" class="text-input" id="search-filter" placeholder="Search staff or role..." value="${state.searchQuery}" style="width: 170px;">

          <div class="view-toggle">
            <button class="${state.groupingMode === "employee" ? "active" : ""}" id="toggle-group-employee">By Staff</button>
            <button class="${state.groupingMode === "department" ? "active" : ""}" id="toggle-group-dept">By Dept</button>
          </div>

          <button class="btn btn-secondary btn-sm" id="btn-copy-prev-week" title="Copy all shifts from previous week into this week">
            📋 Copy Prev Week
          </button>

          ${
            kpis.draftCount > 0
              ? `<button class="btn btn-success btn-sm" id="btn-publish-rota">🚀 Publish Rota (${kpis.draftCount})</button>`
              : `<button class="btn btn-secondary btn-sm" disabled style="opacity:0.7;">✓ All Published</button>`
          }
        </div>
      </div>
    `;
  }

  // Render Open Shifts Banner
  function renderOpenShifts() {
    const weekDates = getWeekDates().map(formatDate);
    const openShifts = (state.data.shifts || []).filter(s => weekDates.includes(s.date) && (!s.employeeId || s.status === "open"));

    if (openShifts.length === 0) {
      return `
        <div class="open-shifts-container">
          <div class="open-shifts-header">
            <div class="open-shifts-title">⚡ Open Shifts (0)</div>
            <div class="open-shifts-desc">No unassigned shifts</div>
          </div>
          <div style="font-size: 0.8rem; color: #94a3b8; padding-top: 0.25rem;">
            No open shifts scheduled for this week. Click <strong>+ Add Shift</strong> to create a shift for your team.
          </div>
        </div>
      `;
    }

    const cardsHtml = openShifts
      .map(shift => {
        const dept = (state.data.departments || []).find(d => d.id === shift.departmentId) || { color: "#64748b" };
        const hours = calculateNetHours(shift.startTime, shift.endTime, shift.breakMinutes);
        const dayLabel = parseDate(shift.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
        return `
          <div class="shift-card status-open" style="border-left-color: ${dept.color}; min-width: 170px;" data-shift-id="${shift.id}">
            <div class="shift-time">
              <span>${shift.startTime} - ${shift.endTime}</span>
              <span class="shift-badge badge-open">OPEN</span>
            </div>
            <div class="shift-role-title"><strong>${shift.role}</strong> (${dayLabel})</div>
            <div class="shift-footer">
              <span>${hours}h net</span>
              <button class="btn btn-secondary btn-sm btn-claim-shift" data-shift-id="${shift.id}" style="padding: 2px 6px; font-size: 10px;">
                Assign
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    return `
      <div class="open-shifts-container">
        <div class="open-shifts-header">
          <div class="open-shifts-title">⚡ Open Shifts (${openShifts.length})</div>
          <div class="open-shifts-desc">Needs assignment</div>
        </div>
        <div class="open-shifts-grid">
          ${cardsHtml}
        </div>
      </div>
    `;
  }

  // Render Schedule Grid (Rota Table)
  function renderScheduleGrid() {
    const weekDates = getWeekDates();
    const todayStr = formatDate(new Date("2026-09-24"));
    const currency = state.data.settings.currency || "£";

    // If no employees exist yet, show clean slate welcome screen
    if ((state.data.employees || []).length === 0) {
      return `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 4rem 2rem; text-align: center; box-shadow: var(--shadow-sm);">
          <div style="font-size: 3rem; margin-bottom: 1rem;">✨</div>
          <h2 style="font-size: 1.35rem; font-weight: 700; color: #0f172a; margin-bottom: 0.5rem;">Your Rota is Clean & Blank</h2>
          <p style="color: #64748b; font-size: 0.9rem; max-width: 480px; margin: 0 auto 1.5rem;">
            All previous names, demo shifts, and costs have been removed. You have a fresh, blank canvas ready for your business.
          </p>
          <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
            <button class="btn btn-primary" id="btn-empty-add-emp">
              + Add Your First Employee
            </button>
            <button class="btn btn-secondary" id="btn-empty-add-shift">
              + Create Open Shift
            </button>
            <button class="btn btn-secondary" id="btn-empty-settings">
              ⚙️ Customize Business & Currency
            </button>
          </div>
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
              <span class="day-stats">${stats.hours}h · ${currency}${stats.cost}</span>
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
                  const cost = (hours * (shift.rate || emp.hourlyRate || 0)).toFixed(0);
                  const isDraft = shift.status === "draft";

                  return `
                    <div class="shift-card ${isDraft ? "status-draft" : "status-published"}" 
                         style="border-left-color: ${sDept.color};" 
                         data-shift-id="${shift.id}" 
                         title="${shift.notes ? `Note: ${shift.notes}` : "Click to edit"}">
                      <div class="shift-time">
                        <span>${shift.startTime} - ${shift.endTime}</span>
                        ${shift.breakMinutes ? `<span class="shift-break">-${shift.breakMinutes}m</span>` : ""}
                      </div>
                      <div class="shift-role-title">${shift.role}</div>
                      <div class="shift-footer">
                        <span>${hours}h · ${currency}${cost}</span>
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
                <td class="shift-cell" data-emp-id="${emp.id}" data-date="${dateStr}">
                  <div class="shift-cards-wrap">
                    ${shiftCards}
                  </div>
                  <button class="add-shift-btn btn-cell-add" data-emp-id="${emp.id}" data-date="${dateStr}">
                    + Shift
                  </button>
                </td>
              `;
            })
            .join("");

          return `
            <tr>
              <td class="entity-cell">
                <div class="employee-row-info">
                  <div class="emp-avatar" style="background-color: ${emp.avatarColor || dept.color};">
                    ${(emp.name || "E").split(" ").map(n => n[0]).join("")}
                  </div>
                  <div class="emp-details">
                    <div class="emp-name" title="${emp.name}">${emp.name}</div>
                    <div class="emp-role-tag">${emp.role} · ${currency}${emp.hourlyRate}/h</div>
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

                  return `
                    <div class="shift-card ${shift.status === "draft" ? "status-draft" : "status-published"}" 
                         style="border-left-color: ${dept.color};" 
                         data-shift-id="${shift.id}">
                      <div class="shift-time">
                        <span>${shift.startTime} - ${shift.endTime}</span>
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
                  <button class="add-shift-btn btn-cell-add" data-dept-id="${dept.id}" data-date="${dateStr}">
                    + Shift
                  </button>
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
    const currency = state.data.settings.currency || "£";
    const activePunches = (state.data.punches || []).filter(p => p.status === "active");

    const empOptions = (state.data.employees || []).length > 0
      ? (state.data.employees || []).map(e => `<option value="${e.id}">${e.name} (${e.role})</option>`).join("")
      : `<option value="">-- No Employees Available --</option>`;

    const activeListHtml = activePunches.length === 0
      ? `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">No employees are currently clocked in.</td></tr>`
      : activePunches
          .map(punch => {
            const emp = (state.data.employees || []).find(e => e.id === punch.employeeId) || { name: "Unknown", role: "" };
            const clockInTime = new Date(punch.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            return `
              <tr>
                <td><strong>${emp.name}</strong></td>
                <td>${emp.role}</td>
                <td><span style="color:#16a34a;font-weight:600;">● Active</span></td>
                <td>${clockInTime}</td>
                <td>
                  <button class="btn btn-secondary btn-sm btn-clock-out" data-punch-id="${punch.id}">Clock Out</button>
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
            <label class="form-label">Select Employee</label>
            <select class="form-select" id="punch-employee-select">
              ${empOptions}
            </select>
          </div>

          <div style="display:flex;gap:10px;margin-top:1.5rem;">
            <button class="btn btn-success" id="btn-terminal-clock-in" style="flex:1;padding:10px;" ${(state.data.employees || []).length === 0 ? "disabled" : ""}>
              ▶ Clock In
            </button>
            <button class="btn btn-secondary" id="btn-terminal-break" style="padding:10px;">
              ☕ Break
            </button>
          </div>
          <p style="font-size:0.75rem;color:#94a3b8;margin-top:1rem;">
            GPS & PIN verified. Punches synchronize directly with timesheet variance records.
          </p>
        </div>

        <div class="live-punches-card">
          <h3 style="font-size:1.05rem;font-weight:700;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;">
            <span>Staff Currently On Duty (${activePunches.length})</span>
            <span style="font-size:0.8rem;font-weight:normal;color:#16a34a;">Real-time Attendance</span>
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
                  req.status === "pending"
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
                  req.status === "pending"
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

  // Render Staff Roster Tab
  function renderStaffTab() {
    const currency = state.data.settings.currency || "£";
    const employees = state.data.employees || [];

    if (employees.length === 0) {
      return `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 4rem 2rem; text-align: center;">
          <div style="font-size: 3rem; margin-bottom: 1rem;">👥</div>
          <h3 style="font-size: 1.25rem; font-weight: 700; color: #0f172a; margin-bottom: 0.5rem;">No Employees Added Yet</h3>
          <p style="color: #64748b; font-size: 0.875rem; max-width: 440px; margin: 0 auto 1.5rem;">
            Add your team members with their custom names, roles, hourly wage rates, and contracted hours to begin scheduling.
          </p>
          <button class="btn btn-primary" id="btn-add-employee">+ Add First Employee</button>
        </div>
      `;
    }

    const cardsHtml = employees
      .map(emp => {
        const dept = (state.data.departments || []).find(d => d.id === emp.departmentId) || { name: "", color: "#64748b" };
        return `
          <div class="staff-card">
            <div class="staff-card-header">
              <div class="emp-avatar" style="background-color: ${emp.avatarColor || dept.color};">
                ${(emp.name || "E").split(" ").map(n => n[0]).join("")}
              </div>
              <div style="overflow:hidden;">
                <h4 style="font-size:0.95rem;font-weight:700;color:#0f172a;">${emp.name}</h4>
                <div style="font-size:0.75rem;color:#64748b;">${emp.role}</div>
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
              <span>Contracted Hours</span>
              <strong>${emp.contractedHours || 0} hrs/wk</strong>
            </div>
            <div class="staff-info-row">
              <span>Contact</span>
              <span style="font-size:0.75rem;">${emp.email || "No email"}</span>
            </div>

            <div style="display:flex;gap:6px;margin-top:0.5rem;">
              <button class="btn btn-secondary btn-sm btn-edit-emp" data-emp-id="${emp.id}" style="flex:1;">Edit Staff</button>
            </div>
          </div>
        `;
      })
      .join("");

    return `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
          <div>
            <h3 style="font-size:1.15rem;font-weight:700;">Employee Directory (${employees.length})</h3>
            <p style="font-size:0.8rem;color:#64748b;">Manage wage rates, contracted commitments, and roles.</p>
          </div>
          <button class="btn btn-primary btn-sm" id="btn-add-employee">+ New Employee</button>
        </div>
        <div class="staff-grid">
          ${cardsHtml}
        </div>
      </div>
    `;
  }

  // Render Settings & Budget Modal
  function renderSettingsModal() {
    if (!state.showSettingsModal) return "";
    const s = state.data.settings;

    return `
      <div class="modal-overlay" id="settings-modal-overlay">
        <div class="modal-content" style="max-width: 500px;">
          <div class="modal-header">
            <h3 class="modal-title">⚙️ Business Settings & Labor Budget</h3>
            <button class="modal-close" id="btn-close-settings">&times;</button>
          </div>

          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Business / Venue Name</label>
              <input type="text" class="form-input" id="set-business-name" value="${s.businessName || ""}" placeholder="e.g. Acme Coffee Roasters">
            </div>

            <div class="form-row">
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
              <div class="form-group">
                <label class="form-label">Target Labor Cost %</label>
                <input type="number" class="form-input" id="set-target-labor" value="${s.targetLaborPercentage || 20.0}" step="0.5">
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Projected Weekly Revenue (${s.currency})</label>
              <input type="number" class="form-input" id="set-revenue" value="${s.projectedWeeklyRevenue || 0}" step="100" placeholder="e.g. 15000">
              <p style="font-size:0.75rem; color:#64748b; margin-top:0.25rem;">Used to calculate your real-time Labor Cost % metric.</p>
            </div>

            <div style="border-top: 1px solid var(--border-color); margin-top: 1.5rem; padding-top: 1rem;">
              <h4 style="font-size: 0.85rem; font-weight: 700; color: #b91c1c; margin-bottom: 0.5rem; text-transform: uppercase;">
                ⚠️ Clear & Clean Slate Tools
              </h4>
              <p style="font-size: 0.775rem; color: #64748b; margin-bottom: 0.75rem;">
                Easily wipe all demo shifts or reset the entire application to an empty state.
              </p>
              <div style="display: flex; gap: 8px; flex-direction: column;">
                <button class="btn btn-secondary btn-sm" id="btn-action-clear-shifts" style="color: #b45309; border-color: #fde68a; justify-content: flex-start;">
                  🧹 Clear All Shifts (Keep Staff)
                </button>
                <button class="btn btn-danger-outline btn-sm" id="btn-action-wipe-all" style="justify-content: flex-start;">
                  🗑️ Wipe Entire Rota & Staff (100% Clean Slate)
                </button>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-secondary" id="btn-cancel-settings">Cancel</button>
            <button class="btn btn-primary" id="btn-save-settings">Save Settings</button>
          </div>
        </div>
      </div>
    `;
  }

  // Render Install to Phone Modal
  function renderInstallModal() {
    if (!state.showInstallModal) return "";

    return `
      <div class="modal-overlay" id="install-guide-modal-overlay">
        <div class="modal-content" style="max-width: 480px;">
          <div class="modal-header">
            <h3 class="modal-title">📱 Download Rota to Your Phone</h3>
            <button class="modal-close" id="btn-close-install-modal">&times;</button>
          </div>
          <div class="modal-body" style="font-size: 0.85rem;">
            <p style="color: #64748b; margin-bottom: 1.25rem;">
              You and your team members can install this app directly onto your <strong>iPhone</strong> or <strong>Android</strong> device. It will appear on your home screen, work offline, and open full-screen like a native app.
            </p>

            <div style="margin-bottom: 1.25rem;">
              <h4 style="font-weight: 700; color: #0f172a; margin-bottom: 0.6rem; display: flex; align-items: center; gap: 6px;">
                <span>🍎</span> For iPhone / iPad (iOS Safari)
              </h4>
              <div class="install-guide-step">
                <div class="step-num">1</div>
                <div>Open this rota website in <strong>Safari</strong> on your iPhone.</div>
              </div>
              <div class="install-guide-step">
                <div class="step-num">2</div>
                <div>Tap the <strong>Share</strong> button at the bottom of the screen (the square with an arrow pointing up 📤).</div>
              </div>
              <div class="install-guide-step">
                <div class="step-num">3</div>
                <div>Scroll down the menu and tap <strong>"Add to Home Screen"</strong> (➕).</div>
              </div>
              <div class="install-guide-step">
                <div class="step-num">4</div>
                <div>Tap <strong>Add</strong> at top right. The Rota app is now on your home screen!</div>
              </div>
            </div>

            <div>
              <h4 style="font-weight: 700; color: #0f172a; margin-bottom: 0.6rem; display: flex; align-items: center; gap: 6px;">
                <span>🤖</span> For Android (Google Chrome)
              </h4>
              <div class="install-guide-step">
                <div class="step-num">1</div>
                <div>Open this rota website in <strong>Google Chrome</strong> on Android.</div>
              </div>
              <div class="install-guide-step">
                <div class="step-num">2</div>
                <div>Tap the <strong>three dots (⋮)</strong> menu at top right.</div>
              </div>
              <div class="install-guide-step">
                <div class="step-num">3</div>
                <div>Tap <strong>"Install app"</strong> or <strong>"Add to Home screen"</strong>.</div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" id="btn-done-install-modal" style="width: 100%;">
              Got it!
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Render Share with Team Modal
  function renderShareModal() {
    if (!state.showShareModal) return "";

    const localUrl = `http://192.168.1.237:8080`;

    return `
      <div class="modal-overlay" id="share-modal-overlay">
        <div class="modal-content" style="max-width: 500px;">
          <div class="modal-header">
            <h3 class="modal-title">🔗 Share Rota with Your Team</h3>
            <button class="modal-close" id="btn-close-share-modal">&times;</button>
          </div>
          <div class="modal-body" style="font-size: 0.85rem;">
            <p style="color: #64748b; margin-bottom: 1.25rem;">
              Send this link to your team so they can view their shifts and install the app on their phones:
            </p>

            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1.25rem;">
              <div style="font-size: 0.75rem; font-weight: 700; color: #1e40af; text-transform: uppercase; margin-bottom: 0.35rem;">
                📶 On the Same Wi-Fi (Venue / Store / Office)
              </div>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input type="text" id="share-link-input" readonly value="${localUrl}" class="form-input" style="font-family: monospace; font-weight: 600; background: white; font-size: 0.9rem;">
                <button class="btn btn-primary" id="btn-copy-share-url" style="white-space: nowrap;">
                  📋 Copy Link
                </button>
              </div>
              <p style="font-size: 0.75rem; color: #3b82f6; margin-top: 0.5rem;">
                ✓ Paste this link into your team WhatsApp or group chat. Any phone connected to your Wi-Fi will open Tudor Local immediately!
              </p>
            </div>

            <div style="border-top: 1px solid var(--border-color); padding-top: 1rem;">
              <div style="font-size: 0.75rem; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 0.35rem;">
                🌐 If Staff are at Home (Mobile 4G/5G)
              </div>
              <p style="font-size: 0.775rem; color: #64748b; margin-bottom: 0.5rem;">
                To let staff check shifts from home when they are not on your Wi-Fi, run a free tunnel or deploy it online:
              </p>
              <div style="background: #f1f5f9; padding: 0.5rem 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.75rem; color: #0f172a; margin-bottom: 0.5rem;">
                npx localtunnel --port 8080
              </div>
              <p style="font-size: 0.725rem; color: #94a3b8;">
                This gives you a free <code>https://...</code> public link that works anywhere in the world.
              </p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="btn-done-share-modal" style="width: 100%;">
              Done
            </button>
          </div>
        </div>
      </div>
    `;
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
    const rate = shift.rate || (shift.employeeId ? ((state.data.employees || []).find(e => e.id === shift.employeeId) || {}).hourlyRate : 15) || 15;
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
                <input type="text" class="form-input" id="shift-role-input" value="${shift.role || "Staff"}">
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
              <textarea class="form-textarea" id="shift-notes-input" rows="2" placeholder="e.g. Opening duty, closing cash register...">${shift.notes || ""}</textarea>
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
            <h3 class="modal-title">${isNew ? "Add Employee" : "Edit Employee"}</h3>
            <button class="modal-close" id="emp-modal-close-btn">&times;</button>
          </div>

          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Full Name</label>
              <input type="text" class="form-input" id="emp-name-input" value="${emp.name || ""}" placeholder="e.g. Sarah Jenkins">
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
                <input type="text" class="form-input" id="emp-role-input" value="${emp.role || ""}" placeholder="e.g. Shift Lead / Barista">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Hourly Wage (${currency})</label>
                <input type="number" class="form-input" id="emp-rate-input" value="${emp.hourlyRate || 15}" step="0.5">
              </div>
              <div class="form-group">
                <label class="form-label">Contracted Hours / Wk</label>
                <input type="number" class="form-input" id="emp-hours-input" value="${emp.contractedHours || 35}">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Email</label>
                <input type="email" class="form-input" id="emp-email-input" value="${emp.email || ""}" placeholder="staff@example.com">
              </div>
              <div class="form-group">
                <label class="form-label">Phone</label>
                <input type="text" class="form-input" id="emp-phone-input" value="${emp.phone || ""}" placeholder="+44 7700 900000">
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

    let mainContentHtml = "";
    if (state.activeTab === "schedule") {
      mainContentHtml = `
        ${renderRotaControls()}
        ${renderOpenShifts()}
        ${renderScheduleGrid()}
      `;
    } else if (state.activeTab === "punch") {
      mainContentHtml = renderPunchClockTab();
    } else if (state.activeTab === "requests") {
      mainContentHtml = renderRequestsTab();
    } else if (state.activeTab === "staff") {
      mainContentHtml = renderStaffTab();
    }

    root.innerHTML = `
      ${renderHeader()}
      ${renderKpiBar()}
      <main class="app-main">
        ${mainContentHtml}
      </main>
      ${renderShiftModal()}
      ${renderEmployeeModal()}
      ${renderSettingsModal()}
      ${renderInstallModal()}
      ${renderShareModal()}
    `;

    bindEvents();
  }

  // Event Listeners Binding
  function bindEvents() {
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

    // Share Modal
    const shareBtn = document.getElementById("btn-share-team-header");
    if (shareBtn) {
      shareBtn.addEventListener("click", () => {
        state.showShareModal = true;
        renderApp();
      });
    }

    const closeShareBtn = document.getElementById("btn-close-share-modal");
    const doneShareBtn = document.getElementById("btn-done-share-modal");
    if (closeShareBtn) closeShareBtn.addEventListener("click", () => { state.showShareModal = false; renderApp(); });
    if (doneShareBtn) doneShareBtn.addEventListener("click", () => { state.showShareModal = false; renderApp(); });

    const copyShareUrlBtn = document.getElementById("btn-copy-share-url");
    if (copyShareUrlBtn) {
      copyShareUrlBtn.addEventListener("click", () => {
        const inp = document.getElementById("share-link-input");
        if (inp) {
          navigator.clipboard.writeText(inp.value);
          showToast("Link copied to clipboard! Paste it to your team.", "success");
        }
      });
    }

    // Install App Modal
    const installAppBtn = document.getElementById("btn-install-app-header");
    if (installAppBtn) {
      installAppBtn.addEventListener("click", () => {
        if (window.triggerInstallPrompt) {
          window.triggerInstallPrompt();
        } else {
          state.showInstallModal = true;
          renderApp();
        }
      });
    }

    const closeInstallBtn = document.getElementById("btn-close-install-modal");
    const doneInstallBtn = document.getElementById("btn-done-install-modal");
    if (closeInstallBtn) closeInstallBtn.addEventListener("click", () => { state.showInstallModal = false; renderApp(); });
    if (doneInstallBtn) doneInstallBtn.addEventListener("click", () => { state.showInstallModal = false; renderApp(); });

    // Settings Modal
    const openSettingsBtn = document.getElementById("btn-open-settings");
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener("click", () => {
        state.showSettingsModal = true;
        renderApp();
      });
    }

    const closeSettingsBtn = document.getElementById("btn-close-settings");
    const cancelSettingsBtn = document.getElementById("btn-cancel-settings");
    if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", () => { state.showSettingsModal = false; renderApp(); });
    if (cancelSettingsBtn) cancelSettingsBtn.addEventListener("click", () => { state.showSettingsModal = false; renderApp(); });

    const saveSettingsBtn = document.getElementById("btn-save-settings");
    if (saveSettingsBtn) {
      saveSettingsBtn.addEventListener("click", async () => {
        const name = document.getElementById("set-business-name").value.trim() || "My Business";
        const curr = document.getElementById("set-currency").value;
        const target = Number(document.getElementById("set-target-labor").value || 20);
        const rev = Number(document.getElementById("set-revenue").value || 0);

        state.data.settings = {
          businessName: name,
          currency: curr,
          targetLaborPercentage: target,
          projectedWeeklyRevenue: rev
        };

        state.showSettingsModal = false;
        await saveData();
        showToast("Settings and budget updated!");
      });
    }

    // Clear All Shifts Action
    const clearShiftsBtn = document.getElementById("btn-action-clear-shifts");
    if (clearShiftsBtn) {
      clearShiftsBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to remove all shifts? Employee records will be kept.")) return;
        state.data.shifts = [];
        state.showSettingsModal = false;
        await saveData();
        showToast("All shifts removed. Rota is clean!");
      });
    }

    // Wipe Entire Rota & Staff Action (100% Clean Slate)
    const wipeAllBtn = document.getElementById("btn-action-wipe-all");
    if (wipeAllBtn) {
      wipeAllBtn.addEventListener("click", async () => {
        if (!confirm("⚠️ This will permanently remove all shifts, employees, requests, and clock records. Proceed with 100% clean slate?")) return;
        state.data.employees = [];
        state.data.shifts = [];
        state.data.requests = [];
        state.data.punches = [];
        state.showSettingsModal = false;
        await saveData();
        showToast("Application completely reset to clean slate!");
      });
    }

    // Empty state triggers
    const emptyAddEmp = document.getElementById("btn-empty-add-emp");
    if (emptyAddEmp) {
      emptyAddEmp.addEventListener("click", () => {
        state.editingEmployee = {
          isNew: true,
          name: "",
          departmentId: state.data.departments[0]?.id || "general",
          role: "Staff Member",
          hourlyRate: 15.0,
          contractedHours: 35,
          email: "",
          phone: ""
        };
        renderApp();
      });
    }

    const emptyAddShift = document.getElementById("btn-empty-add-shift");
    if (emptyAddShift) {
      emptyAddShift.addEventListener("click", () => {
        openShiftModal({
          isNew: true,
          date: formatDate(state.currentMonday),
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 30,
          role: "General Staff",
          departmentId: state.data.departments[0]?.id || "general",
          status: "open",
          employeeId: null,
          rate: 15.0
        });
      });
    }

    const emptySettings = document.getElementById("btn-empty-settings");
    if (emptySettings) {
      emptySettings.addEventListener("click", () => {
        state.showSettingsModal = true;
        renderApp();
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
          breakMinutes: 30,
          role: firstEmp ? firstEmp.role : "General Staff",
          departmentId: state.data.departments[0]?.id || "general",
          status: firstEmp ? "draft" : "open",
          employeeId: firstEmp ? firstEmp.id : null,
          rate: firstEmp ? firstEmp.hourlyRate : 15.0
        });
      });
    }

    // Cell Add Shift Buttons
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
          breakMinutes: 30,
          role: emp ? emp.role : "Staff",
          departmentId: deptId,
          status: empId ? "draft" : "open",
          employeeId: empId,
          rate: emp ? emp.hourlyRate : 15.0
        });
      });
    });

    // Edit Shift on card click
    document.querySelectorAll(".shift-card").forEach(card => {
      card.addEventListener("click", e => {
        if (e.target.closest(".btn-claim-shift")) return;
        const shiftId = card.dataset.shiftId;
        const shift = (state.data.shifts || []).find(s => s.id === shiftId);
        if (shift) {
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
          hourlyRate: 15.0,
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
        const rate = Number(document.getElementById("emp-rate-input").value || 15);
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
          role: role || "Staff",
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
        showToast("Employee details saved!");
      });
    }

    // Delete Employee
    const deleteEmpBtn = document.getElementById("btn-delete-employee");
    if (deleteEmpBtn) {
      deleteEmpBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to remove this employee?")) return;
        const empId = state.editingEmployee.id;
        state.data.employees = state.data.employees.filter(e => e.id !== empId);
        // Unassign their shifts to open shifts
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
          alert("Please select or add an employee first.");
          return;
        }
        const emp = (state.data.employees || []).find(e => e.id === empId);

        const existing = (state.data.punches || []).find(p => p.employeeId === empId && p.status === "active");
        if (existing) {
          alert(`${emp.name} is already clocked in.`);
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
        showToast(`${emp.name} clocked in!`);
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

    // Print & Export
    const printBtn = document.getElementById("btn-print-rota");
    if (printBtn) {
      printBtn.addEventListener("click", () => {
        window.print();
      });
    }

    const exportCsvBtn = document.getElementById("btn-export-csv");
    if (exportCsvBtn) {
      exportCsvBtn.addEventListener("click", () => {
        exportRotaCSV();
      });
    }
  }

  // Open Shift Modal helper
  function openShiftModal(shift) {
    state.editingShift = shift;
    renderApp();
  }

  // Export CSV
  function exportRotaCSV() {
    const weekDates = getWeekDates().map(formatDate);
    const shifts = (state.data.shifts || []).filter(s => weekDates.includes(s.date));

    let csv = "Shift ID,Date,Day,Start Time,End Time,Break (mins),Net Hours,Employee,Department,Role,Hourly Rate,Estimated Cost,Status,Notes\n";
    shifts.forEach(s => {
      const emp = (state.data.employees || []).find(e => e.id === s.employeeId) || { name: "Open Shift" };
      const dept = (state.data.departments || []).find(d => d.id === s.departmentId) || { name: "" };
      const hours = calculateNetHours(s.startTime, s.endTime, s.breakMinutes);
      const cost = (hours * (s.rate || 0)).toFixed(2);
      const day = parseDate(s.date).toLocaleDateString("en-GB", { weekday: "short" });

      csv += `"${s.id}","${s.date}","${day}","${s.startTime}","${s.endTime}",${s.breakMinutes || 0},${hours},"${emp.name}","${dept.name}","${s.role}",${s.rate || 0},${cost},"${s.status}","${(s.notes || "").replace(/"/g, '""')}"\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `rota_schedule_week_${weekDates[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
