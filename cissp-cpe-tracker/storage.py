"""
Thread-safe CSV persistence layer for Cybersecurity CPE Tracker.

All reads and writes are serialised through a single ``threading.RLock`` so
concurrent FastAPI requests cannot interleave partial reads or writes.

Atomic writes
-------------
Data is written to ``<CSV_PATH>.tmp`` first, then renamed over the target
with ``os.replace()``.  On POSIX systems this rename is atomic; on Windows
it is best-effort but still avoids leaving a half-written file visible.

Configuration
-------------
``CSV_PATH`` is read from the ``CSV_PATH`` environment variable and defaults
to ``/app/data/cpes.csv`` (the Docker volume mount path).  Override it for
local development::

    CSV_PATH=./data/cpes.csv uvicorn main:app --reload --port 8000

Schema evolution
----------------
New fields are appended to ``FIELDNAMES`` and given defaults in
``_normalize_row()`` so files written by older versions continue to load
correctly without a migration step.

    v1.0  id, title, description, url, published_date, fetched_date,
          source, type, cpe_hours, domain, notes, status
    v1.2  presenter, cpe_summary, domains    (multi-domain tagging)
    v1.3  proof_image                         (screenshot attachment)
    v1.4  subtitle                            (itunes:subtitle short topic label)
    v1.5  duration                            (raw itunes:duration string)
    v1.6  submitted_date                      (ISO-8601 UTC; set when status → submitted)
    v1.7  certifications                      (pipe-separated vendor IDs: isc2, isaca, comptia)

Why RLock?
----------
``add_entries()`` calls ``read_all()`` while already holding the lock.
A plain ``threading.Lock`` would deadlock here; ``RLock`` allows the same
thread to re-acquire it.
"""

import csv
import os
import uuid
import threading
from datetime import datetime, timezone
from typing import Optional

CSV_PATH = os.environ.get("CSV_PATH", "/app/data/cpes.csv")

FIELDNAMES = [
    "id", "title", "description", "url", "published_date",
    "fetched_date", "source", "type", "cpe_hours", "domain",
    "notes", "status",
    # Fields added in v1.2 — appended for backward compatibility
    "presenter", "cpe_summary", "domains",
    # Fields added in v1.3 — appended for backward compatibility
    "proof_image",
    # Fields added in v1.4 — appended for backward compatibility
    "subtitle",
    # Fields added in v1.5 — appended for backward compatibility
    "duration",
    # Fields added in v1.6 — appended for backward compatibility
    "submitted_date",
    # Fields added in v1.7 — appended for backward compatibility
    "certifications",
]

# Reentrant lock — add_entries() calls read_all() while holding the lock.
_lock = threading.RLock()


def get_attachments_dir() -> str:
    """
    Return the path to the proof-image attachments directory.

    The directory is a sibling of the CSV file named ``attachments/`` and
    is created on first access if it does not already exist.
    """
    d = os.path.join(os.path.dirname(CSV_PATH), "attachments")
    os.makedirs(d, exist_ok=True)
    return d


def _normalize_row(row: dict) -> dict:
    """
    Back-fill default values for schema fields added after the initial v1.0
    release so that callers always see the full current schema regardless of
    when the row was written.
    """
    row.setdefault("presenter", "")
    # Migrate old field name isc2_summary → cpe_summary
    if "isc2_summary" in row and "cpe_summary" not in row:
        row["cpe_summary"] = row.pop("isc2_summary")
    else:
        row.pop("isc2_summary", None)
    row.setdefault("cpe_summary", "")
    row.setdefault("domains", row.get("domain", ""))
    row.setdefault("proof_image", "")
    row.setdefault("subtitle", "")
    row.setdefault("duration", "")
    row.setdefault("submitted_date", "")
    row.setdefault("certifications", "")
    # Migrate legacy "approved" status to "submitted" (renamed in v2.1)
    if row.get("status") == "approved":
        row["status"] = "submitted"
    return row


def _ensure_file():
    """
    Create the CSV file (and any missing parent directories) if it does not
    exist, writing the header row.  Called at the start of every read/write
    operation so the file is always in a known state before access.
    """
    if not os.path.exists(CSV_PATH):
        os.makedirs(os.path.dirname(CSV_PATH), exist_ok=True)
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()


def read_all() -> list[dict]:
    """
    Read and return every row from the CSV as a list of dicts.

    Applies ``_normalize_row`` to each row so callers always receive the full
    current schema even when reading files written by an older version.
    Thread-safe: acquires ``_lock`` for the duration of the file read.
    """
    _ensure_file()
    with _lock:
        with open(CSV_PATH, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            return [_normalize_row(dict(row)) for row in reader]


def get_existing_urls() -> set[str]:
    """Return the set of all URLs already present in the CSV."""
    rows = read_all()
    return {row["url"] for row in rows if row.get("url")}


def write_all(rows: list[dict]):
    """
    Overwrite the CSV with the given list of row dicts.

    Uses an atomic write pattern — data is staged to ``<CSV_PATH>.tmp``
    first, then renamed to ``CSV_PATH`` so the live file is never left in a
    partial state between a crash or power loss.

    **Caller must hold** ``_lock`` **before calling this function.**
    Extra keys not in ``FIELDNAMES`` are silently dropped (``extrasaction="ignore"``).
    """
    _ensure_file()
    tmp_path = CSV_PATH + ".tmp"
    with open(tmp_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(tmp_path, CSV_PATH)


def add_entry(entry: dict) -> dict:
    """
    Append a single entry to the CSV and return it with its generated id.

    Assigns a UUID4 ``id`` and sensible defaults for all optional fields.
    Unlike ``add_entries()``, this function does **not** deduplicate by URL —
    callers (typically the manual-add API route) are expected to avoid
    submitting duplicates.
    """
    entry["id"] = str(uuid.uuid4())
    entry.setdefault("fetched_date", datetime.now(timezone.utc).isoformat())
    entry.setdefault("notes", "")
    entry.setdefault("status", "pending")
    entry.setdefault("presenter", "")
    entry.setdefault("cpe_summary", "")
    entry.setdefault("domains", entry.get("domain", ""))
    entry.setdefault("proof_image", "")
    entry.setdefault("subtitle", "")
    entry.setdefault("duration", "")
    entry.setdefault("submitted_date", "")
    entry.setdefault("certifications", "")
    with _lock:
        rows = read_all()
        rows.append(entry)
        write_all(rows)
    return entry


def add_entries(entries: list[dict]) -> list[dict]:
    """
    Bulk-insert entries, skipping any whose URL already exists in the CSV.

    Deduplication is performed entirely within the lock so concurrent calls
    cannot race and insert the same URL twice.  Returns only the entries that
    were actually inserted (the "added" subset).

    Thread-safe: acquires ``_lock`` for the entire read → filter → write cycle.
    """
    added = []
    with _lock:
        rows = read_all()
        existing_urls = {row["url"] for row in rows if row.get("url")}
        for entry in entries:
            if entry.get("url") in existing_urls:
                continue
            entry["id"] = str(uuid.uuid4())
            entry.setdefault("fetched_date", datetime.now(timezone.utc).isoformat())
            entry.setdefault("notes", "")
            entry.setdefault("status", "pending")
            entry.setdefault("presenter", "")
            entry.setdefault("cpe_summary", "")
            entry.setdefault("domains", entry.get("domain", ""))
            entry.setdefault("proof_image", "")
            entry.setdefault("subtitle", "")
            entry.setdefault("certifications", "")
            rows.append(entry)
            existing_urls.add(entry["url"])
            added.append(entry)
        if added:
            write_all(rows)
    return added


def update_entry(entry_id: str, updates: dict) -> Optional[dict]:
    """
    Apply a partial update to the entry with the given ``entry_id``.

    Only keys present in the ``allowed`` whitelist are written; unknown keys
    are silently ignored to prevent callers from overwriting read-only fields
    such as ``id``, ``url``, or ``fetched_date``.

    When ``domains`` is updated without an explicit ``domain``, the primary
    domain (the first pipe-separated value) is kept in sync automatically.

    Returns the updated row dict, or ``None`` if ``entry_id`` was not found.
    """
    allowed = {
        "cpe_hours", "domain", "domains", "notes", "status",
        "title", "description", "presenter", "cpe_summary", "proof_image",
        "subtitle", "duration", "submitted_date", "certifications",
    }
    with _lock:
        rows = read_all()
        for row in rows:
            if row["id"] == entry_id:
                for key, val in updates.items():
                    if key in allowed:
                        row[key] = val
                # Keep domain in sync with primary of domains if domains updated
                if "domains" in updates and "domain" not in updates:
                    first = updates["domains"].split("|")[0].strip()
                    if first:
                        row["domain"] = first
                # Auto-stamp submitted_date when status is set to submitted
                if updates.get("status") == "submitted" and not updates.get("submitted_date"):
                    row["submitted_date"] = datetime.now(timezone.utc).isoformat()
                write_all(rows)
                return row
    return None


def delete_entry(entry_id: str) -> bool:
    """
    Soft-delete the entry with the given ``entry_id``.

    Sets ``status`` to ``"deleted"`` and keeps the row in the CSV so that its
    URL remains in the deduplication set — preventing the RSS fetcher from
    re-adding the episode on the next fetch.  The proof image is preserved so
    it can be viewed if the entry is later restored.

    Returns ``True`` if an entry was found and marked deleted, ``False`` if
    ``entry_id`` was not found.
    """
    with _lock:
        rows = read_all()
        for row in rows:
            if row["id"] == entry_id:
                row["status"] = "deleted"
                write_all(rows)
                return True
    return False


def purge_entry(entry_id: str) -> bool:
    """
    Permanently remove the entry with the given ``entry_id`` from the CSV.

    Also deletes the proof image file from disk if one is attached (missing
    files are silently ignored).  Unlike ``delete_entry()``, this operation is
    irreversible and removes the URL from the deduplication set.

    Returns ``True`` if an entry was removed, ``False`` if not found.
    """
    with _lock:
        rows = read_all()
        new_rows = [r for r in rows if r["id"] != entry_id]
        if len(new_rows) == len(rows):
            return False
        removed = [r for r in rows if r["id"] == entry_id]
        for row in removed:
            if row.get("proof_image"):
                proof_path = os.path.join(get_attachments_dir(), row["proof_image"])
                try:
                    os.remove(proof_path)
                except FileNotFoundError:
                    pass
        write_all(new_rows)
    return True


def purge_entries_by_source(source_name: str) -> int:
    """
    Permanently remove all entries whose ``source`` field matches ``source_name``.

    Also deletes any attached proof image files (missing files are silently
    ignored).  Unlike ``delete_entry()``, rows are removed entirely from the
    CSV so their URLs leave the deduplication set.

    Returns the count of rows removed.
    """
    with _lock:
        rows = read_all()
        keep = [r for r in rows if r.get("source") != source_name]
        removed = [r for r in rows if r.get("source") == source_name]
        if not removed:
            return 0
        for row in removed:
            if row.get("proof_image"):
                proof_path = os.path.join(get_attachments_dir(), row["proof_image"])
                try:
                    os.remove(proof_path)
                except FileNotFoundError:
                    pass
        write_all(keep)
        return len(removed)


def get_csv_path() -> str:
    """Return the absolute path to the CSV file, creating it first if necessary."""
    _ensure_file()
    return CSV_PATH
