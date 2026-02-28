/**
 * ISC2 CPE Tracker — main frontend script.
 *
 * This is a single-file vanilla JS SPA; no build step or framework required.
 *
 * Responsibilities:
 *  - Render and manage the interactive CPE data table (sort, filter, edit in-place)
 *  - Column customisation: show/hide, resize, drag-to-reorder (all persisted in localStorage)
 *  - ISC2 submission modal: display pre-filled fields and save user summaries
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

// --- State ---
let allRows = [];
let filters = { domain: "", status: "pending", type: "", date_from: "", date_to: "" };
let activeISC2RowId = null;
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
  { id: "hours",    label: "Hours",
    td: row => `<td><input class="editable" type="number" min="0.25" max="40" step="0.25" value="${parseFloat(row.cpe_hours)||1}" onchange="updateField('${row.id}','cpe_hours',parseFloat(this.value))" style="width:70px"></td>` },
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
  { id: "isc2",     label: "ISC2",
    td: row => `<td><button class="btn-secondary btn-sm" onclick="openISC2Modal('${row.id}')">ISC2</button></td>` },
];

// --- Column prefs (order, hidden, widths) ---
let colOrder  = COLUMNS.map(c => c.id);
let colHidden = new Set();
let colWidths = {};

function loadColPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem("cpe_col_order"));
    if (Array.isArray(o) && o.length === COLUMNS.length && o.every(id => COLUMNS.some(c => c.id === id)))
      colOrder = o;
  } catch {}
  try {
    const h = JSON.parse(localStorage.getItem("cpe_col_hidden"));
    if (Array.isArray(h)) colHidden = new Set(h);
  } catch {}
  try {
    const w = JSON.parse(localStorage.getItem("cpe_col_widths"));
    if (w && typeof w === "object") colWidths = w;
  } catch {}
}

function saveColPrefs() {
  localStorage.setItem("cpe_col_order",  JSON.stringify(colOrder));
  localStorage.setItem("cpe_col_hidden", JSON.stringify([...colHidden]));
  localStorage.setItem("cpe_col_widths", JSON.stringify(colWidths));
}

// Returns 1-based index within VISIBLE columns (for nth-child selectors)
function getColIndex(id) {
  const visible = colOrder.filter(c => !colHidden.has(c));
  const i = visible.indexOf(id);
  return i === -1 ? -1 : i + 1;
}

// --- Column drag-and-drop ---
let _dragColId  = null;
let _resizing   = false;

function renderHeaders() {
  const tr = $("col-headers");
  tr.innerHTML =
    `<th class="th-check"><input type="checkbox" id="select-all-cb" title="Select all" onchange="toggleSelectAll(this.checked)"></th>` +
    colOrder.map(id => {
      if (colHidden.has(id)) return "";
      const col = COLUMNS.find(c => c.id === id);
      const w   = colWidths[id] ? `style="width:${colWidths[id]}px;min-width:${colWidths[id]}px"` : "";
      const si  = sortCol === id
        ? `<span class="sort-icon">${sortDir === 'asc' ? '↑' : '↓'}</span>`
        : `<span class="sort-icon sort-icon--idle">⇅</span>`;
      return `<th data-col="${id}" draggable="true" ${w}>${col.label}${si}<span class="col-resize" data-col="${id}"></span></th>`;
    }).join("") +
    `<th class="th-delete" style="width:70px"></th>`;
  updateSelectAllCb();

  tr.querySelectorAll("th[draggable]").forEach(th => {
    // Sort on click (skip if resizing or drag just finished)
    th.addEventListener("click", () => {
      if (_resizing || _dragColId) return;
      const id = th.dataset.col;
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

    // Drag-to-reorder
    th.addEventListener("dragstart", e => {
      if (_resizing) { e.preventDefault(); return; }
      _dragColId = th.dataset.col;
      th.classList.add("col-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    th.addEventListener("dragend", () => {
      tr.querySelectorAll("th").forEach(h => h.classList.remove("col-dragging", "drag-over"));
      _dragColId = null;
    });
    th.addEventListener("dragover", e => {
      e.preventDefault();
      tr.querySelectorAll("th").forEach(h => h.classList.remove("drag-over"));
      th.classList.add("drag-over");
    });
    th.addEventListener("dragleave", () => th.classList.remove("drag-over"));
    th.addEventListener("drop", e => {
      e.preventDefault();
      const targetId = th.dataset.col;
      if (!_dragColId || _dragColId === targetId) return;
      const from = colOrder.indexOf(_dragColId);
      const to   = colOrder.indexOf(targetId);
      colOrder.splice(from, 1);
      colOrder.splice(to, 0, _dragColId);
      saveColPrefs();
      renderHeaders();
      renderTable();
    });
  });

  // Column resize handles
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
}

// --- Column visibility picker ---
function buildColPicker() {
  const picker = $("col-picker");
  picker.innerHTML = COLUMNS.map(col => `
    <label class="domain-check">
      <input type="checkbox" onchange="toggleColVisibility('${col.id}',this.checked)"
        ${!colHidden.has(col.id) ? "checked" : ""}>
      ${escHtml(col.label)}
    </label>`).join("");
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
  allRows = await apiFetch("/api/cpes" + (qs ? "?" + qs : ""));
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

  const visibleCols = colOrder.filter(id => !colHidden.has(id));

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

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="${visibleCols.length + 2}">
        <div class="empty-state">
          <strong>No CPE records found</strong>
          <p>Click "Fetch Now" to pull Security Now episodes, or add one manually.</p>
        </div>
      </td></tr>`;
    updateSelectAllCb();
    updateBulkBar();
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const cells = visibleCols
      .map(id => {
        const rawTd = COLUMNS.find(c => c.id === id).td(row);
        // Inject data-col so CSS media queries can show/hide individual columns
        return rawTd.replace('<td', `<td data-col="${id}"`);
      })
      .join("");
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

// --- ISC2 Modal ---
function openISC2Modal(rowId) {
  const row = allRows.find(r => r.id === rowId);
  if (!row) return;
  activeISC2RowId = rowId;

  $("isc2-title").textContent        = row.title || "";
  $("isc2-presenter").textContent    = row.presenter || "—";
  $("isc2-year").textContent         = getYear(row.published_date) || "—";
  $("isc2-cpe-credits").textContent  = parseFloat(row.cpe_hours) || 1;
  // Pre-fill with saved summary; fall back to the feed description as a starting point
  $("isc2-summary").value = row.isc2_summary || row.description || "";
  const descBtn = $("btn-use-description");
  if (descBtn) {
    descBtn.dataset.description = row.description || "";
    descBtn.style.display = row.description ? "inline-flex" : "none";
  }

  const preview = $("isc2-proof-preview");
  const delBtn  = $("btn-isc2-delete-proof");
  if (row.proof_image) {
    preview.innerHTML = `<img src="/api/cpes/${rowId}/proof?t=${Date.now()}" alt="Completion proof">`;
    delBtn.style.display = "inline-block";
  } else {
    preview.innerHTML = `<div class="proof-placeholder">No screenshot uploaded yet.<br>Upload a screenshot showing the podcast near the end as proof of completion.</div>`;
    delBtn.style.display = "none";
  }

  $("isc2-modal").classList.add("open");
}

function closeISC2Modal() {
  activeISC2RowId = null;
  $("isc2-modal").classList.remove("open");
}

function copyISC2Field(elemId) {
  const el = $(elemId);
  const text = el.tagName === "TEXTAREA" ? el.value : el.textContent;
  navigator.clipboard.writeText(text).then(
    ()  => showToast("Copied to clipboard"),
    ()  => showToast("Copy failed — select the text manually", "error")
  );
}

async function saveISC2Summary() {
  if (!activeISC2RowId) return;
  const summary = $("isc2-summary").value;
  try {
    await apiFetch(`/api/cpes/${activeISC2RowId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isc2_summary: summary }),
    });
    const idx = allRows.findIndex(r => r.id === activeISC2RowId);
    if (idx !== -1) allRows[idx].isc2_summary = summary;
    showToast("Summary saved");
  } catch (e) {
    showToast("Save failed: " + e.message, "error");
  }
}

function useEpisodeDescription() {
  const descBtn = $("btn-use-description");
  if (!descBtn || !descBtn.dataset.description) return;
  $("isc2-summary").value = descBtn.dataset.description;
  saveISC2Summary();
  showToast("Feed description loaded — edit to your own words");
}

// --- Proof upload ---
function triggerProofUpload() {
  $("proof-file-input").dataset.target = activeISC2RowId || "";
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

    if (activeISC2RowId === rowId) {
      $("isc2-proof-preview").innerHTML = `<img src="/api/cpes/${rowId}/proof?t=${Date.now()}" alt="Completion proof">`;
      $("btn-isc2-delete-proof").style.display = "inline-block";
    }
  } catch (e) {
    showToast("Upload failed: " + e.message, "error");
  }
}

async function deleteProof() {
  if (!activeISC2RowId) return;
  if (!confirm("Remove this proof screenshot?")) return;
  try {
    await apiFetch(`/api/cpes/${activeISC2RowId}/proof`, { method: "DELETE" });
    const idx = allRows.findIndex(r => r.id === activeISC2RowId);
    if (idx !== -1) allRows[idx].proof_image = "";

    $("isc2-proof-preview").innerHTML = `<div class="proof-placeholder">No screenshot uploaded yet.</div>`;
    $("btn-isc2-delete-proof").style.display = "none";

    const rowId = activeISC2RowId;
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
async function loadSummary() {
  try {
    const s = await apiFetch("/api/summary");
    $("total-hours").textContent    = s.total_hours.toFixed(1);
    $("total-entries").textContent  = s.total_entries;
    $("approved-count").textContent = s.by_status.submitted || 0;
    $("pending-count").textContent  = s.by_status.pending  || 0;

    const dl = $("domain-list");
    const entries = Object.entries(s.by_domain).sort((a, b) => b[1] - a[1]);
    const maxH = entries[0]?.[1] || 1;
    dl.innerHTML = entries.map(([d, h]) => {
      const pct = Math.round((h / maxH) * 100);
      return `<div class="domain-row">
        <div class="domain-row-header">
          <span class="domain-row-name" title="${escHtml(d)}">${escHtml(d)}</span>
          <span class="domain-row-hours">${h.toFixed(1)}h</span>
        </div>
        <div class="domain-bar-track">
          <div class="domain-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>`;
    }).join("");
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
    wrap.innerHTML = `<input type="number" id="bulk-value" min="0.25" max="40" step="0.25" value="1.0" style="width:72px">`;
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

    .isc2-sec { background: #fffbf0; border: 1px solid #dfc87a;
                border-left: 4px solid #c97d10; padding: 11px 13px; margin-bottom: 11px; }
    .isc2-sec .sec-lbl { color: #c97d10; border-bottom-color: #dfc87a; }
    .isc2-sec .sec-text { color: #2a1f00; }
    .isc2-sec .sec-text.empty { color: #bbb; font-style: italic; }

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
    <div class="cover-logo">ISC&sup2;</div>
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
    <div class="footer">ISC&sup2; CPE Tracker &mdash; ${escHtml(now)}</div>
  </div>`;

  // One page per episode
  const pages = rows.map((row, i) => {
    const domains = (row.domains || row.domain || "").split("|").map(s => s.trim()).filter(Boolean);
    const proof   = row.proof_image
      ? `<div class="sec"><div class="sec-lbl">Completion Proof</div>
         <img class="proof-img" src="${origin}/api/cpes/${row.id}/proof" alt="Proof"></div>`
      : "";
    const isc2Text = row.isc2_summary
      ? `<div class="sec-text">${escHtml(row.isc2_summary)}</div>`
      : `<div class="sec-text empty">No summary written yet — open the ISC&sup2; modal to draft one.</div>`;

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
    <div class="isc2-sec"><div class="sec-lbl">ISC&sup2; Submission Summary</div>${isc2Text}</div>
    ${row.notes ? `<div class="sec"><div class="sec-lbl">Notes</div>
      <div class="sec-text">${escHtml(row.notes)}</div></div>` : ""}
    ${proof}
    ${row.submitted_date ? `<div class="submitted-stamp">Submitted to ISC&sup2; on ${escHtml(fmtDate(row.submitted_date))}</div>` : ""}
    <div class="footer">ISC&sup2; CPE Tracker &mdash; ${escHtml(row.title)} &mdash; ${escHtml(now)}</div>
  </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ISC&sup2; CPE Report &mdash; ${escHtml(now)}</title>
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

function applyFilters() {
  filters.domain    = $("filter-domain").value;
  filters.status    = $("filter-status").value;
  filters.type      = $("filter-type").value;
  filters.date_from = $("filter-from").value;
  filters.date_to   = $("filter-to").value;
  loadCPEs();
}

function clearFilters() {
  $("filter-domain").value = $("filter-status").value =
    $("filter-type").value = $("filter-from").value = $("filter-to").value = "";
  filters = { domain: "", status: "", type: "", date_from: "", date_to: "" };
  loadCPEs();
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
  // Apply saved (or default) colour theme before first render
  applyTheme(localStorage.getItem("cpe_theme") || "amber");

  // Wire up colour theme swatches
  document.querySelectorAll(".theme-swatch").forEach(sw => {
    sw.addEventListener("click", () => applyTheme(sw.dataset.theme));
  });

  loadColPrefs();
  renderHeaders();
  buildFilterBar();
  buildAddForm();
  $("filter-status").value = "pending";

  $("btn-fetch").addEventListener("click", fetchNow);
  $("btn-export").addEventListener("click", exportCSV);
  $("btn-add").addEventListener("click", toggleAddForm);
  $("btn-columns").addEventListener("click", toggleColPicker);
  $("btn-filter").addEventListener("click", applyFilters);
  $("btn-clear-filters").addEventListener("click", clearFilters);
  $("add-cpe-form").addEventListener("submit", submitAddForm);
  $("proof-file-input").addEventListener("change", handleProofFileSelected);

  document.addEventListener("keydown", e => { if (e.key === "Escape") closeISC2Modal(); });

  // Close col picker when clicking outside
  document.addEventListener("click", e => {
    const picker = $("col-picker");
    const btn    = $("btn-columns");
    if (picker.classList.contains("open") && !picker.contains(e.target) && e.target !== btn) {
      picker.classList.remove("open");
    }
  });

  await loadSummary();
  await loadCPEs();
}

document.addEventListener("DOMContentLoaded", init);
