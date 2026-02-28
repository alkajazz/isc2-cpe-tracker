"""
ISC2 CPE Tracker — FastAPI application entry point.

This module wires together all subsystems and exposes the HTTP API consumed
by the vanilla JS frontend.  Static files are mounted last so that every
``/api/...`` route takes priority over the catch-all StaticFiles handler.

API surface
-----------
CPE entries (CRUD):
    GET    /api/cpes                        list / filter entries
    POST   /api/cpes                        create a new entry
    PUT    /api/cpes/{id}                   partial update
    DELETE /api/cpes/{id}                   delete entry + proof file

Proof screenshots:
    POST   /api/cpes/{id}/proof             upload image
    GET    /api/cpes/{id}/proof             serve image
    DELETE /api/cpes/{id}/proof             remove image

Utility:
    POST   /api/fetch                       on-demand RSS fetch
    GET    /api/export                      download raw CSV
    GET    /api/summary                     aggregated stats

Feed management:
    GET    /api/feeds                       list configured RSS feeds
    POST   /api/feeds                       add feed (validates URL, auto-detects name)
    PUT    /api/feeds/{id}                  update feed name or enabled flag
    DELETE /api/feeds/{id}                  remove feed (CPE entries unaffected)

Admin:
    POST   /api/admin/backfill-presenters   re-sync presenter from RSS
    GET    /api/admin/storage               attachment file listing + sizes
"""

import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import storage
import feed_store
import scheduler as sched

# MIME types accepted for proof screenshot uploads.
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the background RSS scheduler on startup; stop it on shutdown."""
    sched.start_scheduler()
    yield
    sched.stop_scheduler()


app = FastAPI(title="ISC2 CPE Tracker", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class FeedCreate(BaseModel):
    """Request body for POST /api/feeds."""
    url: str
    name: Optional[str] = None


class FeedUpdate(BaseModel):
    """Request body for PUT /api/feeds/{id} — all fields optional."""
    name: Optional[str] = None
    enabled: Optional[bool] = None
    cutoff_days: Optional[int] = None


class CPECreate(BaseModel):
    """Request body for POST /api/cpes — all fields except id and fetched_date."""
    title: str
    description: str = ""
    url: str = ""
    published_date: str = ""
    source: str = "Manual"
    type: str = "podcast"
    cpe_hours: float = 1.0
    domain: str = "Security Operations"
    domains: str = ""
    presenter: str = ""
    isc2_summary: str = ""
    notes: str = ""
    status: str = "pending"
    subtitle: str = ""


class CPEUpdate(BaseModel):
    """Request body for PUT /api/cpes/{id} — all fields optional (partial update)."""
    title: Optional[str] = None
    description: Optional[str] = None
    cpe_hours: Optional[float] = None
    domain: Optional[str] = None
    domains: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    presenter: Optional[str] = None
    isc2_summary: Optional[str] = None
    subtitle: Optional[str] = None


# ---------------------------------------------------------------------------
# CPE CRUD routes
# ---------------------------------------------------------------------------

@app.get("/api/cpes")
def list_cpes(
    domain: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
):
    """
    Return all CPE entries, optionally filtered by one or more query params.

    - ``domain``    — case-insensitive match against the pipe-separated domains field
    - ``status``    — exact match (pending / submitted / archived)
    - ``type``      — exact match (podcast / article)
    - ``date_from`` — ISO date string; entries with published_date < date_from excluded
    - ``date_to``   — ISO date string; entries with published_date > date_to excluded

    Results are sorted newest-first by published_date.
    """
    rows = storage.read_all()

    if domain:
        def _domain_match(row):
            domains_str = row.get("domains") or row.get("domain", "")
            row_domains = [d.strip().lower() for d in domains_str.split("|") if d.strip()]
            return domain.lower() in row_domains
        rows = [r for r in rows if _domain_match(r)]

    if status:
        rows = [r for r in rows if r.get("status", "").lower() == status.lower()]
    else:
        # Exclude soft-deleted entries from the default view
        rows = [r for r in rows if r.get("status", "").lower() != "deleted"]
    if type:
        rows = [r for r in rows if r.get("type", "").lower() == type.lower()]
    if date_from:
        rows = [r for r in rows if r.get("published_date", "") >= date_from]
    if date_to:
        rows = [r for r in rows if r.get("published_date", "") <= date_to]

    rows.sort(key=lambda r: r.get("published_date", ""), reverse=True)
    return rows


@app.post("/api/cpes", status_code=201)
def create_cpe(body: CPECreate):
    """
    Create a new CPE entry from the request body.

    Assigns a UUID, sets fetched_date to the current UTC time, and defaults
    the ``domains`` field to ``domain`` when the caller omits it.
    Returns the created entry dict (status 201).
    """
    from datetime import datetime, timezone
    entry = body.model_dump()
    entry["cpe_hours"] = str(entry["cpe_hours"])
    entry["fetched_date"] = datetime.now(timezone.utc).isoformat()
    if not entry.get("domains"):
        entry["domains"] = entry["domain"]
    return storage.add_entry(entry)


@app.put("/api/cpes/{entry_id}")
def update_cpe(entry_id: str, body: CPEUpdate):
    """
    Partially update an existing CPE entry.

    Only non-None fields in the request body are applied; omitted fields
    are left unchanged.  Returns 404 if the entry_id is not found.
    """
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "cpe_hours" in updates:
        updates["cpe_hours"] = str(updates["cpe_hours"])
    result = storage.update_entry(entry_id, updates)
    if result is None:
        raise HTTPException(status_code=404, detail="CPE not found")
    return result


@app.delete("/api/cpes/{entry_id}", status_code=204)
def delete_cpe(entry_id: str):
    """
    Soft-delete a CPE entry (sets status to "deleted").

    The entry remains in the CSV so its URL stays in the deduplication set,
    preventing the RSS fetcher from re-adding it on the next fetch.  The entry
    can be restored via PUT /api/cpes/{id} with {"status": "pending"}, or
    permanently removed via DELETE /api/cpes/{id}/purge.

    Returns 204 on success, 404 if the entry_id is not found.
    """
    if not storage.delete_entry(entry_id):
        raise HTTPException(status_code=404, detail="CPE not found")


@app.delete("/api/cpes/{entry_id}/purge", status_code=204)
def purge_cpe(entry_id: str):
    """
    Permanently delete a CPE entry and its proof screenshot (if any).

    Unlike the standard DELETE, this removes the row entirely from the CSV and
    clears the URL from the deduplication set — the episode can be re-fetched
    from RSS afterwards.  This action is irreversible.

    Returns 204 on success, 404 if the entry_id is not found.
    """
    if not storage.purge_entry(entry_id):
        raise HTTPException(status_code=404, detail="CPE not found")


# ---------------------------------------------------------------------------
# Proof image routes
# ---------------------------------------------------------------------------

@app.post("/api/cpes/{entry_id}/proof")
async def upload_proof(entry_id: str, file: UploadFile = File(...)):
    """
    Accept a proof screenshot upload and attach it to the given CPE entry.

    Accepted MIME types: PNG, JPEG, WEBP, GIF.
    The file is saved to ``data/attachments/<entry_id>.<ext>`` and the
    ``proof_image`` field on the entry is updated with the filename.

    Returns 400 for disallowed MIME types; 404 if the entry is not found.
    """
    rows = storage.read_all()
    row = next((r for r in rows if r["id"] == entry_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="CPE not found")

    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="File must be an image (PNG, JPEG, WEBP, GIF)")

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "png"
    filename = f"{entry_id}.{ext}"
    attachments_dir = storage.get_attachments_dir()
    dest = os.path.join(attachments_dir, filename)

    contents = await file.read()
    with open(dest, "wb") as f:
        f.write(contents)

    storage.update_entry(entry_id, {"proof_image": filename})
    return {"proof_image": filename}


@app.get("/api/cpes/{entry_id}/proof")
def get_proof(entry_id: str):
    """
    Serve the proof screenshot for the given entry as a file response.
    Returns 404 if the entry has no proof image or the file is missing on disk.
    """
    rows = storage.read_all()
    row = next((r for r in rows if r["id"] == entry_id), None)
    if row is None or not row.get("proof_image"):
        raise HTTPException(status_code=404, detail="No proof image for this CPE")

    path = os.path.join(storage.get_attachments_dir(), row["proof_image"])
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Proof image file not found")

    return FileResponse(path)


@app.delete("/api/cpes/{entry_id}/proof", status_code=204)
def delete_proof(entry_id: str):
    """
    Remove the proof screenshot from disk and clear proof_image on the entry.
    Silently succeeds (204) if no proof was previously uploaded.
    Returns 404 if the entry_id itself is not found.
    """
    rows = storage.read_all()
    row = next((r for r in rows if r["id"] == entry_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="CPE not found")

    if row.get("proof_image"):
        path = os.path.join(storage.get_attachments_dir(), row["proof_image"])
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        storage.update_entry(entry_id, {"proof_image": ""})


# ---------------------------------------------------------------------------
# Feed management routes
# ---------------------------------------------------------------------------

@app.get("/api/feeds")
def list_feeds():
    """Return all configured RSS feeds."""
    return feed_store.read_feeds()


@app.post("/api/feeds", status_code=201)
def add_feed(body: FeedCreate):
    """
    Add a new RSS feed.

    Validates that the URL is reachable and parses as a valid RSS/Atom feed.
    Auto-detects the feed name from the feed title when not supplied.

    Returns 400 if the URL already exists in the feed list.
    Returns 422 if the URL does not parse as a valid RSS feed.
    """
    import feedparser as _fp
    url = body.url.strip()

    # Duplicate check
    existing = {f["url"] for f in feed_store.read_feeds()}
    if url in existing:
        raise HTTPException(status_code=400, detail="Feed URL already exists")

    # Validate — fetch and parse
    parsed = _fp.parse(url)
    if parsed.bozo and not parsed.entries:
        raise HTTPException(status_code=422, detail="Not a valid RSS feed")

    name = body.name or parsed.feed.get("title") or url
    try:
        return feed_store.add_feed(url, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.put("/api/feeds/{feed_id}")
def update_feed(feed_id: str, body: FeedUpdate):
    """
    Update a feed's name or enabled flag.
    Returns 404 if the feed is not found.
    """
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "cutoff_days" in updates:
        updates["cutoff_days"] = max(1, min(365, int(updates["cutoff_days"])))
    result = feed_store.update_feed(feed_id, updates)
    if result is None:
        raise HTTPException(status_code=404, detail="Feed not found")
    return result


@app.delete("/api/feeds/{feed_id}")
def delete_feed(feed_id: str, purge_data: bool = Query(False)):
    """
    Remove a feed from the configuration.

    When ``purge_data=true``, also permanently deletes all CPE entries whose
    ``source`` field matches the feed's name (including their proof images).
    Returns 404 if the feed is not found.
    Returns 204 when purge_data is False, or a JSON summary when True.
    """
    feeds = feed_store.read_feeds()
    feed = next((f for f in feeds if f["id"] == feed_id), None)
    if feed is None:
        raise HTTPException(status_code=404, detail="Feed not found")

    feed_store.delete_feed(feed_id)

    if purge_data:
        purged = storage.purge_entries_by_source(feed["name"])
        return {"purged": purged}

    from fastapi.responses import Response
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Fetch / export / summary
# ---------------------------------------------------------------------------

@app.post("/api/fetch")
def trigger_fetch():
    """
    Manually trigger an immediate RSS fetch for all configured sources.

    Returns a dict with:
    - ``fetched``: total number of entries parsed from the feed
    - ``added``:   number of new entries inserted (duplicates skipped)
    """
    from rss import fetch_all
    entries = fetch_all(feed_store.read_feeds())
    added = storage.add_entries(entries)
    return {"fetched": len(entries), "added": len(added)}


@app.get("/api/export")
def export_csv():
    """Return the raw cpes.csv file as a downloadable CSV attachment."""
    path = storage.get_csv_path()
    return FileResponse(path, media_type="text/csv", filename="cpes.csv")


@app.get("/api/summary")
def summary():
    """
    Return aggregate statistics across all CPE entries:

    - ``total_entries``: row count
    - ``total_hours``:   sum of cpe_hours (rounded to 1 decimal)
    - ``by_domain``:     dict of domain → total hours (entries with multiple
                         domains contribute to each domain's total)
    - ``by_status``:     dict of status → entry count
    - ``by_type``:       dict of type → entry count
    """
    rows = [r for r in storage.read_all() if r.get("status") != "deleted"]
    total_hours = 0.0
    by_domain: dict[str, float] = {}
    by_status: dict[str, int] = {}
    by_type: dict[str, int] = {}

    for row in rows:
        try:
            h = float(row.get("cpe_hours", 0))
        except (ValueError, TypeError):
            h = 0.0
        total_hours += h

        domains_str = row.get("domains") or row.get("domain", "Unknown")
        for d in domains_str.split("|"):
            d = d.strip()
            if d:
                by_domain[d] = by_domain.get(d, 0.0) + h

        st = row.get("status", "pending")
        by_status[st] = by_status.get(st, 0) + 1

        tp = row.get("type", "podcast")
        by_type[tp] = by_type.get(tp, 0) + 1

    return {
        "total_entries": len(rows),
        "total_hours": round(total_hours, 1),
        "by_domain": by_domain,
        "by_status": by_status,
        "by_type": by_type,
    }


# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------

@app.post("/api/admin/backfill-presenters")
def backfill_presenters():
    """
    Re-fetch the RSS feed and update the presenter field on existing entries
    by matching on URL.  Only entries whose presenter would change are written.

    Returns:
    - ``checked``: total entries in the CSV
    - ``updated``: entries whose presenter field was changed
    """
    from rss import fetch_security_now
    feed_entries = fetch_security_now()
    url_to_presenter = {e["url"]: e["presenter"] for e in feed_entries if e.get("url")}

    rows = storage.read_all()
    updated = 0
    for row in rows:
        url = row.get("url", "")
        if url in url_to_presenter:
            new_presenter = url_to_presenter[url]
            if row.get("presenter") != new_presenter:
                storage.update_entry(row["id"], {"presenter": new_presenter})
                updated += 1

    return {"checked": len(rows), "updated": updated}


@app.post("/api/admin/backfill-titles")
def backfill_titles():
    """
    Normalise all existing title values:
    1. Replace legacy "SN NNN:" prefix with "Security Now NNN:".
    2. Strip the subtitle suffix (" - <subtitle>") from the title.

    Uses the stored subtitle field where available; falls back to re-fetching
    the RSS feed for entries that have no subtitle stored yet.
    Idempotent — safe to run multiple times.

    Returns:
    - ``checked``: total entries in the CSV
    - ``updated``: entries whose title was changed
    """
    import re
    from rss import fetch_security_now

    # Build url -> subtitle map from the live RSS feed (covers recent episodes)
    try:
        feed_entries = fetch_security_now()
        url_to_subtitle = {e["url"]: e.get("subtitle", "") for e in feed_entries if e.get("url")}
    except Exception:
        url_to_subtitle = {}

    rows = storage.read_all()
    updated = 0
    for row in rows:
        old_title = row.get("title", "")
        new_title = re.sub(r'^SN\s+(\d+):', r'Security Now \1:', old_title)

        # Strip subtitle suffix — prefer live RSS, fall back to stored field
        subtitle = url_to_subtitle.get(row.get("url", ""), "") or row.get("subtitle", "")
        if subtitle and new_title.endswith(f" - {subtitle}"):
            new_title = new_title[: len(new_title) - len(subtitle) - 3]

        if new_title != old_title:
            storage.update_entry(row["id"], {"title": new_title})
            updated += 1

    return {"checked": len(rows), "updated": updated}


@app.post("/api/admin/backfill-subtitles")
def backfill_subtitles():
    """
    Re-fetch the RSS feed and populate the subtitle field on existing entries
    by matching on URL.  Only entries missing or differing in subtitle are written.

    Returns:
    - ``checked``: total entries in the CSV
    - ``updated``: entries whose subtitle field was set or changed
    """
    from rss import fetch_security_now
    feed_entries = fetch_security_now()
    url_to_subtitle = {e["url"]: e.get("subtitle", "") for e in feed_entries if e.get("url")}

    rows = storage.read_all()
    updated = 0
    for row in rows:
        url = row.get("url", "")
        if url in url_to_subtitle:
            new_subtitle = url_to_subtitle[url]
            if row.get("subtitle", "") != new_subtitle:
                storage.update_entry(row["id"], {"subtitle": new_subtitle})
                updated += 1

    return {"checked": len(rows), "updated": updated}


@app.get("/api/admin/storage")
def admin_storage():
    """
    List all proof attachment files in data/attachments/, resolved to their
    CPE entry titles.  Files for deleted entries are shown as '(entry deleted)'.

    Returns total storage used (bytes / KB / MB), file count, and a list of
    file dicts sorted largest-first:
    - filename, entry_id, title, size_bytes, size_kb
    """
    rows = storage.read_all()
    rows_by_id = {r["id"]: r for r in rows}
    attachments_dir = storage.get_attachments_dir()

    files = []
    total_bytes = 0
    for fname in os.listdir(attachments_dir):
        fpath = os.path.join(attachments_dir, fname)
        if not os.path.isfile(fpath):
            continue
        size = os.path.getsize(fpath)
        total_bytes += size
        entry_id = fname.rsplit(".", 1)[0]
        row = rows_by_id.get(entry_id)
        files.append({
            "filename": fname,
            "entry_id": entry_id,
            "title": row["title"] if row else "(entry deleted)",
            "size_bytes": size,
            "size_kb": round(size / 1024, 1),
        })

    files.sort(key=lambda f: f["size_bytes"], reverse=True)
    return {
        "total_size_bytes": total_bytes,
        "total_size_kb": round(total_bytes / 1024, 1),
        "total_size_mb": round(total_bytes / 1024 / 1024, 2),
        "file_count": len(files),
        "files": files,
    }


# Static files — mounted last so API routes take priority over the catch-all.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
