/**
 * Cybersecurity CPE Tracker — main frontend script.
 *
 * This is a single-file vanilla JS SPA; no build step or framework required.
 *
 * Responsibilities:
 *  - Render and manage the interactive CPE data table (sort, filter, edit in-place)
 *  - Column customisation: show/hide, resize, drag-to-reorder (all persisted in localStorage)
 *  - Submission modal: display pre-filled fields and save user summaries
 *  - Proof screenshot upload, preview, and deletion
 *  - Summary dashboard cards and domain-hours breakdown
 *  - Add-CPE form with multi-domain checkbox picker
 *
 * State:
 *  allRows   — current filtered row set from the last GET /api/cpes call
 *  filters   — active filter values; applied on the server via query params
 *  colOrder  — display order of column ids (persisted: "cpe_col_order")
 *  colHidden — Set of hidden column ids       (persisted: "cpe_col_hidden")
 *  colWidths — map of column id → pixel width  (persisted: "cpe_col_widths")
 *  sortCol   — column id currently sorted, or null
 *  sortDir   — "asc" | "desc" | null
 */

const DOMAINS = [
  "Security and Risk Management",
  "Asset Security",
  "Security Architecture and Engineering",
  "Communication and Network Security",
  "Identity and Access Management",
  "Security Assessment and Testing",
  "Security Operations",
  "Software Development Security",
];

const DOMAIN_SHORT = {
  "Security and Risk Management":          "SRM",
  "Asset Security":                        "AS",
  "Security Architecture and Engineering": "SAE",
  "Communication and Network Security":    "CNS",
  "Identity and Access Management":        "IAM",
  "Security Assessment and Testing":       "SAT",
  "Security Operations":                   "SO",
  "Software Development Security":         "SDS",
};

const STATUSES = ["pending", "submitted", "archived"];

// ---------------------------------------------------------------------------
// Vendor / certification definitions (v1.7)
// ---------------------------------------------------------------------------

const VENDORS = {
  isc2:    { id: "isc2",    name: "ISC²",    full: "ISC² — CISSP, CCSP, SSCP",     step: 0.25, min: 0.25, max: 40,  label: "CPE Credits" },
  isaca:   { id: "isaca",   name: "ISACA",   full: "ISACA — CISM, CISA, CRISC",    step: 0.5,  min: 0.5,  max: 120, label: "CPE Credits" },
  comptia: { id: "comptia", name: "CompTIA", full: "CompTIA — Sec+, CySA+, CASP+", step: 0.5,  min: 0.5,  max: 40,  label: "CEUs" },
};
const VENDOR_IDS = ["isc2", "isaca", "comptia"];
let activeVendors = new Set(["isc2"]);  // loaded from localStorage "cpe_vendors" in init()

/**
 * Entry types accepted by each vendor for CPE/CEU credit.
 * null = all types; array = only those specific types.
 */
const VENDOR_TYPES = {
  isc2:    null,           // accepts podcast, article, webinar, etc.
  isaca:   ["webinar"],    // manual webinar submissions only
  comptia: ["webinar"],    // manual webinar submissions only
};

/** Returns true if the given vendor awards credit for entries of the given type. */
function vendorAcceptsType(vendorId, type) {
  const allowed = VENDOR_TYPES[vendorId];
  return allowed === null || allowed.includes(type || "podcast");
}

/**
 * Compute merged CPE input rules across all active vendors.
 * step = finest granularity (min step), min = smallest min, max = largest max.
 */
function _mergedVendorRules() {
  const active = VENDOR_IDS.filter(id => activeVendors.has(id)).map(id => VENDORS[id]);
  if (!active.length) active.push(VENDORS.isc2);
  return {
    step: Math.min(...active.map(v => v.step)),
    min:  Math.min(...active.map(v => v.min)),
    max:  Math.max(...active.map(v => v.max)),
  };
}

// ---------------------------------------------------------------------------
// Theme system
// ---------------------------------------------------------------------------

const THEMES = {
  amber:  { accent: "#c97d10", bright: "#e8950f", dim10: "rgba(201,125,16,0.10)", dim13: "rgba(201,125,16,0.13)", dim06: "rgba(201,125,16,0.06)", line: "rgba(201,125,16,0.30)" },
  red:    { accent: "#b83232", bright: "#e04444", dim10: "rgba(184,50,50,0.10)",   dim13: "rgba(184,50,50,0.13)",   dim06: "rgba(184,50,50,0.06)",   line: "rgba(184,50,50,0.30)"   },
  green:  { accent: "#1e8a4c", bright: "#27ae63", dim10: "rgba(30,138,76,0.10)",   dim13: "rgba(30,138,76,0.13)",   dim06: "rgba(30,138,76,0.06)",   line: "rgba(30,138,76,0.30)"   },
  blue:   { accent: "#1a6fab", bright: "#2389d4", dim10: "rgba(26,111,171,0.10)",  dim13: "rgba(26,111,171,0.13)",  dim06: "rgba(26,111,171,0.06)",  line: "rgba(26,111,171,0.30)"  },
  purple: { accent: "#6e3abf", bright: "#8b52e0", dim10: "rgba(110,58,191,0.10)",  dim13: "rgba(110,58,191,0.13)",  dim06: "rgba(110,58,191,0.06)",  line: "rgba(110,58,191,0.30)"  },
  cyan:   { accent: "#0d8a8a", bright: "#12b0b0", dim10: "rgba(13,138,138,0.10)",  dim13: "rgba(13,138,138,0.13)",  dim06: "rgba(13,138,138,0.06)",  line: "rgba(13,138,138,0.30)"  },
};

/**
 * Apply an accent colour theme by overwriting CSS custom properties on :root.
 * Saves the choice to localStorage under "cpe_theme".
 */
function applyTheme(name) {
  const t = THEMES[name] || THEMES.amber;
  const r = document.documentElement.style;
  r.setProperty("--accent",           t.accent);
  r.setProperty("--accent-bright",    t.bright);
  r.setProperty("--accent-dim",       t.dim10);
  r.setProperty("--warning-dim",      t.dim13);
  r.setProperty("--accent-dim-subtle",t.dim06);
  r.setProperty("--accent-line",      t.line);
  localStorage.setItem("cpe_theme", name);
  document.querySelectorAll(".theme-swatch").forEach(sw => {
    sw.classList.toggle("active", sw.dataset.theme === name);
  });
}

// ---------------------------------------------------------------------------
// Light / dark mode
// ---------------------------------------------------------------------------

function toggleMode() {
  const next = document.documentElement.dataset.mode === "light" ? "dark" : "light";
  applyMode(next);
}

function applyMode(mode) {
  if (mode === "light") document.documentElement.dataset.mode = "light";
  else                  delete document.documentElement.dataset.mode;
  localStorage.setItem("cpe_mode", mode);
  const btn = $("btn-mode-toggle");
  if (btn) btn.textContent = mode === "light" ? "Dark" : "Light";
}

// --- State ---
let rawRows = [];   // rows returned by API (no source filter applied)
let allRows = [];   // rawRows after client-side source filter
let filters = { domain: "", status: "", type: "", source: "", has_proof: false, date_from: "", date_to: "" };
let activeSubmitRowId = null;
let sortCol = null;
let sortDir = null;
let selectedIds = new Set();

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Shorthand for document.getElementById. */
function $(id) { return document.getElementById(id); }

/**
 * Display a toast notification for 3 seconds.
 * @param {string} msg  - Message text.
 * @param {"success"|"error"} type - Controls border colour.
 */
function showToast(msg, type = "success") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ""; }, 3000);
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    });
  } catch { return iso.slice(0, 10); }
}

function fmtDuration(raw) {
  if (!raw) return "—";
  const parts = raw.split(":").map(Number);
  let h = 0, m = 0;
  if (parts.length === 3)      { h = parts[0]; m = parts[1]; }
  else if (parts.length === 2) { h = Math.floor(parts[0] / 60); m = parts[0] % 60; }
  else                         { const s = parseInt(raw, 10) || 0; h = Math.floor(s / 3600); m = Math.floor((s % 3600) / 60); }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function getYear(iso) {
  if (!iso) return "";
  try { return new Date(iso).getFullYear().toString(); }
  catch { return iso.slice(0, 4); }
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function statusOptions(selected = "") {
  return STATUSES.map(s =>
    `<option value="${s}" ${s === selected ? "selected" : ""}>${s}</option>`
  ).join("");
}

function badgeType(t) {
  return `<span class="type-badge type-${t}">${t}</span>`;
}

// --- Duration parsing helpers ---

/**
 * Parse a human-entered duration string to total minutes.
 * Handles: "1h 30m", "1 hour 30 minutes", "3 hours 10 minutes 3 seconds",
 *          "1:30:00", "1:30", "90m", "90", "1.5h", etc.
 * Returns total minutes as a number, or null if unparseable.
 */
function parseDurationInput(str) {
  if (!str || !str.trim()) return null;
  str = str.trim().toLowerCase()
    .replace(/\bhours?\b/g, 'h')
    .replace(/\bminutes?\b|\bmins?\b/g, 'm')
    .replace(/\bseconds?\b|\bsecs?\b/g, 's');

  // HH:MM:SS
  let m = str.match(/(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / 60;

  // H:MM — if first part ≤ 9 treat as hours:minutes; otherwise as minutes:seconds
  m = str.match(/^(\d+):(\d{1,2})$/);
  if (m) {
    const a = parseInt(m[1]), b = parseInt(m[2]);
    return a <= 9 ? a * 60 + b : a + b / 60;
  }

  // Named units (any combination): "1h30m", "2h 30m", "90m", "1.5h", etc.
  const hM = str.match(/(\d+(?:\.\d+)?)h/);
  const mM = str.match(/(\d+(?:\.\d+)?)m(?!s)/);
  const sM = str.match(/(\d+(?:\.\d+)?)s/);
  if (hM || mM || sM) {
    let total = 0;
    if (hM) total += parseFloat(hM[1]) * 60;
    if (mM) total += parseFloat(mM[1]);
    if (sM) total += parseFloat(sM[1]) / 60;
    return total > 0 ? total : null;
  }

  // Pure number — ≤ 10 treated as hours, otherwise as minutes
  const num = parseFloat(str.replace(/[^\d.]/g, ''));
  if (!isNaN(num) && num > 0) return num <= 10 ? num * 60 : num;
  return null;
}

/**
 * Convert total minutes to CPE hours: round to nearest 0.25, clamp [0.25, 40].
 */
function minutesToCPEHours(minutes) {
  if (!minutes || minutes <= 0) return 0.25;
  return Math.min(40, Math.max(0.25, Math.round((minutes / 60) / 0.25) * 0.25));
}

// --- Multi-domain helpers ---
function parseDomains(row) {
  const raw = row.domains || row.domain || "";
  return raw.split("|").map(s => s.trim()).filter(Boolean);
}

function badgeDomains(row) {
  const parts = parseDomains(row);
  if (!parts.length) return "<span class='domain-badge'>—</span>";
  return parts.map(d =>
    `<span class="domain-badge" title="${escHtml(d)}">${escHtml(DOMAIN_SHORT[d] || d.slice(0,3).toUpperCase())}</span>`
  ).join("");
}

function domainMultiSelect(row) {
  const selected = new Set(parseDomains(row));
  const checks = DOMAINS.map(d => `
    <label class="domain-check">
      <input type="checkbox" value="${escHtml(d)}" ${selected.has(d) ? "checked" : ""}>
      ${escHtml(d)}
    </label>`).join("");
  return `
    <details class="domain-picker" data-id="${row.id}">
      <summary>${badgeDomains(row)}</summary>
      <div class="domain-picker-dropdown">${checks}</div>
    </details>`;
}

function saveDomains(rowId, detailsEl) {
  const checked = [...detailsEl.querySelectorAll("input[type=checkbox]:checked")]
    .map(cb => cb.value);
  if (!checked.length) return;
  const domainsStr = checked.join("|");
  const summary = detailsEl.querySelector("summary");
  if (summary) summary.innerHTML = badgeDomains({ domains: domainsStr });
  const idx = allRows.findIndex(r => r.id === rowId);
  if (idx !== -1) { allRows[idx].domains = domainsStr; allRows[idx].domain = checked[0]; }
  updateField(rowId, "domains", domainsStr);
}

// --- Vendor / certification helpers ---

/**
 * Set the active vendor set, persist to localStorage, and update input rules.
 * Accepts an array of vendor IDs; defaults to ["isc2"] if empty.
 */
function applyVendors(ids) {
  const valid = ids.filter(id => VENDOR_IDS.includes(id));
  if (!valid.length) return;  // refuse to clear all modes
  activeVendors = new Set(valid);
  localStorage.setItem("cpe_vendors", JSON.stringify([...activeVendors]));
  // Sync colOrder: add missing vendor cols, remove inactive ones
  VENDOR_IDS.forEach(id => {
    const colId = "vendor-" + id;
    if (activeVendors.has(id) && !colOrder.includes(colId)) colOrder.push(colId);
    if (!activeVendors.has(id)) colOrder = colOrder.filter(c => c !== colId);
  });
  updateCPEInputRules();
  // Refresh table headers and vendor stats if dashboard is loaded
  if (typeof renderHeaders === "function" && $("col-headers")) {
    renderHeaders();
    renderTable();
    _renderSidebarFromRows(allRows);
  }
}

function updateCPEInputRules() {
  const r = _mergedVendorRules();
  const el = $("add-hours");
  if (el) { el.min = r.min; el.max = r.max; el.step = r.step; }
}

/** Load active vendors from localStorage (with backward compat for old single-vendor key). */
function loadActiveVendors() {
  try {
    const saved = JSON.parse(localStorage.getItem("cpe_vendors"));
    if (Array.isArray(saved) && saved.length) { applyVendors(saved); return; }
  } catch {}
  // Backward compat: migrate old single-vendor key, default to isc2 only on first run
  const legacy = localStorage.getItem("cpe_vendor");
  applyVendors([legacy || "isc2"]);
}

// --- Proof cell ---
function proofCell(row) {
  if (row.proof_image) {
    return `<img class="proof-thumb"
      src="/api/cpes/${row.id}/proof?t=${Date.now()}"
      title="Click to view proof"
      onclick="openProofViewer('${row.id}')"
      alt="proof">`;
  }
  return `<button class="btn-upload-proof" onclick="triggerProofUploadForRow('${row.id}')">+ Proof</button>`;
}

function openProofViewer(rowId) {
  window.open(`/api/cpes/${rowId}/proof`, "_blank");
}

/**
 * Extract a comparable sort key for the given column from a row object.
 * Returns a lowercase string for text columns, a number for hours, an
 * ISO date string for date columns, and "" for non-sortable columns.
 * @param {string} colId
 * @param {Object} row
 * @returns {string|number}
 */
function getSortValue(colId, row) {
  switch (colId) {
    case 'title':    return (row.title    || '').toLowerCase();
    case 'released': return row.published_date || '';
    case 'fetched':  return row.fetched_date   || '';
    case 'hours':    return parseFloat(row.cpe_hours) || 0;
    case 'type':     return row.type   || '';
    case 'status':   return row.status || '';
    case 'notes':    return (row.notes  || '').toLowerCase();
    case 'source':   return (row.source || '').toLowerCase();
    default:         return '';
  }
}

// ---------------------------------------------------------------------------
// Column definitions
// Delete column is always pinned last, not in COLUMNS.
// ---------------------------------------------------------------------------
const COLUMNS = [
  { id: "title",    label: "Title",
    td: row => `<td class="title-cell"><a href="${row.url||'#'}" target="_blank" title="${escHtml(row.title)}">${escHtml(row.title)}</a></td>` },
  { id: "subtitle", label: "Subtitle",
    td: row => `<td style="font-size:11px;color:var(--text-muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(row.subtitle||'')}</td>` },
  { id: "released", label: "Released",
    td: row => `<td style="white-space:nowrap;font-size:12px;color:var(--text-muted)">${fmtDate(row.published_date)}</td>` },
  { id: "duration", label: "Duration",
    td: row => `<td style="white-space:nowrap;font-size:12px;color:var(--text-muted)">${fmtDuration(row.duration)}</td>` },
  { id: "type",     label: "Type",
    td: row => `<td>${badgeType(row.type||"podcast")}</td>` },
  { id: "domains",  label: "Domains",
    td: row => `<td>${domainMultiSelect(row)}</td>` },
  { id: "status",   label: "Status",
    td: row => `<td><select class="editable" onchange="updateField('${row.id}','status',this.value)">${statusOptions(row.status)}</select></td>` },
  { id: "notes",    label: "Notes",
    td: row => `<td class="notes-cell"><input class="editable" type="text" value="${escHtml(row.notes||'')}" placeholder="Add notes…" onblur="updateField('${row.id}','notes',this.value)" style="width:100%;min-width:120px"></td>` },
  { id: "proof",    label: "Proof",
    td: row => `<td>${proofCell(row)}</td>` },
  { id: "source",   label: "Source",
    td: row => `<td style="font-size:11px;color:var(--text-muted)">${escHtml(row.source||'')}</td>` },
  { id: "fetched",  label: "Fetched",
    td: row => `<td>${fmtDate(row.fetched_date)}</td>` },
  { id: "submit",   label: "Submit",
    td: row => `<td><button class="btn-secondary btn-sm" onclick="openSubmitModal('${row.id}')">Submit</button></td>` },
];

// --- Column prefs (order, hidden, widths) ---
// colOrder is the single source of truth for column ordering.
// Vendor columns are stored here as "vendor-isc2", "vendor-isaca", etc.
let colOrder  = COLUMNS.map(c => c.id);  // populated properly in loadColPrefs()
let colHidden = new Set();
let colWidths = {};

function _defaultColOrder() {
  const staticIds = COLUMNS.map(c => c.id);
  const vendorIds = [...activeVendors].map(id => "vendor-" + id);
  return [...staticIds, ...vendorIds];
}

function loadColPrefs() {
  try {
    const h = JSON.parse(localStorage.getItem("cpe_col_hidden"));
    if (Array.isArray(h)) colHidden = new Set(h);
  } catch {}
  try {
    const w = JSON.parse(localStorage.getItem("cpe_col_widths"));
    if (w && typeof w === "object") colWidths = w;
  } catch {}
  try {
    // v2 key stores static + vendor col IDs in one array
    const o = JSON.parse(localStorage.getItem("cpe_col_order_v2"));
    if (Array.isArray(o) && o.length) {
      const staticIds  = COLUMNS.map(c => c.id);
      const vendorPfx  = "vendor-";
      // Keep only valid entries
      colOrder = o.filter(id =>
        staticIds.includes(id) ||
        (id.startsWith(vendorPfx) && VENDOR_IDS.includes(id.slice(vendorPfx.length)))
      );
      // Append any static cols not yet present
      staticIds.forEach(id => { if (!colOrder.includes(id)) colOrder.push(id); });
      // Append active vendor cols not yet present; remove inactive ones
      const activeVendorCols = [...activeVendors].map(id => vendorPfx + id);
      colOrder = colOrder.filter(id => !id.startsWith(vendorPfx) || activeVendorCols.includes(id));
      activeVendorCols.forEach(id => { if (!colOrder.includes(id)) colOrder.push(id); });
      return;
    }
  } catch {}
  // Fallback: rebuild from legacy keys or defaults
  colOrder = _defaultColOrder();
}

function saveColPrefs() {
  localStorage.setItem("cpe_col_order_v2", JSON.stringify(colOrder));
  localStorage.setItem("cpe_col_hidden",   JSON.stringify([...colHidden]));
  localStorage.setItem("cpe_col_widths",   JSON.stringify(colWidths));
}

// Returns 1-based index within VISIBLE columns (for nth-child selectors)
function getColIndex(id) {
  const visible = colOrder.filter(c => !colHidden.has(c));
  const i = visible.indexOf(id);
  return i === -1 ? -1 : i + 1;
}

// --- Column drag-and-drop ---
let _dragColId    = null;
let _resizing     = false;
let _colDnDReady  = false;
let _pickerDragId = null;

function renderHeaders() {
  const tr = $("col-headers");

  // Single unified pass: colOrder now contains both static ("title") and
  // vendor ("vendor-isc2") col IDs in whatever order the user arranged them.
  tr.innerHTML =
    `<th class="th-check"><input type="checkbox" id="select-all-cb" title="Select all" onchange="toggleSelectAll(this.checked)"></th>` +
    colOrder.map(id => {
      if (colHidden.has(id)) return "";
      if (id.startsWith("vendor-")) {
        const vid = id.slice(7);
        if (!activeVendors.has(vid)) return "";
        const v = VENDORS[vid];
        return `<th data-col="${id}" draggable="true" style="white-space:nowrap;cursor:grab">` +
          `<span class="cert-badge cert-${vid}">${v.name}</span> ${v.label}</th>`;
      }
      const col = COLUMNS.find(c => c.id === id);
      if (!col) return "";
      const w  = colWidths[id] ? `style="width:${colWidths[id]}px;min-width:${colWidths[id]}px"` : "";
      const si = sortCol === id
        ? `<span class="sort-icon">${sortDir === 'asc' ? '↑' : '↓'}</span>`
        : `<span class="sort-icon sort-icon--idle">⇅</span>`;
      return `<th data-col="${id}" draggable="true" ${w}>${col.label}${si}<span class="col-resize" data-col="${id}"></span></th>`;
    }).join("") +
    `<th class="th-delete" style="width:70px"></th>`;
  updateSelectAllCb();

  // Sort on click — static cols only
  tr.querySelectorAll("th[data-col]").forEach(th => {
    th.addEventListener("click", () => {
      if (_resizing || _dragColId) return;
      const id = th.dataset.col;
      if (id.startsWith("vendor-")) return;
      if (sortCol === id) {
        if (sortDir === 'asc') sortDir = 'desc';
        else { sortCol = null; sortDir = null; }
      } else {
        sortCol = id;
        sortDir = 'asc';
      }
      renderHeaders();
      renderTable();
    });

    // dragstart / dragend on individual TH for visual feedback
    th.addEventListener("dragstart", e => {
      if (_resizing) { e.preventDefault(); return; }
      _dragColId = th.dataset.col;
      th.classList.add("col-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    th.addEventListener("dragend", () => {
      document.querySelectorAll("th[data-col]").forEach(h =>
        h.classList.remove("col-dragging", "drag-over"));
      _dragColId = null;
    });
  });

  // Column resize handles (static cols only)
  tr.querySelectorAll(".col-resize").forEach(handle => {
    handle.addEventListener("mousedown", e => {
      e.stopPropagation();
      e.preventDefault();
      _resizing = true;
      const colId  = handle.dataset.col;
      const th     = handle.parentElement;
      const startX = e.pageX;
      const startW = th.offsetWidth;
      document.body.style.cursor     = "col-resize";
      document.body.style.userSelect = "none";
      function onMove(e) {
        const w = Math.max(40, startW + e.pageX - startX);
        th.style.width    = w + "px";
        th.style.minWidth = w + "px";
      }
      function onUp() {
        colWidths[colId] = th.offsetWidth;
        saveColPrefs();
        document.body.style.cursor     = "";
        document.body.style.userSelect = "";
        setTimeout(() => { _resizing = false; }, 0);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  });

  // Document-level dragover + drop — attached once; finds closest column TH
  // by x-coordinate so drop works anywhere on page regardless of exact target.
  if (!_colDnDReady) {
    _colDnDReady = true;

    function _closestColTh(clientX) {
      const ths = [...document.querySelectorAll("th[data-col]")];
      return ths.reduce((p, h) => {
        const r = h.getBoundingClientRect();
        const d = Math.abs(clientX - (r.left + r.width / 2));
        return (!p || d < p.d) ? { h, d } : p;
      }, null);
    }

    document.addEventListener("dragover", e => {
      if (!_dragColId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const closest = _closestColTh(e.clientX);
      document.querySelectorAll("th[data-col]").forEach(h => h.classList.remove("drag-over"));
      if (closest) closest.h.classList.add("drag-over");
    });

    document.addEventListener("drop", e => {
      if (!_dragColId) return;
      e.preventDefault();
      document.querySelectorAll("th[data-col]").forEach(h => h.classList.remove("drag-over"));
      const closest = _closestColTh(e.clientX);
      if (!closest) return;
      const targetId = closest.h.dataset.col;
      if (_dragColId === targetId) return;
      const from = colOrder.indexOf(_dragColId);
      const to   = colOrder.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        colOrder.splice(from, 1);
        colOrder.splice(to, 0, _dragColId);
        saveColPrefs();
      }
      renderHeaders();
      renderTable();
    });
  }
}

// --- Column visibility picker ---
function buildColPicker() {
  const picker = $("col-picker");

  // Single unified list in colOrder sequence (static + vendor interleaved)
  const rows = colOrder.map(id => {
    const isVendor = id.startsWith("vendor-");
    const vid = isVendor ? id.slice(7) : null;
    if (isVendor && !activeVendors.has(vid)) return ""; // skip inactive vendor cols
    const label = isVendor
      ? `<span class="cert-badge cert-${vid}" style="font-size:9px">${VENDORS[vid].name}</span> ${VENDORS[vid].label}`
      : escHtml(COLUMNS.find(c => c.id === id)?.label || id);
    const checked = !colHidden.has(id) ? "checked" : "";
    return `<div class="col-picker-row" draggable="true" data-col-id="${id}">
      <span class="col-picker-handle">&#x2807;</span>
      <label class="domain-check" style="flex:1;margin:0;cursor:inherit">
        <input type="checkbox" onchange="toggleColVisibility('${id}',this.checked)" ${checked}>
        ${label}
      </label>
    </div>`;
  }).join("");

  picker.innerHTML = rows;

  picker.querySelectorAll(".col-picker-row").forEach(row => {
    row.addEventListener("dragstart", e => {
      _pickerDragId = row.dataset.colId;
      row.classList.add("col-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.stopPropagation();
    });
    row.addEventListener("dragend", () => {
      picker.querySelectorAll(".col-picker-row").forEach(r =>
        r.classList.remove("col-dragging", "drag-over"));
      _pickerDragId = null;
    });
    row.addEventListener("dragover", e => {
      if (!_pickerDragId) return;
      e.preventDefault();
      e.stopPropagation();
      picker.querySelectorAll(".col-picker-row").forEach(r => r.classList.remove("drag-over"));
      row.classList.add("drag-over");
    });
    row.addEventListener("drop", e => {
      if (!_pickerDragId) return;
      e.preventDefault();
      e.stopPropagation();
      picker.querySelectorAll(".col-picker-row").forEach(r => r.classList.remove("drag-over"));
      const targetId = row.dataset.colId;
      if (_pickerDragId === targetId) return;
      const from = colOrder.indexOf(_pickerDragId);
      const to   = colOrder.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        colOrder.splice(from, 1);
        colOrder.splice(to, 0, _pickerDragId);
        saveColPrefs();
      }
      renderHeaders();
      renderTable();
      buildColPicker();
    });
  });
}

function toggleColVisibility(colId, visible) {
  if (visible) colHidden.delete(colId);
  else         colHidden.add(colId);
  saveColPrefs();
  renderHeaders();
  renderTable();
}

function toggleColPicker() {
  const picker = $("col-picker");
  if (picker.classList.contains("open")) {
    picker.classList.remove("open");
    return;
  }
  buildColPicker();
  const btn  = $("btn-columns");
  const rect = btn.getBoundingClientRect();
  picker.style.top   = (rect.bottom + 4) + "px";
  picker.style.right = (window.innerWidth - rect.right) + "px";
  picker.classList.add("open");
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around fetch() that throws on non-2xx responses.
 * Returns parsed JSON, or null for 204 No Content responses.
 * @param {string} path - API path (e.g. "/api/cpes")
 * @param {RequestInit} opts - fetch options
 */
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Data loading and table rendering
// ---------------------------------------------------------------------------

/**
 * Fetch CPE entries from the API using current filter values and store them
 * in allRows, then re-render the table.
 */
async function loadCPEs() {
  const params = new URLSearchParams();
  if (filters.domain)    params.set("domain", filters.domain);
  if (filters.status)    params.set("status", filters.status);
  if (filters.type)      params.set("type", filters.type);
  if (filters.date_from) params.set("date_from", filters.date_from);
  if (filters.date_to)   params.set("date_to", filters.date_to);
  const qs = params.toString();
  rawRows = await apiFetch("/api/cpes" + (qs ? "?" + qs : ""));
  _buildSourceDropdown(rawRows);
  allRows = rawRows.filter(r =>
    (!filters.source   || (r.source || "") === filters.source) &&
    (!filters.has_proof || !!r.proof_image)
  );
  _renderSidebarFromRows(allRows);
  renderTable();
}

/**
 * Re-render the table body from allRows, applying the current sort and
 * respecting column visibility.  Re-attaches domain-picker event listeners
 * after each render since innerHTML replaces the old DOM nodes.
 */
function renderTable() {
  const tbody = $("cpe-tbody");
  $("row-count").textContent = allRows.length + " records";

  let rows = allRows;
  if (sortCol && sortDir) {
    rows = [...allRows].sort((a, b) => {
      const av = getSortValue(sortCol, a);
      const bv = getSortValue(sortCol, b);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  const visibleColOrder = colOrder.filter(id => {
    if (colHidden.has(id)) return false;
    if (id.startsWith("vendor-")) return activeVendors.has(id.slice(7));
    return true;
  });
  const totalCols = visibleColOrder.length + 2; // +checkbox +delete

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="${totalCols}">
        <div class="empty-state">
          <strong>No CPE records found</strong>
          <p>Click "Fetch Now" to pull Security Now episodes, or add one manually.</p>
        </div>
      </td></tr>`;
    updateSelectAllCb();
    updateBulkBar();
    return;
  }

  const r = _mergedVendorRules();
  tbody.innerHTML = rows.map(row => {
    const cells = visibleColOrder.map(id => {
      if (id.startsWith("vendor-")) {
        const vid = id.slice(7);
        const v = VENDORS[vid];
        if (!vendorAcceptsType(vid, row.type)) {
          return `<td style="text-align:center;color:var(--text-dim);font-size:12px" title="${v.name} only counts webinars">—</td>`;
        }
        const hrs = parseFloat(row.cpe_hours) || r.min;
        return `<td style="white-space:nowrap"><input class="editable vendor-hours-input" type="number" min="${r.min}" max="${r.max}" step="${r.step}" value="${hrs}" onchange="updateVendorHours('${row.id}',parseFloat(this.value))" style="width:60px"> <span style="font-size:10px;color:var(--text-dim)">${v.label}</span></td>`;
      }
      const rawTd = COLUMNS.find(c => c.id === id).td(row);
      return rawTd.replace('<td', `<td data-col="${id}"`);
    }).join("");

    const isSelected = selectedIds.has(row.id);
    const isTrash = filters.status === "deleted";
    const actionCell = isTrash
      ? `<td class="td-delete" style="white-space:nowrap"><button class="btn-secondary btn-sm" onclick="restoreCPE('${row.id}')">Restore</button> <button class="btn-danger btn-sm" onclick="purgeCPE('${row.id}')">Purge</button></td>`
      : `<td class="td-delete"><button class="btn-danger" onclick="deleteCPE('${row.id}')">Delete</button></td>`;
    return `<tr data-id="${row.id}"${isSelected ? ' class="row-selected"' : ''}>
      <td class="td-check"><input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleRowSelect('${row.id}', this.checked)"></td>
      ${cells}${actionCell}</tr>`;
  }).join("");

  // Domain picker listeners
  document.querySelectorAll(".domain-picker").forEach(el => {
    el.addEventListener("change", () => saveDomains(el.dataset.id, el));
    el.addEventListener("toggle", () => {
      if (el.open) {
        document.querySelectorAll(".domain-picker[open]").forEach(other => {
          if (other !== el) other.removeAttribute("open");
        });
      }
    });
  });

  updateSelectAllCb();
  updateBulkBar();
}

// --- Submission Modal ---
function openSubmitModal(rowId) {
  const row = allRows.find(r => r.id === rowId);
  if (!row) return;
  activeSubmitRowId = rowId;

  $("submit-title").textContent        = row.title || "";
  $("submit-presenter").textContent    = row.presenter || "—";
  $("submit-year").textContent         = getYear(row.published_date) || "—";

  // General webinar notice (shows regardless of which vendor modes are active)
  const entryType = row.type || "podcast";
  const webinarNotice = $("submit-webinar-notice");
  if (webinarNotice) webinarNotice.style.display = entryType === "webinar" ? "" : "none";

  // Per-vendor CPE/CEU breakdown with proof reminders for webinar entries
  const cpeHours = parseFloat(row.cpe_hours) || 1;
  const cpeFields = $("submit-cpe-fields");
  if (cpeFields) {
    const active = VENDOR_IDS.filter(id => activeVendors.has(id));
    cpeFields.innerHTML = active.map(id => {
      const v = VENDORS[id];
      if (!vendorAcceptsType(id, entryType)) {
        return `<div class="submit-field">
          <label><span class="cert-badge cert-${id}" style="margin-right:4px">${v.name}</span>${v.label}</label>
          <div class="submit-value submit-value--na">— Not applicable (${entryType}s do not count toward ${v.name})</div>
        </div>`;
      }
      // Calculation hint (webinar-specific rules)
      let calcHint = "";
      if (entryType === "webinar") {
        if (id === "isaca") {
          calcHint = `<div class="submit-calc-hint">1 CPE per 50 min of active participation, reported in 0.25 hr increments</div>`;
        } else if (id === "comptia") {
          calcHint = `<div class="submit-calc-hint">1 CEU per hour of live webinar attendance</div>`;
        }
      }
      // Proof reminder (webinar-specific)
      let proofReminder = "";
      if (entryType === "webinar") {
        if (id === "comptia") {
          proofReminder = `<div class="submit-proof-reminder submit-proof-reminder--required">
            &#9888; CompTIA requires proof of registration or proof of completion for webinar submissions.
          </div>`;
        } else if (id === "isaca") {
          proofReminder = `<div class="submit-proof-reminder submit-proof-reminder--recommended">
            &#128161; ISACA recommends keeping proof of completion (screenshot or certificate) for webinar activities.
          </div>`;
        }
      }
      return `<div class="submit-field">
        <label><span class="cert-badge cert-${id}" style="margin-right:4px">${v.name}</span>${v.label}</label>
        ${calcHint}
        <div class="submit-value" id="submit-cpe-${id}">${cpeHours}</div>
        <div class="submit-actions">
          <button class="btn-secondary btn-sm" onclick="copySubmitField('submit-cpe-${id}')">Copy</button>
        </div>
        ${proofReminder}
      </div>`;
    }).join("");
  }
  // Pre-fill with saved summary; fall back to the feed description as a starting point
  $("submit-summary").value = row.cpe_summary || row.description || "";
  const descBtn = $("btn-use-description");
  if (descBtn) {
    descBtn.dataset.description = row.description || "";
    descBtn.style.display = row.description ? "inline-flex" : "none";
  }

  const preview = $("submit-proof-preview");
  const delBtn  = $("btn-submit-delete-proof");
  if (row.proof_image) {
    preview.innerHTML = `<img src="/api/cpes/${rowId}/proof?t=${Date.now()}" alt="Completion proof">`;
    delBtn.style.display = "inline-block";
  } else {
    preview.innerHTML = `<div class="proof-placeholder">No screenshot uploaded yet.<br>Upload a screenshot showing the podcast near the end as proof of completion.</div>`;
    delBtn.style.display = "none";
  }

  $("submit-modal").classList.add("open");
}

function closeSubmitModal() {
  activeSubmitRowId = null;
  $("submit-modal").classList.remove("open");
}

function copySubmitField(elemId) {
  const el = $(elemId);
  const text = el.tagName === "TEXTAREA" ? el.value : el.textContent;
  navigator.clipboard.writeText(text).then(
    ()  => showToast("Copied to clipboard"),
    ()  => showToast("Copy failed — select the text manually", "error")
  );
}

async function saveSummary() {
  if (!activeSubmitRowId) return;
  const summary = $("submit-summary").value;
  try {
    await apiFetch(`/api/cpes/${activeSubmitRowId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cpe_summary: summary }),
    });
    const idx = allRows.findIndex(r => r.id === activeSubmitRowId);
    if (idx !== -1) allRows[idx].cpe_summary = summary;
    showToast("Summary saved");
  } catch (e) {
    showToast("Save failed: " + e.message, "error");
  }
}

function useEpisodeDescription() {
  const descBtn = $("btn-use-description");
  if (!descBtn || !descBtn.dataset.description) return;
  $("submit-summary").value = descBtn.dataset.description;
  saveSummary();
  showToast("Feed description loaded — edit to your own words");
}

// --- Proof upload ---
function triggerProofUpload() {
  $("proof-file-input").dataset.target = activeSubmitRowId || "";
  $("proof-file-input").click();
}

function triggerProofUploadForRow(rowId) {
  $("proof-file-input").dataset.target = rowId;
  $("proof-file-input").click();
}

async function handleProofFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  const rowId = event.target.dataset.target;
  if (!rowId) return;
  event.target.value = "";

  const formData = new FormData();
  formData.append("file", file);

  try {
    showToast("Uploading…");
    await fetch(`/api/cpes/${rowId}/proof`, { method: "POST", body: formData });

    const idx = allRows.findIndex(r => r.id === rowId);
    if (idx !== -1) allRows[idx].proof_image = file.name;

    showToast("Proof screenshot uploaded");

    const proofIdx = getColIndex("proof");
    if (proofIdx > 0) {
      const tableRow = document.querySelector(`tr[data-id="${rowId}"] td:nth-child(${proofIdx})`);
      if (tableRow) {
        const img = document.createElement("img");
        img.className = "proof-thumb";
        img.src = `/api/cpes/${rowId}/proof?t=${Date.now()}`;
        img.title = "Click to view proof";
        img.alt = "proof";
        img.onclick = () => openProofViewer(rowId);
        tableRow.innerHTML = "";
        tableRow.appendChild(img);
      }
    }

    if (activeSubmitRowId === rowId) {
      $("submit-proof-preview").innerHTML = `<img src="/api/cpes/${rowId}/proof?t=${Date.now()}" alt="Completion proof">`;
      $("btn-submit-delete-proof").style.display = "inline-block";
    }
  } catch (e) {
    showToast("Upload failed: " + e.message, "error");
  }
}

async function deleteProof() {
  if (!activeSubmitRowId) return;
  if (!confirm("Remove this proof screenshot?")) return;
  try {
    await apiFetch(`/api/cpes/${activeSubmitRowId}/proof`, { method: "DELETE" });
    const idx = allRows.findIndex(r => r.id === activeSubmitRowId);
    if (idx !== -1) allRows[idx].proof_image = "";

    $("submit-proof-preview").innerHTML = `<div class="proof-placeholder">No screenshot uploaded yet.</div>`;
    $("btn-submit-delete-proof").style.display = "none";

    const rowId = activeSubmitRowId;
    const proofIdx = getColIndex("proof");
    if (proofIdx > 0) {
      const tableRow = document.querySelector(`tr[data-id="${rowId}"] td:nth-child(${proofIdx})`);
      if (tableRow) {
        tableRow.innerHTML = `<button class="btn-upload-proof" onclick="triggerProofUploadForRow('${rowId}')">+ Proof</button>`;
      }
    }
    showToast("Proof removed");
  } catch (e) {
    showToast("Remove failed: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Summary dashboard
// ---------------------------------------------------------------------------

/**
 * Fetch aggregated stats from GET /api/summary and update the four summary
 * cards and the domain-hours breakdown list.
 */
/**
 * Compute summary stats from the current filtered row set and update the sidebar.
 */
function _renderSidebarFromRows(rows) {
  let totalHours = 0;
  const byStatus = {};
  const byVendor = {};
  for (const r of rows) {
    const h = parseFloat(r.cpe_hours) || 0;
    totalHours += h;
    const st = r.status || "pending";
    byStatus[st] = (byStatus[st] || 0) + 1;
    for (const vid of VENDOR_IDS) {
      if (activeVendors.has(vid) && vendorAcceptsType(vid, r.type)) {
        byVendor[vid] = (byVendor[vid] || 0) + h;
      }
    }
  }
  const th = $("total-hours");   if (th) th.textContent = totalHours.toFixed(1);
  const te = $("total-entries"); if (te) te.textContent = rows.length;
  const ac = $("approved-count");if (ac) ac.textContent = byStatus.submitted || 0;
  const pc = $("pending-count"); if (pc) pc.textContent = byStatus.pending   || 0;
  _renderVendorStats(byVendor);
}

/**
 * Render per-vendor CPE/CEU breakdown in the sidebar.
 * @param {Object} byVendor - map of vendorId → total hours (filtered by entry type)
 */
function _renderVendorStats(byVendor) {
  const el = $("vendor-stats");
  if (!el) return;
  const active = VENDOR_IDS.filter(id => activeVendors.has(id));
  el.innerHTML = active.map(id => {
    const v = VENDORS[id];
    const hrs = (byVendor[id] || 0).toFixed(1);
    const restricted = VENDOR_TYPES[id] !== null;
    const hint = restricted
      ? `<span style="font-size:9px;color:var(--text-dim);display:block;text-align:right">webinar only</span>`
      : "";
    return `<div class="vendor-stat-row" style="flex-wrap:wrap">
      <span class="cert-badge cert-${id}">${v.name}</span>
      <span class="vendor-stat-hrs">${hrs} ${v.label}${hint}</span>
    </div>`;
  }).join("")
  || `<div style="color:var(--text-dim);font-size:11px">No modes selected</div>`;
}

async function loadSummary() {
  try {
    const s = await apiFetch("/api/summary");
    $("total-hours").textContent    = s.total_hours.toFixed(1);
    $("total-entries").textContent  = s.total_entries;
    $("approved-count").textContent = s.by_status.submitted || 0;
    $("pending-count").textContent  = s.by_status.pending  || 0;
    // Compute per-vendor totals from current rawRows (respects VENDOR_TYPES restrictions)
    const byVendor = {};
    for (const r of rawRows) {
      const h = parseFloat(r.cpe_hours) || 0;
      for (const vid of VENDOR_IDS) {
        if (activeVendors.has(vid) && vendorAcceptsType(vid, r.type)) {
          byVendor[vid] = (byVendor[vid] || 0) + h;
        }
      }
    }
    _renderVendorStats(byVendor);
  } catch (e) { console.error("Summary error", e); }
}

// ---------------------------------------------------------------------------
// Inline field editing
// ---------------------------------------------------------------------------

/**
 * PATCH a single field on a CPE entry via PUT /api/cpes/{id} and refresh
 * the summary dashboard on success.
 * @param {string} id    - Entry UUID
 * @param {string} field - Field name (must be in the server's allowed set)
 * @param {*}      value - New value
 */
/**
 * Update cpe_hours from any vendor column input and sync all sibling vendor
 * inputs for that row so they all reflect the same value.
 */
function updateVendorHours(rowId, value) {
  const r = _mergedVendorRules();
  const v = Math.min(r.max, Math.max(r.min, isNaN(value) ? r.min : value));
  document.querySelectorAll(`tr[data-id="${rowId}"] .vendor-hours-input`).forEach(inp => {
    inp.value = v;
  });
  const idx = allRows.findIndex(r => r.id === rowId);
  if (idx !== -1) allRows[idx].cpe_hours = v;
  updateField(rowId, "cpe_hours", v);
}

async function updateField(id, field, value) {
  try {
    await apiFetch(`/api/cpes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    showToast("Saved");
    await loadSummary();
  } catch (e) {
    showToast("Save failed: " + e.message, "error");
  }
}

async function deleteCPE(id) {
  if (!confirm("Delete this CPE entry?")) return;
  try {
    await apiFetch(`/api/cpes/${id}`, { method: "DELETE" });
    showToast("Moved to Trash — select \"Trash\" in Status filter to restore");
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Delete failed: " + e.message, "error");
  }
}

async function restoreCPE(id) {
  try {
    await apiFetch(`/api/cpes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "pending" }),
    });
    showToast("Entry restored");
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Restore failed: " + e.message, "error");
  }
}

async function purgeCPE(id) {
  if (!confirm("Permanently delete this entry? It cannot be recovered and may be re-fetched from RSS.")) return;
  try {
    await apiFetch(`/api/cpes/${id}/purge`, { method: "DELETE" });
    showToast("Permanently deleted");
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Purge failed: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Multi-select and bulk actions
// ---------------------------------------------------------------------------

function toggleRowSelect(id, checked) {
  if (checked) selectedIds.add(id);
  else selectedIds.delete(id);
  const tr = document.querySelector(`tr[data-id="${id}"]`);
  if (tr) tr.classList.toggle("row-selected", checked);
  updateSelectAllCb();
  updateBulkBar();
}

function toggleSelectAll(checked) {
  allRows.forEach(r => { if (checked) selectedIds.add(r.id); else selectedIds.delete(r.id); });
  renderTable();
  updateBulkBar();
}

function updateSelectAllCb() {
  const cb = $("select-all-cb");
  if (!cb || !allRows.length) { if (cb) { cb.checked = false; cb.indeterminate = false; } return; }
  const n = allRows.filter(r => selectedIds.has(r.id)).length;
  cb.checked       = n === allRows.length;
  cb.indeterminate = n > 0 && n < allRows.length;
}

function clearSelection() {
  selectedIds.clear();
  renderTable();
  updateBulkBar();
}

function updateBulkBar() {
  const bar = $("bulk-bar");
  if (!bar) return;
  const count = selectedIds.size;
  $("bulk-count").textContent = count + " selected";
  const isTrash = filters.status === "deleted";
  const editSec = $("bulk-edit-section");
  const restBtn = $("bulk-restore-btn");
  const delBtn  = $("bulk-delete-btn");
  if (editSec) editSec.style.display = isTrash ? "none" : "flex";
  if (restBtn) restBtn.style.display = isTrash ? "" : "none";
  if (delBtn)  delBtn.textContent    = isTrash ? "Purge Selected" : "Delete Selected";
  if (count > 0) bar.classList.add("visible");
  else           bar.classList.remove("visible");
}

function updateBulkValueInput() {
  const field = $("bulk-field").value;
  const wrap  = $("bulk-value-wrap");
  if (field === "status") {
    wrap.innerHTML = `<select id="bulk-value">${STATUSES.map(s => `<option value="${s}">${s}</option>`).join("")}</select>`;
  } else if (field === "domains") {
    wrap.innerHTML = `<select id="bulk-value">${DOMAINS.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join("")}</select>`;
  } else if (field === "cpe_hours") {
    const r = _mergedVendorRules();
    wrap.innerHTML = `<input type="number" id="bulk-value" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.min}" style="width:72px">`;
  } else {
    wrap.innerHTML = "";
  }
}

async function bulkApply() {
  const field = $("bulk-field").value;
  const valEl = $("bulk-value");
  if (!field || !valEl) { showToast("Choose a field and value", "error"); return; }
  const value = valEl.value;
  if (value === "") { showToast("Enter a value", "error"); return; }
  const ids = [...selectedIds];
  if (!ids.length) return;
  const payload = field === "cpe_hours" ? { cpe_hours: parseFloat(value) } : { [field]: value };
  try {
    await Promise.all(ids.map(id => apiFetch(`/api/cpes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })));
    showToast(`Updated ${ids.length} entr${ids.length === 1 ? "y" : "ies"}`);
    selectedIds.clear();
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Bulk update failed: " + e.message, "error");
  }
}

async function bulkDelete() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const isTrash = filters.status === "deleted";
  const label   = isTrash ? "permanently delete" : "move to Trash";
  if (!confirm(`${isTrash ? "Purge" : "Delete"} ${ids.length} entr${ids.length === 1 ? "y" : "ies"}? This will ${label}.`)) return;
  try {
    await Promise.all(ids.map(id =>
      apiFetch(isTrash ? `/api/cpes/${id}/purge` : `/api/cpes/${id}`, { method: "DELETE" })
    ));
    showToast(isTrash
      ? `${ids.length} entr${ids.length === 1 ? "y" : "ies"} permanently deleted`
      : `${ids.length} entr${ids.length === 1 ? "y" : "ies"} moved to Trash`);
    selectedIds.clear();
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Bulk delete failed: " + e.message, "error");
  }
}

async function bulkRestore() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  try {
    await Promise.all(ids.map(id => apiFetch(`/api/cpes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "pending" }),
    })));
    showToast(`${ids.length} entr${ids.length === 1 ? "y" : "ies"} restored`);
    selectedIds.clear();
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Restore failed: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

async function exportVisiblePDF() {
  if (!allRows.length) { showToast("No entries to export", "error"); return; }
  await _doExportPDF(allRows);
}

async function _doExportPDF(rows) {
  try {
    const totalHours = rows.reduce((sum, r) => sum + (parseFloat(r.cpe_hours) || 0), 0);
    const html = buildPDFHTML(rows, totalHours, window.location.origin);
    const blob = new Blob([html], { type: "text/html" });
    const url  = URL.createObjectURL(blob);
    const win  = window.open(url, "_blank");
    if (!win) {
      URL.revokeObjectURL(url);
      showToast("Pop-up blocked — allow pop-ups for this site and try again", "error");
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    showToast("PDF export failed: " + e.message, "error");
  }
}

async function exportPDF() {
  const ids = [...selectedIds];
  if (!ids.length) { showToast("Select entries to export", "error"); return; }
  const rows = allRows.filter(r => selectedIds.has(r.id));
  if (!rows.length) { showToast("No selected entries visible in current view", "error"); return; }
  await _doExportPDF(rows);
}

function buildPDFHTML(rows, totalHours, origin) {
  const now = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const css = `
    @page { size: letter; margin: 0.75in 1in; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           font-size: 10pt; color: #1a1a2e; background: #fff; line-height: 1.5; }

    /* ---- Cover ---- */
    .cover { padding: 40px 0 0; }
    .cover-logo { font-size: 54pt; font-weight: 900; font-family: Georgia, serif;
                  color: #1e3a5f; letter-spacing: -0.02em; line-height: 1; margin-bottom: 4px; }
    .cover h1 { font-size: 17pt; font-weight: 300; letter-spacing: 0.08em; text-transform: uppercase;
                color: #555; font-family: Georgia, serif; margin-bottom: 3px; }
    .cover-date { font-size: 9pt; color: #999; margin-bottom: 32px; }
    .cover-rule { height: 3px; background: linear-gradient(90deg, #1e3a5f, #4a7db5 60%, transparent);
                  margin-bottom: 28px; }
    .stat-row { display: flex; gap: 18px; margin-bottom: 32px; }
    .stat-box { padding: 16px 26px; border: 1px solid #c8d8ea; border-top: 4px solid #1e3a5f; text-align: center; }
    .stat-number { font-size: 38pt; font-weight: 700; color: #1e3a5f;
                   font-family: Georgia, serif; line-height: 1; }
    .stat-label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.16em; color: #999; margin-top: 4px; }

    /* ---- Cover TOC ---- */
    .toc-label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.16em; color: #1e3a5f;
                 font-weight: 700; margin-bottom: 7px; border-bottom: 1px solid #c8d8ea; padding-bottom: 3px; }
    .toc { width: 100%; border-collapse: collapse; font-size: 8pt; }
    .toc th { background: #1e3a5f; color: #fff; padding: 6px 8px; text-align: left;
               font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; font-size: 6.5pt; }
    .toc th.r, .toc td.r { text-align: right; }
    .toc td { padding: 5px 8px; border-bottom: 1px solid #eef1f5; vertical-align: top; }
    .toc tr:nth-child(even) td { background: #f7f9fc; }
    .toc tfoot td { background: #edf1f8; border-top: 2px solid #1e3a5f; border-bottom: none;
                    font-weight: 700; color: #1e3a5f; }
    .toc .n { width: 22px; color: #aaa; }
    .toc .h { font-weight: 600; color: #1e3a5f; white-space: nowrap; }
    .toc .d { white-space: nowrap; color: #777; }

    /* ---- Episode pages ---- */
    .page { break-after: page; padding-top: 2px; }
    .ep-eyebrow { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.18em;
                  color: #999; margin-bottom: 5px; }
    .ep-title { font-size: 15pt; font-weight: 600; font-family: Georgia, serif;
                color: #1a1a2e; line-height: 1.25; margin-bottom: 3px; }
    .ep-subtitle { font-size: 9.5pt; color: #777; font-style: italic; margin-bottom: 12px; }
    .ep-rule { height: 2px; background: linear-gradient(90deg, #1e3a5f, #4a7db5 60%, transparent);
               margin-bottom: 14px; }

    .meta-grid { display: grid; grid-template-columns: repeat(5, 1fr);
                 border: 1px solid #c8d8ea; border-left: 4px solid #1e3a5f;
                 background: #f2f6fb; margin-bottom: 14px; }
    .meta-item { padding: 9px 11px; border-right: 1px solid #dae3ee; }
    .meta-item:last-child { border-right: none; }
    .meta-lbl { font-size: 6.5pt; text-transform: uppercase; letter-spacing: 0.14em;
                color: #999; font-weight: 700; margin-bottom: 2px; }
    .meta-val { font-size: 9pt; font-weight: 600; color: #1a1a2e; }

    .sec { margin-bottom: 11px; }
    .sec-lbl { font-size: 6.5pt; text-transform: uppercase; letter-spacing: 0.16em;
               color: #1e3a5f; font-weight: 700; margin-bottom: 4px;
               border-bottom: 1px solid #c8d8ea; padding-bottom: 3px; }
    .sec-text { font-size: 9pt; line-height: 1.65; color: #333; white-space: pre-wrap; word-break: break-word; }
    .sec-url { font-size: 8pt; color: #1e3a5f; word-break: break-all; font-family: 'Courier New', monospace; }
    .domains { display: flex; flex-wrap: wrap; gap: 5px; }
    .domain-tag { background: #e2ecf7; color: #1e3a5f; padding: 2px 8px;
                  font-size: 7.5pt; font-weight: 600; letter-spacing: 0.04em; }

    .submit-sec { background: #fffbf0; border: 1px solid #dfc87a;
                border-left: 4px solid #c97d10; padding: 11px 13px; margin-bottom: 11px; }
    .submit-sec .sec-lbl { color: #c97d10; border-bottom-color: #dfc87a; }
    .submit-sec .sec-text { color: #2a1f00; }
    .submit-sec .sec-text.empty { color: #bbb; font-style: italic; }

    .proof-img { max-width: 100%; max-height: 560px; object-fit: contain;
                 border: 1px solid #dde; display: block; margin: 8px auto 0; }
    .submitted-stamp { font-size: 8pt; color: #27704a; font-weight: 600;
                       text-align: center; margin: 12px 0 4px;
                       padding: 6px 12px; border: 1px solid #a8d5b8;
                       background: #f0faf4; letter-spacing: 0.03em; }
    .footer { font-size: 7pt; color: #bbb; text-align: right;
              margin-top: 16px; padding-top: 6px; border-top: 1px solid #eee; }

    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .page { break-after: page; }
    }`;

  // Cover — episode table
  const tocRows = rows.map((r, i) => `
    <tr>
      <td class="n">${i + 1}</td>
      <td>${escHtml(r.title)}</td>
      <td style="font-size:7.5pt;color:#555">${escHtml((r.domains || r.domain || "").split("|")[0].trim())}</td>
      <td class="r h">${parseFloat(r.cpe_hours || 0).toFixed(2)}</td>
      <td class="d">${fmtDate(r.published_date)}</td>
    </tr>`).join("");

  const cover = `
  <div class="cover page">
    <div class="cover-logo">CPE</div>
    <h1>CPE Activity Report</h1>
    <div class="cover-date">Generated ${escHtml(now)}</div>
    <div class="cover-rule"></div>
    <div class="stat-row">
      <div class="stat-box">
        <div class="stat-number">${totalHours.toFixed(1)}</div>
        <div class="stat-label">Total CPE Hours</div>
      </div>
      <div class="stat-box">
        <div class="stat-number">${rows.length}</div>
        <div class="stat-label">Activities</div>
      </div>
    </div>
    <div class="toc-label">Activities Included</div>
    <table class="toc">
      <thead><tr>
        <th class="n">#</th><th>Title</th><th>Domain</th>
        <th class="r">Hours</th><th>Date</th>
      </tr></thead>
      <tbody>${tocRows}</tbody>
      <tfoot><tr>
        <td colspan="3" style="text-align:right">Total</td>
        <td class="r">${totalHours.toFixed(2)}</td><td></td>
      </tr></tfoot>
    </table>
    <div class="footer">Cybersecurity CPE Tracker &mdash; ${escHtml(now)}</div>
  </div>`;

  // One page per episode
  const pages = rows.map((row, i) => {
    const domains = (row.domains || row.domain || "").split("|").map(s => s.trim()).filter(Boolean);
    const proof   = row.proof_image
      ? `<div class="sec"><div class="sec-lbl">Completion Proof</div>
         <img class="proof-img" src="${origin}/api/cpes/${row.id}/proof" alt="Proof"></div>`
      : "";
    const summaryText = row.cpe_summary
      ? `<div class="sec-text">${escHtml(row.cpe_summary)}</div>`
      : `<div class="sec-text empty">No summary written yet — open the submission panel to draft one.</div>`;

    return `
  <div class="page">
    <div class="ep-eyebrow">Activity ${i + 1} of ${rows.length}</div>
    <div class="ep-title">${escHtml(row.title)}</div>
    ${row.subtitle ? `<div class="ep-subtitle">${escHtml(row.subtitle)}</div>` : ""}
    <div class="ep-rule"></div>
    <div class="meta-grid">
      <div class="meta-item"><div class="meta-lbl">Presenter</div>
        <div class="meta-val">${escHtml(row.presenter || "Steve Gibson")}</div></div>
      <div class="meta-item"><div class="meta-lbl">Published</div>
        <div class="meta-val">${fmtDate(row.published_date)}</div></div>
      <div class="meta-item"><div class="meta-lbl">Duration</div>
        <div class="meta-val">${fmtDuration(row.duration)}</div></div>
      <div class="meta-item"><div class="meta-lbl">CPE Hours</div>
        <div class="meta-val">${parseFloat(row.cpe_hours || 0).toFixed(2)}</div></div>
      <div class="meta-item"><div class="meta-lbl">Status</div>
        <div class="meta-val" style="text-transform:capitalize">${escHtml(row.status || "pending")}</div></div>
    </div>
    ${domains.length ? `<div class="sec"><div class="sec-lbl">CISSP Domain(s)</div>
      <div class="domains">${domains.map(d => `<span class="domain-tag">${escHtml(d)}</span>`).join("")}</div></div>` : ""}
    ${row.url ? `<div class="sec"><div class="sec-lbl">Source URL</div>
      <div class="sec-url">${escHtml(row.url)}</div></div>` : ""}
    ${row.description ? `<div class="sec"><div class="sec-lbl">Episode Description</div>
      <div class="sec-text">${escHtml(row.description)}</div></div>` : ""}
    <div class="submit-sec"><div class="sec-lbl">Submission Summary</div>${summaryText}</div>
    ${row.notes ? `<div class="sec"><div class="sec-lbl">Notes</div>
      <div class="sec-text">${escHtml(row.notes)}</div></div>` : ""}
    ${proof}
    ${row.submitted_date ? `<div class="submitted-stamp">Submitted on ${escHtml(fmtDate(row.submitted_date))}</div>` : ""}
    <div class="footer">Cybersecurity CPE Tracker &mdash; ${escHtml(row.title)} &mdash; ${escHtml(now)}</div>
  </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CPE Report &mdash; ${escHtml(now)}</title>
  <style>${css}</style>
</head>
<body>
${cover}
${pages}
<script>
(function() {
  function doPrint() { setTimeout(function() { window.print(); }, 500); }
  var imgs = document.querySelectorAll('img');
  if (!imgs.length) { doPrint(); return; }
  var pending = imgs.length;
  function done() { if (--pending === 0) doPrint(); }
  imgs.forEach(function(img) {
    if (img.complete && img.naturalWidth > 0) { done(); }
    else { img.addEventListener('load', done); img.addEventListener('error', done); }
  });
})();
<\/script>
</body>
</html>`;
}

async function fetchNow() {
  const btn = $("btn-fetch");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Fetching…';
  try {
    const r = await apiFetch("/api/fetch", { method: "POST" });
    showToast(`Fetched ${r.fetched} items, added ${r.added} new`);
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Fetch failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Fetch Now";
  }
}

function exportCSV() { window.location.href = "/api/export"; }

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

/** Populate the Domain filter <select> with all known CISSP domain names. */
function buildFilterBar() {
  $("filter-domain").innerHTML = `<option value="">All Domains</option>` +
    DOMAINS.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join("");
}

/** Populate the Source filter <select> from distinct source values in rows. */
function _buildSourceDropdown(rows) {
  const sel = $("filter-source");
  const current = sel.value;
  const sources = [...new Set(rows.map(r => r.source || "").filter(Boolean))].sort();
  sel.innerHTML = `<option value="">All Sources</option>` +
    sources.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join("");
  if (sources.includes(current)) sel.value = current;
}

function applyFilters() {
  filters.domain    = $("filter-domain").value;
  filters.status    = $("filter-status").value;
  filters.type      = $("filter-type").value;
  filters.source    = $("filter-source").value;
  filters.has_proof = $("filter-has-proof").checked;
  filters.date_from = $("filter-from").value;
  filters.date_to   = $("filter-to").value;
  loadCPEs();
}

function clearFilters() {
  $("filter-domain").value = $("filter-status").value =
    $("filter-type").value = $("filter-source").value =
    $("filter-from").value = $("filter-to").value = "";
  $("filter-has-proof").checked = false;
  filters = { domain: "", status: "", type: "", source: "", has_proof: false, date_from: "", date_to: "" };
  loadCPEs();
}

/**
 * Set the date range filter to a named preset and apply filters.
 * @param {"7d"|"cur-month"|"prev-month"|"cur-year"|"prev-year"} preset
 */
function setDatePreset(preset) {
  const now = new Date();
  let from, to = now;
  if (preset === "7d") {
    from = new Date(now); from.setDate(from.getDate() - 6);
  } else if (preset === "cur-month") {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (preset === "prev-month") {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to   = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (preset === "cur-year") {
    from = new Date(now.getFullYear(), 0, 1);
  } else if (preset === "prev-year") {
    from = new Date(now.getFullYear() - 1, 0, 1);
    to   = new Date(now.getFullYear() - 1, 11, 31);
  }
  const fmt = d => d.toISOString().slice(0, 10);
  $("filter-from").value = fmt(from);
  $("filter-to").value   = fmt(to);
  applyFilters();
}

// ---------------------------------------------------------------------------
// Add CPE form
// ---------------------------------------------------------------------------

/** Toggle the Add CPE form panel open/closed. */
function toggleAddForm() { $("add-form").classList.toggle("open"); }

function buildAddForm() {
  $("add-domain-checks").innerHTML = DOMAINS.map(d => `
    <label class="domain-check">
      <input type="checkbox" name="add-domain" value="${escHtml(d)}"
        ${d === "Security Operations" ? "checked" : ""}>
      ${escHtml(d)}
    </label>`).join("");

  // Wire up duration → CPE hours auto-fill
  const durEl   = $("add-duration");
  const hoursEl = $("add-hours");
  if (durEl && hoursEl) {
    durEl.addEventListener("input", () => {
      const minutes = parseDurationInput(durEl.value);
      if (minutes !== null && minutes > 0) {
        hoursEl.value = minutesToCPEHours(minutes);
      }
    });
  }
}

async function submitAddForm(e) {
  e.preventDefault();
  const checkedDomains = [...document.querySelectorAll('input[name="add-domain"]:checked')]
    .map(cb => cb.value);
  if (!checkedDomains.length) { showToast("Select at least one domain", "error"); return; }
  const title = $("add-title").value.trim();
  if (!title) { showToast("Title is required", "error"); return; }

  const body = {
    title,
    description:    $("add-description").value.trim(),
    url:            $("add-url").value.trim(),
    published_date: $("add-pubdate").value ? new Date($("add-pubdate").value).toISOString() : new Date().toISOString(),
    source:         "Manual",
    type:           $("add-type").value,
    duration:       $("add-duration").value.trim(),
    cpe_hours:      parseFloat($("add-hours").value) || 1.0,
    domain:         checkedDomains[0],
    domains:        checkedDomains.join("|"),
    presenter:      $("add-presenter").value.trim(),
    notes:          $("add-notes").value.trim(),
    status:         "pending",
  };

  try {
    await apiFetch("/api/cpes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showToast("CPE added successfully");
    $("add-cpe-form").reset();
    buildAddForm();
    $("add-form").classList.remove("open");
    await loadCPEs();
    await loadSummary();
  } catch (e) {
    showToast("Add failed: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * App entry point — called once on DOMContentLoaded.
 * Loads persisted column preferences, wires up all event listeners,
 * then fetches the summary and CPE rows in parallel.
 */
async function init() {
  // Apply saved light/dark mode (before first paint)
  applyMode(localStorage.getItem("cpe_mode") || "dark");

  // Apply saved (or default) colour theme before first render
  applyTheme(localStorage.getItem("cpe_theme") || "amber");

  // Wire up colour theme swatches
  document.querySelectorAll(".theme-swatch").forEach(sw => {
    sw.addEventListener("click", () => applyTheme(sw.dataset.theme));
  });

  // Apply saved vendor/CPE mode(s)
  loadActiveVendors();

  loadColPrefs();
  renderHeaders();
  buildFilterBar();
  buildAddForm();
  $("filter-status").value = "";

  $("btn-fetch").addEventListener("click", fetchNow);
  $("btn-export").addEventListener("click", exportCSV);
  $("btn-add").addEventListener("click", toggleAddForm);
  $("btn-columns").addEventListener("click", toggleColPicker);
  $("btn-filter").addEventListener("click", applyFilters);
  $("btn-clear-filters").addEventListener("click", clearFilters);
  $("add-cpe-form").addEventListener("submit", submitAddForm);
  $("proof-file-input").addEventListener("change", handleProofFileSelected);

  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSubmitModal(); });

  // Close col picker when clicking outside
  document.addEventListener("click", e => {
    const picker = $("col-picker");
    const btn    = $("btn-columns");
    if (picker.classList.contains("open") && !picker.contains(e.target) && e.target !== btn) {
      picker.classList.remove("open");
    }
  });

  await loadCPEs();
}

document.addEventListener("DOMContentLoaded", init);

// ---------------------------------------------------------------------------
// Macrodata Refinement — minigame
// ---------------------------------------------------------------------------

const _MDR_BINS = [
  { id: 'WO', glow: '#5470c6' },
  { id: 'FC', glow: '#4dc68a' },
  { id: 'DR', glow: '#c64a4a' },
  { id: 'MA', glow: '#8a5ac6' },
];
let _mdrState = null;

const _MDR_WORDS_A = [
  'Cold','Dark','Iron','Broken','Silent','Black','Silver','Deep','Wild','Hollow',
  'Crimson','Pale','Sharp','Fallen','Frozen','Hidden','Steel','Stone','Ash','Amber',
  'Scarlet','Bright','Empty','Distant','Burning','Ancient','Bitter','Lost','Blind',
  'Smoke','Quiet','Leaden','Violet','Bone','Cinder','Veiled','Sunken','Grave','Ivory',
];
const _MDR_WORDS_B = [
  'Harbor','Ridge','Valley','Creek','Summit','Falls','Point','Shore','Basin','Gate',
  'Haven','Station','Reach','Timber','Signal','Archive','Threshold','Vector','Passage',
  'Watch','Anchor','Meridian','Cipher','Quarry','Lantern','Vigil','Horizon','Ledger',
  'Pinnacle','Covenant','Current','Canopy','Column','Lattice','Pendant','Hollow',
  'Crossing','Remnant','Meridian','Trench','Rampart','Margin','Descent','Specter',
];
function _mdrCodename() {
  const a = _MDR_WORDS_A[Math.floor(Math.random() * _MDR_WORDS_A.length)];
  const b = _MDR_WORDS_B[Math.floor(Math.random() * _MDR_WORDS_B.length)];
  return a + ' ' + b;
}

function openMDR() {
  if (window.innerWidth < 768) return;
  _mdrInit(_mdrCodename());
}

function closeMDR() {
  const ov = document.getElementById('mdr-overlay');
  if (ov) ov.style.display = 'none';
  if (_mdrState) {
    clearInterval(_mdrState.ambientTimer);
    _mdrState.nums.forEach(n => { clearInterval(n.hoverTimer); clearTimeout(n.sortTimer); });
  }
  _mdrState = null;
}

function _mdrInit(fileId) {
  const TOTAL = 16;
  const nums = Array.from({ length: TOTAL }, (_, i) => ({
    id: i, value: Math.floor(Math.random() * 10),
    sorted: false, el: null, hoverTimer: null, sortTimer: null,
  }));
  _mdrState = { fileId, nums, counts: [0, 0, 0, 0], total: TOTAL, ambientTimer: null };

  document.getElementById('mdr-file-id').textContent = fileId;
  document.getElementById('mdr-pct').textContent = '0%';
  document.getElementById('mdr-status-msg').textContent = 'Hover to feel a number.';
  document.getElementById('mdr-victory').style.display = 'none';

  const grid = document.getElementById('mdr-grid');
  grid.innerHTML = '';

  // decorative background digits — non-interactive, fill the screen
  const bgEls = [];
  for (let i = 0; i < 80; i++) {
    const el = document.createElement('div');
    el.className = 'mdr-number';
    el.style.pointerEvents = 'none';
    el.textContent = Math.floor(Math.random() * 10);
    const r = Math.random();
    const sz = r < 0.45 ? 8  + Math.floor(Math.random() * 6)   // 8–13px
             : r < 0.80 ? 15 + Math.floor(Math.random() * 10)  // 15–24px
             : 26 + Math.floor(Math.random() * 16);             // 26–41px
    el.style.fontSize = sz + 'px';
    el.style.opacity  = (0.08 + Math.random() * 0.18).toFixed(2);
    el.style.left = (1 + Math.random() * 96).toFixed(1) + '%';
    el.style.top  = (1 + Math.random() * 96).toFixed(1) + '%';
    grid.appendChild(el);
    bgEls.push(el);
  }

  // game digits — interactive, larger, brighter
  const placed = [];
  nums.forEach(n => {
    const cell = document.createElement('div');
    cell.className = 'mdr-number';
    cell.textContent = n.value;

    const r = Math.random();
    const sz = r < 0.35 ? 20 + Math.floor(Math.random() * 10)  // 20–29px
             : r < 0.72 ? 30 + Math.floor(Math.random() * 12)  // 30–41px
             : 44 + Math.floor(Math.random() * 14);             // 44–57px
    cell.style.fontSize = sz + 'px';
    cell.dataset.baseSz = sz;
    cell.style.opacity  = (0.40 + Math.random() * 0.42).toFixed(2);

    let left, top, tries = 0;
    do {
      left = 4 + Math.random() * 84;
      top  = 4 + Math.random() * 84;
      tries++;
    } while (tries < 30 && placed.some(p => Math.abs(p[0] - left) < 10 && Math.abs(p[1] - top) < 10));
    placed.push([left, top]);
    cell.style.left = left.toFixed(1) + '%';
    cell.style.top  = top.toFixed(1)  + '%';

    cell.addEventListener('mouseenter', () => {
      if (n.sorted) return;
      const hoverSz = Math.max(48, parseInt(cell.dataset.baseSz) + 18);
      cell.style.fontSize = hoverSz + 'px';
      cell.style.opacity = '1';
      n.hoverTimer = setInterval(() => {
        cell.textContent = Math.floor(Math.random() * 10);
      }, 50);
      cell.classList.add('mdr-selected');
      document.getElementById('mdr-status-msg').textContent = 'Feeling ' + n.value + '…';
      n.sortTimer = setTimeout(() => _mdrAutoSort(n.id), 700);
    });

    cell.addEventListener('mouseleave', () => {
      clearInterval(n.hoverTimer); n.hoverTimer = null;
      clearTimeout(n.sortTimer);   n.sortTimer  = null;
      if (!n.sorted) {
        cell.classList.remove('mdr-selected');
        cell.textContent = n.value;
        cell.style.fontSize = cell.dataset.baseSz + 'px';
        cell.style.opacity  = (0.40 + Math.random() * 0.42).toFixed(2);
      }
    });

    grid.appendChild(cell);
    n.el = cell;
  });

  // ambient — bg digits constantly shift; game digits occasionally flicker
  _mdrState.ambientTimer = setInterval(() => {
    if (!_mdrState) return;
    for (let i = 0; i < 5; i++)
      bgEls[Math.floor(Math.random() * bgEls.length)].textContent = Math.floor(Math.random() * 10);
    if (Math.random() < 0.35) {
      const idle = _mdrState.nums.filter(x => !x.sorted && x.hoverTimer === null);
      if (!idle.length) return;
      const pick = idle[Math.floor(Math.random() * idle.length)];
      let f = 0;
      const t = setInterval(() => {
        if (!pick.el || pick.sorted) { clearInterval(t); return; }
        pick.el.textContent = Math.floor(Math.random() * 10);
        if (++f >= 4) { clearInterval(t); if (!pick.sorted && !pick.hoverTimer) pick.el.textContent = pick.value; }
      }, 55);
    }
  }, 180);

  const binsRow = document.getElementById('mdr-bins-row');
  binsRow.innerHTML = '';
  _MDR_BINS.forEach((b, i) => {
    const bin = document.createElement('div');
    bin.className = 'mdr-bin';
    bin.innerHTML = `
      <div class="mdr-bin-label">${b.id}</div>
      <div class="mdr-bin-track"><div class="mdr-bin-fill" id="mdr-fill-${i}" style="height:0%;background:${b.glow}"></div></div>
      <div class="mdr-bin-count" id="mdr-bcount-${i}">0</div>
    `;
    binsRow.appendChild(bin);
  });

  document.getElementById('mdr-overlay').style.display = 'flex';
}

function _mdrAutoSort(id) {
  if (!_mdrState) return;
  const n = _mdrState.nums[id];
  if (n.sorted) return;
  clearInterval(n.hoverTimer); n.hoverTimer = null;
  clearTimeout(n.sortTimer);   n.sortTimer  = null;
  const binIdx = Math.floor(Math.random() * 4);
  n.sorted = true;
  n.el.classList.remove('mdr-selected');
  n.el.classList.add('mdr-sorted');
  setTimeout(() => { if (n.el) n.el.style.opacity = '0'; }, 80);
  _mdrState.counts[binIdx]++;
  const filled = _mdrState.nums.filter(x => x.sorted).length;
  const pct    = Math.round(filled / _mdrState.total * 100);
  document.getElementById('mdr-bcount-' + binIdx).textContent = _mdrState.counts[binIdx];
  document.getElementById('mdr-fill-'   + binIdx).style.height =
    Math.min(100, _mdrState.counts[binIdx] / 4 * 100) + '%';
  document.getElementById('mdr-pct').textContent = pct + '%';
  document.getElementById('mdr-status-msg').textContent = filled + ' of ' + _mdrState.total + ' numbers refined.';
  if (filled === _mdrState.total) setTimeout(_mdrVictory, 450);
}

function _mdrVictory() {
  document.getElementById('mdr-victory').style.display = 'flex';
}

document.addEventListener('keydown', e => {
  const ov = document.getElementById('mdr-overlay');
  if (!_mdrState || !ov || ov.style.display === 'none') return;
  if (e.key === 'Escape') closeMDR();
});

(function _mdrScheduleInvite() {
  if (window.innerWidth < 768) return;
  if (Math.random() > 0.01) return;
  const delay = 35000 + Math.random() * 50000;
  setTimeout(() => {
    const ov = document.getElementById('mdr-overlay');
    if (ov && ov.style.display !== 'none') return;
    if (document.getElementById('mdr-invite')) return;
    const fileId = _mdrCodename();
    const inv = document.createElement('div');
    inv.id = 'mdr-invite';
    inv.className = 'mdr-invite';
    inv.innerHTML = `
      <div class="mdr-inv-corp">CPE Industries</div>
      <div class="mdr-inv-msg">Macrodata file <strong>${fileId}</strong> requires your immediate refinement.</div>
      <div class="mdr-inv-btns">
        <button class="mdr-inv-dismiss" onclick="document.getElementById('mdr-invite').remove()">Dismiss</button>
        <button class="mdr-inv-begin" onclick="_mdrInit('${fileId}');document.getElementById('mdr-invite').remove()">Begin Refinement</button>
      </div>
    `;
    document.body.appendChild(inv);
    setTimeout(() => { if (inv.parentNode) inv.remove(); }, 18000);
  }, delay);
})();

// ---------------------------------------------------------------------------
// Lumon sidebar quote — appears intermittently, not on every load
// ---------------------------------------------------------------------------

(function () {
  const Q = [
    "And all in Lumon\u2019s care shall revel in the bounty of the incentives spur.",
    "Come now, children of my industry, and know the children of my blood.",
    "Keep a merry humor ever in your heart.",
    "Let not weakness live in your veins. Cherished workers, drown it inside you. Rise up from your deathbed and sally forth, more perfect for the struggle.",
    "Render not my creation in miniature.",
    "Be content in my words, and dally not in the scholastic pursuits of lesser men.",
    "No workplace shall be repurposed for slumber.",
    "And I shall whisper to ye dutiful through the ages. In your noblest thoughts and epiphanies shall be my voice. You are my mouth, and through ye, I will whisper on when I am 10 centuries demised.",
    "The light of discovery shines truer upon a virgin meadow than a beaten path.",
    "Be ever merry.",
    "The surest way to tame a prisoner is to let him believe he\u2019s free.",
    "Tame in me the tempers four that I may serve thee evermore. Place in me the values nine that I may feel thy touch divine.",
    "Endow in each swing of your ax or swipe of your pen the sum of your affections, that through me they may be purified and returned. No higher purpose may be found than this. Nor any\u2026 higher love.",
    "I know that death is near upon me, because people have begun to ask what I see as my life\u2019s great achievement. They wish to know how they should remember me as I rot. In my life, I have identified four components, which I call tempers, from which are derived every human soul. Woe. Frolic. Dread. Malice. Each man\u2019s character is defined by the precise ratio that resides in him. I walked into the cave of my own mind, and there I tamed them. Should you tame the tempers as I did mine, then the world shall become but your appendage. It is this great and consecrated power that I hope to pass on to all of you, my children.",
  ];

  function pick() { return Q[Math.floor(Math.random() * Q.length)]; }

  function showQuote() {
    if (document.getElementById('quote-notify')) return;
    const n = document.createElement('div');
    n.id = 'quote-notify';
    n.className = 'quote-notify';
    n.innerHTML = `
      <div class="quote-notify-corp">CPE Industries</div>
      <div class="quote-notify-text">\u201c${pick()}\u201d</div>
      <div class="quote-notify-dismiss" onclick="document.getElementById('quote-notify').remove()">Dismiss</div>
    `;
    document.body.appendChild(n);
    setTimeout(() => { if (n.parentNode) n.remove(); }, 22000);
  }

  function scheduleNext() {
    setTimeout(() => {
      if (Math.random() < 0.01) showQuote();
      scheduleNext();
    }, 270000 + Math.random() * 330000);
  }

  window.showQuote = showQuote;

  // 1% chance to show once ~15s after load
  if (Math.random() < 0.01) setTimeout(showQuote, 14000 + Math.random() * 10000);
  scheduleNext();
})();
