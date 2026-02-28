# ISC2 CPE Tracker — Architecture

## Overview

ISC2 CPE Tracker is a self-hosted, Dockerised web application that automatically
imports Security Now podcast episodes as CISSP CPE entries, classifies them by
domain, and provides a browser UI for reviewing, editing, and exporting records
ready for ISC2 submission.

---

## System Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                       Docker Container                   │
│                                                          │
│  ┌──────────────┐      ┌────────────────────────────┐   │
│  │  scheduler.py│      │         main.py             │   │
│  │              │      │     FastAPI application     │   │
│  │ APScheduler  │      │                             │   │
│  │ BackgroundSch│      │  API routes  │  StaticFiles │   │
│  │              │      │  /api/...    │  /           │   │
│  │ • every 6 h  │      └──────┬───────────────┬──────┘   │
│  │ • +10 s boot │             │               │          │
│  └──────┬───────┘             │               │          │
│         │                     │               │          │
│         ▼                     ▼               ▼          │
│  ┌──────────────┐      ┌────────────┐   ┌────────────┐  │
│  │    rss.py    │      │ storage.py │   │  static/   │  │
│  │              │      │            │   │            │  │
│  │ feedparser   │─────▶│  RLock     │   │ index.html │  │
│  │ classify_    │      │  CSV read/ │   │ app.js     │  │
│  │  domains()  │      │  write     │   │ style.css  │  │
│  │ parse_dur.. │      │  atomic    │   │ admin.html │  │
│  └──────────────┘      └─────┬──────┘   └────────────┘  │
│                               │                          │
│                        ┌──────▼──────────────────────┐  │
│                        │  /app/data/  (Docker volume) │  │
│                        │                              │  │
│                        │  cpes.csv                    │  │
│                        │  attachments/                │  │
│                        │    <uuid>.<ext>  (proofs)    │  │
│                        └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
          │                              ▲
          │  HTTP (RSS feed)             │ HTTP (port 8081)
          ▼                              │
  feeds.twit.tv/sn.xml           Browser / User
```

---

## Request Flow — Browser Interaction

```
Browser                     FastAPI (main.py)          storage.py
   │                               │                       │
   │── GET /api/cpes?status=pending─▶                      │
   │                               │── read_all() ────────▶│
   │                               │◀─ [rows] ─────────────│
   │◀─ 200 JSON [rows] ────────────│                       │
   │                               │                       │
   │── PUT /api/cpes/{id} ─────────▶                       │
   │   { status: "approved" }      │── update_entry() ────▶│
   │                               │◀─ updated row ────────│
   │◀─ 200 JSON {updated row} ─────│                       │
   │                               │                       │
   │── POST /api/cpes/{id}/proof ──▶                       │
   │   multipart/form-data          │── write file ────────▶data/attachments/
   │                               │── update_entry() ────▶│
   │◀─ 200 { proof_image: "..." } ─│                       │
```

---

## Background Flow — Scheduled RSS Fetch

```
APScheduler                 rss.py                    storage.py
  (every 6 h)                  │                          │
      │                        │                          │
      │── _fetch_job() ────────▶                          │
      │                        │── feedparser.parse() ──▶ feeds.twit.tv
      │                        │◀─ feed.entries ──────────│
      │                        │                          │
      │                        │  for each entry:         │
      │                        │  • classify_domains()    │
      │                        │  • parse_duration()      │
      │                        │  • normalise title       │
      │                        │                          │
      │                        │── add_entries([...]) ───▶│
      │                        │                (dedup    │
      │                        │                by URL,   │
      │                        │                write CSV)│
      │◀─ print("[Scheduler] added N") ──────────────────▶│
```

---

## Module Responsibilities

| Module | Responsibility |
|---|---|
| `main.py` | FastAPI app, all HTTP routes, request validation, file serving |
| `storage.py` | Thread-safe CSV CRUD, atomic writes, schema versioning |
| `rss.py` | RSS fetch, CISSP domain classification, duration parsing |
| `scheduler.py` | APScheduler setup: initial + recurring RSS fetch jobs |
| `static/app.js` | SPA: table render, sort/filter/edit, modals, column prefs |
| `static/index.html` | Main dashboard: table, filters, add form, ISC2 modal |
| `static/admin.html` | Storage admin: attachment list, proof gallery, backfill |
| `static/style.css` | Dark theme, layout, component styles |
| `tests/test_rss.py` | pytest suite for domain classifier and duration parser |

---

## API Endpoints

### CPE Entries

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cpes` | List entries; filter by `domain`, `status`, `type`, `date_from`, `date_to` |
| `POST` | `/api/cpes` | Create a new entry (status 201) |
| `PUT` | `/api/cpes/{id}` | Partial update (only supplied fields are changed) |
| `DELETE` | `/api/cpes/{id}` | Delete entry and its proof file |

### Proof Screenshots

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/cpes/{id}/proof` | Upload PNG/JPEG/WEBP/GIF; saved to `data/attachments/` |
| `GET` | `/api/cpes/{id}/proof` | Serve the proof image file |
| `DELETE` | `/api/cpes/{id}/proof` | Delete proof file and clear field |

### Utility

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/fetch` | On-demand RSS fetch; returns `{fetched, added}` |
| `GET` | `/api/export` | Download raw `cpes.csv` |
| `GET` | `/api/summary` | Aggregated stats (hours, domain/status/type breakdowns) |

### Admin

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/admin/backfill-presenters` | Re-sync presenter fields from RSS by URL match |
| `GET` | `/api/admin/storage` | List attachment files with sizes and linked entry titles |

---

## CSV Schema

File: `data/cpes.csv`

| Field | Type | Description |
|---|---|---|
| `id` | UUID string | Unique entry identifier (UUID4) |
| `title` | string | Episode or article title |
| `description` | string | HTML-stripped summary (≤ 500 chars) |
| `url` | string | Canonical URL; used for deduplication |
| `published_date` | ISO-8601 UTC | When the episode was published |
| `fetched_date` | ISO-8601 UTC | When the entry was added to the CSV |
| `source` | string | `"Security Now Podcast"` or `"Manual"` |
| `type` | string | `"podcast"` or `"article"` |
| `cpe_hours` | float string | Duration rounded to nearest 0.25 h |
| `domain` | string | Primary CISSP domain (first of `domains`) |
| `notes` | string | Free-form user notes |
| `status` | string | `pending` / `approved` / `archived` |
| `presenter` | string | e.g. `"Steve Gibson"` or `"Steve Gibson & Leo Laporte"` |
| `isc2_summary` | string | User-written ISC2 submission summary |
| `domains` | string | Pipe-separated list of up to 3 CISSP domains |
| `proof_image` | string | Filename in `data/attachments/` (e.g. `<uuid>.png`) |

**Schema versioning:** new fields are appended to `FIELDNAMES` in `storage.py`
and back-filled with empty defaults by `_normalize_row()` so old CSV files
continue to load without migration.

---

## CISSP Domain Classification

Domain classification is performed in `rss.py` by `classify_domains()`:

1. The episode `title + description` is lowercased and concatenated.
2. Each of the 8 CISSP domains is scored by counting keyword substring matches.
3. Domains scoring ≥ 50 % of the top score are included (up to 3 domains).
4. The result is stored pipe-separated in `domains`; `domain` holds the first entry.
5. Default when no keywords match: `"Security Operations"`.

```
title + description (lowercased)
         │
         ▼
  ┌─────────────────────────────┐
  │ Score each of 8 CISSP       │
  │ domains by keyword matches  │
  └─────────────────────────────┘
         │
         ▼
  Top score = max(all scores)
  Threshold = top_score × 0.50
         │
         ▼
  Include domains with score >= threshold
  Cap at 3 results, sort by score desc
         │
         ▼
  ["Security Operations", "Communication and Network Security", ...]
```

---

## Deployment Topology

```
┌─────────────────────────────────────────┐
│   Docker host: HOSTNAME              │
│                                          │
│   ┌─────────────────────────────────┐   │
│   │  cissp-cpe-tracker container    │   │
│   │  python:3.12-slim               │   │
│   │                                  │   │
│   │  uvicorn main:app               │   │
│   │  listening on 0.0.0.0:8000      │   │
│   └─────────────────────────────────┘   │
│           │                              │
│   port mapping: 8081 → 8000             │
│           │                              │
│   ┌───────▼──────────────────────────┐  │
│   │  ./data  (bind mount volume)     │  │
│   │    cpes.csv                      │  │
│   │    attachments/                  │  │
│   └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
          ▲
          │  http://HOSTNAME:8081
          │
       Browser
```

**Note:** The default port is 8081. Change the port mapping in `docker-compose.yml` if 8081 is already in use on your host.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Flat CSV storage | No database dependency; file is human-readable, trivially exportable, and version-control friendly. |
| `threading.RLock` | `add_entries()` calls `read_all()` while already holding the lock. A plain `Lock` would deadlock; `RLock` allows the same thread to re-acquire. |
| Atomic writes (`os.replace`) | Writes go to `.tmp` first so a crash never leaves the CSV in a partial state. |
| APScheduler `DateTrigger` for initial fetch | Scheduling the first fetch 10 s after startup (rather than calling it synchronously) prevents uvicorn's lifespan startup from blocking on a network request. |
| Static files mounted last | FastAPI's `StaticFiles` mount acts as a catch-all. Mounting it after all `@app.route` declarations ensures API paths take priority. |
| No build step for frontend | Vanilla JS with no bundler keeps the project dependency-free on the frontend and makes editing straightforward. |
| Keyword scoring for domain classification | Simple, fast, and transparent. The keyword lists are easy to tune without any ML dependency. |
