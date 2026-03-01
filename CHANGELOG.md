# Changelog

## v3.3 — 2026-02-28

### Added
- **Multi-vendor CPE mode** — sidebar mode selector switches between CISSP and vendor certification views (ISACA, CompTIA, etc.); per-vendor credit columns appear in the table and update automatically based on the selected mode
- **Vendor credit columns** — per-vendor CPE hours columns (e.g. CISSP, CCSP, CEH, CISM) are draggable, reorderable, and hideable; merged into the unified column order system so they can be freely repositioned alongside standard columns
- **Column drag-to-reorder** — drag column chips in the Columns picker dropdown to reorder; new order persists in `localStorage`
- **Webinar entry type** — new "Webinar" type available when adding entries; ISACA and CompTIA sources are automatically restricted to this type
- **Config-based CPE calculation rules** — per-vendor calculation rules configurable on the Config page
- **Custom favicon** — shield logo favicon; adapts automatically between light and dark browser themes

### Changed
- **Dark mode readability** — base background lifted from near-black (`#09090b`) to a softer dark navy (`#111116`); surface layers, borders, and muted text all brightened for improved contrast without losing the dark aesthetic
- **Column order storage** — vendor columns are now part of `colOrder` rather than a separate array, enabling free drag-to-reorder across all column types in a single pass

### Fixed
- Vendor column drag-to-reorder with document-level drop target (previously dropped outside grid area were lost)
- Favicon background color in light mode

## v3.2 — 2026-02-28

### Added
- **Date preset chips** — one-click quick filters on the dashboard: 7 days, This month, Last month, This year, Last year; fills the From/To date inputs and applies the filter instantly
- **Filtered sidebar** — Total CPE Hours, entry counts, and domain progress bars now reflect the currently filtered view rather than global totals; computed client-side from the filtered row set
- **Per-feed sync window** — each feed has its own configurable lookback window (1–365 days, default 60); editable per feed on the Config page; stored in `feeds.json` and passed through `fetch_feed()`
- **Light / Dark mode** — toggle between a warm light theme and the default near-black dark theme; FOUC prevention inline script in `<head>` on all pages; preference persists in `localStorage` across all pages
- **Config page** (`/config.html`) — dedicated feed manager page with per-feed Days input; moved from admin page
- **Storage page** (`/storage.html`) — proof attachments listing and deletion; moved from admin page
- **Animated GIFs in README** — `light-mode-toggle.gif` and `date-presets.gif` demonstrating key features

### Changed
- **Admin page** — now contains only backfill tools (Fix Presenter Names, Fix Subtitles, Fix Titles); feeds and storage sections moved to dedicated pages
- **Navigation** — 4-page nav bar on all pages: Dashboard / Config / Admin / Storage; mode toggle button in nav with visual separator; no separate header-actions on Dashboard
- **Table toolbar** — Add Entry, Fetch Now, Export CSV, Export PDF, and Columns buttons moved from header into a toolbar row directly above the data table
- **Default status filter** — changed from "Pending" to "All" so all entries are visible on first load
- **Test suite** — 100 tests (up from 93 in v3.1); 4 new `test_feeds.py` cutoff_days tests, 3 new `test_rss.py` per-feed cutoff tests

## v3.1 — 2026-02-28

### Added
- **Multi-feed RSS configuration** — add any number of RSS/Atom podcast feeds from the admin page; Security Now is pre-configured by default; each feed stores a name, URL, enabled flag, and added date in `data/feeds.json` (atomic JSON, `feed_store.py`)
- **Feed manager UI** — admin page Feed Manager card: add feeds by URL (name auto-detected from feed title), enable/disable toggle, delete with optional purge of all CPE entries from that source; shows live entry count per feed before purging
- **Purge-on-feed-delete** — `DELETE /api/feeds/{id}?purge_data=true` permanently removes all CPE entries (and their proof images) whose `source` matches the feed name; entry count returned in response
- **RSS 60-day cutoff** — `fetch_feed()` now filters out episodes published more than 60 days ago; prevents excessive backfill when adding a new feed with a large back-catalog; configurable per call
- **Admin page overhaul** — nav tabs (Feed Manager / Backfill / Storage / Theme), theme switcher and accent color picker moved from the main dashboard to the admin page
- **`feed_store.py`** — new module: thread-safe JSON feed config store with RLock + atomic writes, mirrors the patterns in `storage.py`
- **New API routes** — `GET/POST/PUT/DELETE /api/feeds`; `DELETE /api/feeds/{id}` accepts `?purge_data=true`; `POST /api/fetch` now fetches all enabled feeds
- **Test suite expanded** — `tests/test_feeds.py` (18 tests) and new `test_rss.py` cases for `fetch_all`, cutoff filtering, and multi-feed source naming; total 93 tests (up from 61 in v3.0)

### Changed
- `rss.py` `fetch_all()` now accepts a feed list parameter instead of using a hard-coded Security Now URL; each entry's `source` field is set to the configured feed name
- Color picker and theme switcher removed from `index.html` header; now live on `admin.html`
- Nav links styled as `btn-secondary` buttons; stale mobile-specific nav rule removed

## v3.0 — 2026-02-28

### Added
- **PDF export** — generate a print-ready PDF report from the header button (all visible rows, mobile-friendly) or from the bulk action bar (selected rows only); report includes a cover page with total CPE hours, activity count, and TOC table, followed by one page per entry containing the full metadata grid, CISSP domain tags, source URL, episode description, ISC² submission summary (highlighted in amber), notes, and proof screenshot
- **Duration column** — episode runtime displayed as "1h 32m" parsed from the raw `itunes:duration` RSS tag; stored in the new `duration` CSV field (schema v1.5); existing entries backfilled from the live feed on first deploy
- **Submitted date tracking** — when an entry's status is changed to "Submitted", the exact UTC timestamp is automatically recorded in a new `submitted_date` field (schema v1.6); displayed as a green banner at the bottom of each PDF episode page
- **ISC² summary pre-fill** — opening the ISC² submission modal now pre-populates the summary textarea with the saved `isc2_summary` or, if empty, the episode's feed description as a starting point; a "Use feed description" button resets the textarea to the raw feed text at any time
- **Mobile PDF export** — "Export PDF" button is permanently visible in the page header, requires no row selection, and exports the current filtered view; works on any screen size
- **CPE credit rule enforcement** — ISC² rules codified throughout: 0.25-increment steps, minimum 0.25 h, maximum 40 h per activity; enforced in the RSS duration parser, inline hours editor, add-entry form, and bulk-edit hours input

### Changed
- `parse_duration()` in `rss.py` now clamps output to `[0.25, 40.0]` (previously uncapped)
- `update_entry()` in `storage.py` auto-stamps `submitted_date` on status → submitted; no frontend changes required
- Hours inputs across the UI updated: `min="0.25" max="40" step="0.25"`
- PDF proof screenshots centered and enlarged (max-height 560 px)
- Mobile layout: color swatches and Storage link hidden on narrow screens to give action buttons room; header wraps gracefully
- CLAUDE.md and README.md fully rewritten for v3.0 (major version documentation rebase)
- Test suite: 61 tests (up from 58 in v2.3)

## v2.3 — 2026-02-28

### Added
- **Soft delete / Trash** — deleting a CPE entry now marks it `status=deleted` instead of removing the row; the URL stays in the deduplication set so Fetch Now and the scheduled 6-hour RSS pull never re-add the episode
- **Trash view** — select "Trash" in the Status filter to see deleted entries; each row shows **Restore** (sets status back to `pending`) and **Purge** (permanently deletes the row and proof image) buttons
- **Purge API route** — `DELETE /api/cpes/{id}/purge` permanently removes an entry; the standard `DELETE /api/cpes/{id}` now soft-deletes
- **Multi-select checkboxes** — a checkbox column is pinned before all data columns; a select-all checkbox in the header selects/deselects the entire visible set; selected rows are highlighted in the accent colour
- **Bulk action bar** — a floating bar slides up from the bottom whenever rows are selected, offering: Set Field (Status / Domain / CPE Hours) + Apply to update all selected entries at once; Delete Selected (soft delete); and Clear to drop the selection; in Trash view the bar shows Restore Selected and Purge Selected instead
- **Default Pending filter** — the app opens with the Status filter pre-set to "Pending" so only actionable entries are shown by default
- **Documentation policy in CLAUDE.md** — document-as-you-go rules and major-version rebase policy formalised

### Changed
- Summary dashboard excludes soft-deleted entries from all totals and counts
- `GET /api/cpes` excludes `status=deleted` rows by default; pass `status=deleted` to view the trash
- `test_storage.py` added — 23 tests covering soft delete, purge, restore, and deduplication with deleted entries (total test suite: 58 tests)

## v2.2 — 2026-02-27

### Added
- **Accent color picker** — 6 selectable accent themes (amber, red, green, blue, purple, cyan) with the active theme persisted in localStorage; all CSS variables and the SVG header seal update live on click
- **Subtitle column** — `itunes:subtitle` extracted from RSS feed into a dedicated `subtitle` field and displayed as its own table column, separate from the episode title
- **Admin: Fix Titles button** — normalises `SN NNN:` prefix to `Security Now NNN:` and strips the subtitle suffix from all existing CSV entries by re-fetching RSS or falling back to the stored subtitle field
- **Admin: Fix Subtitles button** — backfills the `subtitle` field on existing entries by re-matching URLs from a fresh RSS fetch
- **Mobile column hiding** — on screens ≤ 640 px only the Title and Proof columns are shown; implemented via `data-col` CSS attribute targeting with no JavaScript media-query logic

### Changed
- **Full UI redesign** — amber/serif "credential" aesthetic: near-black background, Cormorant Garamond for display numerals, DM Sans for UI text, JetBrains Mono for data; fixed 256 px sidebar with large serif CPE total, entry counts, and domain progress bars; scrollable main area with filter bar and table
- **Title normalisation on import** — rss.py now strips the ` - {subtitle}` suffix from episode titles at fetch time so titles and subtitles are always stored independently
- **Font size** — base font sizes increased across the UI for improved readability at 100 % browser zoom

## v2.1 — 2026-02-27

### Changed
- **Status renamed** — `Approved` status renamed to `Submitted` across the UI, filter dropdown, and dashboard summary card (label updated to "Submitted to ISC2")
- Existing CSV rows with `status=approved` are automatically migrated to `submitted` on read — no manual data changes required

---

## v2.0 — 2026-02-27

### Added
- **Multi-domain tagging** — episodes are now scored against all 8 CISSP domains simultaneously; up to 3 matching domains are stored and displayed (pipe-separated in `domains` field, primary in `domain`)
- **ISC2 submission modal** — per-entry form to draft and save an ISC2-formatted CPE submission summary (`isc2_summary` field)
- **CPE credits field** — ISC2 modal includes a computed CPE hours display for reference
- **Proof screenshot upload** — attach a PNG/JPEG/WEBP/GIF screenshot to any entry as submission evidence; stored in `data/attachments/` and served via `/api/cpes/{id}/proof`
- **Presenter field** — `presenter` column populated from RSS `media:credit` host tags (e.g. `Steve Gibson` or `Steve Gibson & Leo Laporte`)
- **Released date column** — published date displayed in the main dashboard table
- **Storage admin page** — `/admin.html` lists all attachment files with sizes and linked entry titles; includes a backfill button to re-sync presenter fields from RSS
- **Drag-and-drop column reordering** — drag table column headers to reorder; order persists in localStorage
- **Column resize** — drag the right edge of any column header to resize; widths persist in localStorage
- **Column hide/show** — Columns picker button above the table to toggle individual columns; hidden state persists in localStorage
- **Column sort** — click any column header to sort ascending/descending; click again to clear sort; sort indicators (↑/↓/⇅) shown in headers
- **Episode title normalisation** — `SN NNNN:` prefix in RSS titles rewritten to `Security Now NNNN:` on import
- **Full code documentation** — all Python modules (`main.py`, `storage.py`, `rss.py`, `scheduler.py`) and `app.js` now have comprehensive docstrings and JSDoc
- **Architecture document** — `docs/architecture.md` with ASCII component diagrams, request flow sequences, API reference, CSV schema, and design decision rationale

### Changed
- App renamed from **CISSP CPE Tracker** to **ISC2 CPE Tracker**
- Test suite expanded to 35 tests (up from 21 in v1.1)

---

## v1.1 — 2026-02-27

### Added
- **Auto domain classification** — episode title and description are scored against keyword lists for all 8 CISSP domains; best match is assigned automatically on fetch (user can still override via inline edit)
- **Duration-based CPE hours** — parses `itunes:duration` from RSS feed and converts to CPE hours at 1 hour = 1.0 CPE, rounded to the nearest 0.25 increment (minimum 0.25); falls back to 1.0 if duration is missing
- **Unit tests** — `tests/test_rss.py` with 21 tests covering all domain categories, edge cases, and all duration input formats (`HH:MM:SS`, `MM:SS`, raw seconds, missing, invalid)

### Fixed
- `parse_duration` correctly handles feedparser entries that lack a `.get()` method

---

## v1.0 — 2026-02-27

Initial release of the CISSP CPE Tracker.

### Features
- Automated RSS ingestion of Security Now Podcast (`feeds.twit.tv/sn.xml`) every 6 hours via APScheduler
- Web UI (vanilla JS, dark theme) for viewing, filtering, and editing CPE records
- Inline editing of CPE hours, CISSP domain, status, and notes directly in the table
- Filter bar: by domain, status, type, and date range
- Summary dashboard: total hours, entry count, approved/pending counts, hours by CISSP domain
- Manual CPE entry form for non-podcast sources
- "Fetch Now" button to trigger an immediate RSS pull
- CSV export download
- Persistent storage via Docker volume-mounted CSV (`data/cpes.csv`)
- Deduplication by URL — re-fetching the feed never creates duplicate entries
- All 8 official CISSP domains available as dropdown options

### Architecture
- Single Docker container: FastAPI backend serves API + static frontend files
- `storage.py`: thread-safe CSV read/write using `RLock` and atomic temp-file replacement
- `scheduler.py`: initial fetch deferred 10 seconds post-startup to avoid blocking uvicorn lifespan
- Deployed to `HOSTNAME:8081`
