# Planday Rota & Workforce Management Application

A modern, responsive, full-featured employee shift scheduling and workforce management application modeled after **Planday**.

![Rota Preview](https://img.shields.io/badge/Rota-Planday%20Pro-2563eb)
![No Dependencies](https://img.shields.io/badge/Dependencies-Zero-10b981)
![Python 3](https://img.shields.io/badge/Backend-Python%20Standard%20Library-blue)

---

## 🌟 Key Features

1. **Interactive Weekly & Daily Rota Grid**:
   - **Dual Grouping Modes**: View by Team Member (employee rows) or by Section/Department (Front of House, Kitchen, Bar, Management).
   - **Visual Shift Cards**: Start/End times, unpaid break deduction, net hours, estimated labor cost per shift, role titles, and status indicators.
   - **Draft vs. Published Workflow**: Easily plan schedules in draft mode. Click **Publish Rota** to make shifts live and notify staff.

2. **Open / Unassigned Shifts Pool**:
   - Banner at the top of the schedule showing open shifts requiring coverage.
   - One-click assignment to any available staff member.

3. **Smart Scheduling & Conflict Detection**:
   - Overlapping shift detection (flags if an employee has conflicting shifts).
   - Availability validation (warns if an employee is unavailable on that day).
   - Overtime warning alerts (>40 contracted hours/week).

4. **Labor Cost & Budget Tracking**:
   - Live KPI dashboard calculating total weekly hours, total estimated wage costs, and labor cost percentage against revenue forecasts.
   - Daily hours and cost summaries right on the calendar header.

5. **Planday Punch Clock & Timesheets**:
   - Live digital clock terminal for employees to clock in, take breaks, and clock out.
   - Real-time active duty staff indicator.
   - Timesheet variance tracker comparing scheduled vs. punched hours with manager sign-off.

6. **Shift Swapping & Leave Management**:
   - Review and approve employee shift trades with automatic rota assignment.
   - Approve or reject employee time-off and vacation requests.

7. **Staff Roster Directory**:
   - Manage team members, hourly wage rates, departments, and contracted hours.

8. **Export & Print**:
   - One-click print-optimized rota sheet for physical staff noticeboards.
   - CSV export for payroll and spreadsheet analysis.
   - "Copy Prev Week" button to duplicate full schedules instantly.

---

## 🚀 Quick Start

### Option 1: Run with Python Server (Recommended for Full Persistence)
From this directory:

```bash
python3 server.py
```

Open your browser and navigate to:
**[http://localhost:8080](http://localhost:8080)**

All changes (new shifts, staff edits, punches) will automatically persist to `data.json`.

### Option 2: Open Directly in Browser
You can also directly double-click or open `index.html` in Chrome, Safari, or Edge. State will automatically save to your browser's `localStorage`.

---

## 📁 File Structure

- `index.html` - Main HTML5 single page layout.
- `styles.css` - Responsive modern SaaS styling matching Planday.
- `app.js` - Complete scheduling engine, conflict validation, punch clock, and state manager.
- `server.py` - Lightweight HTTP & REST server (zero pip dependencies).
- `data.json` - Initial realistic demo database (hospitality restaurant & bar team).
