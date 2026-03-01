"""
Thread-safe JSON feed configuration store for Cybersecurity CPE Tracker.

Persists the list of configured RSS feeds to ``data/feeds.json`` alongside
``cpes.csv``.  All reads and writes are protected by a reentrant lock and
writes are atomic (temp-file + os.replace), following the same pattern as
``storage.py``.

Public API
----------
read_feeds()               -> list[dict]
add_feed(url, name)        -> dict          raises ValueError on duplicate URL
update_feed(id, updates)   -> dict | None   None if not found
delete_feed(id)            -> bool          False if not found
"""

import json
import os
import threading
import uuid
from datetime import datetime, timezone

_CSV_PATH = os.environ.get("CSV_PATH", "/app/data/cpes.csv")
FEEDS_PATH = os.path.join(os.path.dirname(_CSV_PATH), "feeds.json")

_lock = threading.RLock()

DEFAULT_FEEDS = [
    {
        "id": "security-now",
        "name": "Security Now",
        "url": "https://feeds.twit.tv/sn.xml",
        "enabled": True,
        "added_date": "2024-01-01T00:00:00Z",
        "cutoff_days": 60,
    }
]

_ALLOWED_UPDATE_FIELDS = {"name", "enabled", "cutoff_days"}


def _read_file() -> list[dict]:
    """Read and parse feeds.json; return DEFAULT_FEEDS if file is missing."""
    if not os.path.exists(FEEDS_PATH):
        return [dict(f) for f in DEFAULT_FEEDS]
    with open(FEEDS_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_file(feeds: list[dict]) -> None:
    """Atomically write feeds list to feeds.json."""
    tmp = FEEDS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(feeds, fh, indent=2)
    os.replace(tmp, FEEDS_PATH)


def read_feeds() -> list[dict]:
    """Return all configured feeds. Re-reads the file on every call."""
    with _lock:
        return _read_file()


def add_feed(url: str, name: str) -> dict:
    """
    Add a new feed.

    Raises ``ValueError`` if a feed with the same URL already exists.
    Returns the newly created feed dict.
    """
    with _lock:
        feeds = _read_file()
        existing_urls = {f["url"] for f in feeds}
        if url in existing_urls:
            raise ValueError(f"Feed URL already exists: {url}")
        new_feed = {
            "id": str(uuid.uuid4()),
            "name": name,
            "url": url,
            "enabled": True,
            "added_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "cutoff_days": 60,
        }
        feeds.append(new_feed)
        _write_file(feeds)
        return dict(new_feed)


def update_feed(feed_id: str, updates: dict) -> dict | None:
    """
    Apply allowed field updates to a feed.

    Only ``name`` and ``enabled`` may be changed; other keys are silently
    ignored.  Returns the updated feed dict, or ``None`` if not found.
    """
    with _lock:
        feeds = _read_file()
        for feed in feeds:
            if feed["id"] == feed_id:
                for key, value in updates.items():
                    if key in _ALLOWED_UPDATE_FIELDS:
                        feed[key] = value
                _write_file(feeds)
                return dict(feed)
        return None


def delete_feed(feed_id: str) -> bool:
    """
    Remove a feed by ID.

    Returns ``True`` if removed, ``False`` if not found.
    Existing CPE entries are unaffected.
    """
    with _lock:
        feeds = _read_file()
        new_feeds = [f for f in feeds if f["id"] != feed_id]
        if len(new_feeds) == len(feeds):
            return False
        _write_file(new_feeds)
        return True
