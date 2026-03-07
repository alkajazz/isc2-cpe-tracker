"""
Cybersecurity CPE Tracker — FastAPI application entry point.

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

import base64
import ipaddress
import os
import secrets
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.requests import Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import storage
import feed_store
import scheduler as sched

# ---------------------------------------------------------------------------
# Optional HTTP Basic Auth
# Read AUTH_USER and AUTH_PASS from environment.  Auth is only enforced when
# BOTH variables are set to non-empty strings; omitting either disables it.
# ---------------------------------------------------------------------------
AUTH_USER = os.getenv("AUTH_USER", "")
AUTH_PASS = os.getenv("AUTH_PASS", "")
AUTH_ENABLED = bool(AUTH_USER and AUTH_PASS)

# MIME types accepted for proof screenshot uploads.
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}

# Magic byte signatures used to detect image type from raw file contents.
# Checked in order; WebP has a special two-field check handled in the helper.
MAGIC_BYTES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
    b"RIFF": "image/webp",  # RIFF....WEBP -- further validated below
}

MIME_TO_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB


def _detect_image_type(data: bytes) -> str | None:
    """
    Inspect the raw bytes of an uploaded file and return its MIME type based
    on magic byte signatures.  Returns None if the data does not match any
    recognised image format.  The Content-Type header from the client is
    intentionally ignored -- only the actual file contents are trusted.
    """
    for magic, mime in MAGIC_BYTES.items():
        if data.startswith(magic):
            # WebP: RIFF prefix is shared with other RIFF formats; confirm the
            # sub-type marker at bytes 8-12.
            if mime == "image/webp":
                if data[8:12] == b"WEBP":
                    return "image/webp"
                return None
            return mime
    return None


# ---------------------------------------------------------------------------
# SSRF protection -- feed URL validation
# ---------------------------------------------------------------------------

_PRIVATE_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local
    ipaddress.ip_network("::1/128"),           # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),          # IPv6 ULA
]


def _validate_feed_url(url: str) -> None:
    """Raise ValueError if the URL is not a safe public http/https URL.

    This blocks the most common SSRF vectors: direct use of private-range IP
    addresses and localhost aliases.  It does NOT perform DNS resolution, so a
    hostname that resolves to a private IP is not caught here.  Full
    DNS-based SSRF protection would require resolving every hostname and
    checking all returned addresses — that complexity is out of scope for this
    lightweight implementation.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        raise ValueError("Invalid URL")
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Feed URL must use http or https")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid URL: missing hostname")
    # Block numeric IP addresses that fall in private/loopback ranges.
    try:
        addr = ipaddress.ip_address(hostname)
        for net in _PRIVATE_NETWORKS:
            if addr in net:
                raise ValueError("Feed URL must be a public address")
    except ValueError as exc:
        if "public address" in str(exc):
            raise
        # hostname is not a bare IP address — DNS resolution not performed here
    # Block well-known localhost aliases regardless of case.
    if hostname.lower() in ("localhost", "localhost.localdomain"):
        raise ValueError("Feed URL must be a public address")



@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the background RSS scheduler on startup; stop it on shutdown."""
    sched.start_scheduler()
    yield
    sched.stop_scheduler()


app = FastAPI(title="Cybersecurity CPE Tracker", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Security middlewares
# Registration order note: FastAPI/Starlette runs middlewares in reverse
# registration order (last registered = outermost = runs first).  We register
# the security-headers middleware first and the auth middleware second so that
# auth is evaluated before any application logic — and security headers are
# always added regardless of the auth outcome.
# ---------------------------------------------------------------------------

@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """Inject security-hardening response headers on every response."""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


@app.middleware("http")
async def basic_auth_middleware(request: Request, call_next):
    """
    Enforce HTTP Basic Auth when AUTH_USER and AUTH_PASS env vars are both set.

    If AUTH_ENABLED is False (either var missing/empty), all requests pass
    through unchanged — backward-compatible default.

    Uses secrets.compare_digest for timing-safe credential comparison to
    prevent timing-based username/password enumeration attacks.
    """
    if not AUTH_ENABLED:
        return await call_next(request)

    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth_header[6:]).decode("utf-8", errors="replace")
            provided_user, _, provided_pass = decoded.partition(":")
            user_ok = secrets.compare_digest(provided_user, AUTH_USER)
            pass_ok = secrets.compare_digest(provided_pass, AUTH_PASS)
            if user_ok and pass_ok:
                return await call_next(request)
        except Exception:
            pass  # malformed header — fall through to 401

    return Response(
        content="Unauthorized",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="CPE Tracker"'},
    )


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
    cpe_summary: str = ""
    notes: str = ""
    status: str = "pending"
    subtitle: str = ""
    certifications: str = ""


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
    cpe_summary: Optional[str] = None
    subtitle: Optional[str] = None
    certifications: Optional[str] = None


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

    # Enforce size cap: read one byte beyond the limit so we can detect oversize
    # files without buffering the entire upload into memory first.
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")

    # Validate by magic bytes, not the client-supplied Content-Type header.
    detected = _detect_image_type(contents)
    if detected not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="File must be a valid image (JPEG, PNG, GIF, or WebP)")

    # Derive a safe extension from the detected MIME type; never trust file.filename.
    ext = MIME_TO_EXT.get(detected, "bin")
    filename = f"{entry_id}.{ext}"
    attachments_dir = storage.get_attachments_dir()

    with open(os.path.join(attachments_dir, filename), "wb") as f:
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
    # Confinement check: resolve symlinks and verify the path stays inside the
    # attachments directory.  Prevents path traversal via crafted proof_image values.
    safe_path = os.path.realpath(path)
    allowed_dir = os.path.realpath(storage.get_attachments_dir())
    if not safe_path.startswith(allowed_dir + os.sep):
        raise HTTPException(status_code=400, detail="Invalid file reference")
    if not os.path.exists(safe_path):
        raise HTTPException(status_code=404, detail="Proof image file not found")

    return FileResponse(safe_path)


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
        # Confinement check: resolve symlinks and verify the path stays inside the
        # attachments directory.  Prevents path traversal via crafted proof_image values.
        safe_path = os.path.realpath(path)
        allowed_dir = os.path.realpath(storage.get_attachments_dir())
        if not safe_path.startswith(allowed_dir + os.sep):
            raise HTTPException(status_code=400, detail="Invalid file reference")
        try:
            os.remove(safe_path)
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

    # SSRF guard — reject private/loopback addresses and non-http(s) schemes
    try:
        _validate_feed_url(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

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


@app.get("/api/backup")
def download_backup():
    """
    Create and stream a ZIP archive containing all persistent data:

    - ``cpes.csv``            — all CPE entries
    - ``feeds.json``          — configured RSS feed list
    - ``attachments/<file>``  — all proof screenshot files

    The zip is built in memory and streamed directly — nothing is written to
    disk.  The filename includes today's UTC date, e.g.
    ``cpe-backup-2026-02-28.zip``.
    """
    import io
    import zipfile
    from datetime import datetime, timezone
    from fastapi.responses import StreamingResponse

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        csv_path = storage.get_csv_path()
        if os.path.exists(csv_path):
            zf.write(csv_path, "cpes.csv")

        if os.path.exists(feed_store.FEEDS_PATH):
            zf.write(feed_store.FEEDS_PATH, "feeds.json")

        attachments_dir = storage.get_attachments_dir()
        for fname in os.listdir(attachments_dir):
            fpath = os.path.join(attachments_dir, fname)
            if os.path.isfile(fpath):
                zf.write(fpath, f"attachments/{fname}")

    buf.seek(0)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filename = f"cpe-backup-{date_str}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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
    rows_by_proof = {r["proof_image"]: r for r in rows if r.get("proof_image")}
    attachments_dir = storage.get_attachments_dir()

    files = []
    total_bytes = 0
    for fname in os.listdir(attachments_dir):
        fpath = os.path.join(attachments_dir, fname)
        if not os.path.isfile(fpath):
            continue
        size = os.path.getsize(fpath)
        total_bytes += size
        row = rows_by_proof.get(fname)
        files.append({
            "filename": fname,
            "entry_id": row["id"] if row else None,
            "title": row["title"] if row else "(entry deleted)",
            "size_bytes": size,
            "size_kb": round(size / 1024, 1),
        })

    csv_path = storage.get_csv_path()
    csv_bytes = os.path.getsize(csv_path) if os.path.exists(csv_path) else 0
    csv_rows = len(rows)

    files.sort(key=lambda f: f["size_bytes"], reverse=True)
    return {
        "total_size_bytes": total_bytes,
        "total_size_kb": round(total_bytes / 1024, 1),
        "total_size_mb": round(total_bytes / 1024 / 1024, 2),
        "file_count": len(files),
        "csv_size_bytes": csv_bytes,
        "csv_size_kb": round(csv_bytes / 1024, 1),
        "csv_row_count": csv_rows,
        "files": files,
    }


# Static files — mounted last so API routes take priority over the catch-all.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
