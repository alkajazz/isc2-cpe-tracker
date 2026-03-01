"""Tests for feed_store.py — thread-safe JSON feed configuration store."""
import json
import os
import pytest

import feed_store


@pytest.fixture(autouse=True)
def patch_feeds_path(tmp_path, monkeypatch):
    """Redirect FEEDS_PATH to a temp directory for every test."""
    feeds_file = str(tmp_path / "feeds.json")
    monkeypatch.setattr(feed_store, "FEEDS_PATH", feeds_file)


# ---------------------------------------------------------------------------
# read_feeds
# ---------------------------------------------------------------------------

class TestReadFeeds:
    def test_returns_default_when_file_missing(self):
        feeds = feed_store.read_feeds()
        assert len(feeds) == 1
        assert feeds[0]["name"] == "Security Now"
        assert feeds[0]["url"] == "https://feeds.twit.tv/sn.xml"

    def test_returns_default_with_enabled_true(self):
        feeds = feed_store.read_feeds()
        assert feeds[0]["enabled"] is True

    def test_returns_persisted_feeds(self, tmp_path):
        data = [{"id": "x", "name": "Test", "url": "https://x.com/feed.xml",
                 "enabled": True, "added_date": "2024-01-01T00:00:00Z"}]
        feeds_file = feed_store.FEEDS_PATH
        with open(feeds_file, "w") as f:
            json.dump(data, f)
        feeds = feed_store.read_feeds()
        assert len(feeds) == 1
        assert feeds[0]["name"] == "Test"

    def test_re_reads_file_on_each_call(self):
        """Changes written directly to disk are reflected in subsequent reads."""
        # First call — default (file missing)
        feeds = feed_store.read_feeds()
        assert feeds[0]["name"] == "Security Now"

        # Write a different feed to the path
        new_data = [{"id": "y", "name": "Other", "url": "https://y.com/feed.xml",
                     "enabled": True, "added_date": "2024-01-01T00:00:00Z"}]
        with open(feed_store.FEEDS_PATH, "w") as f:
            json.dump(new_data, f)

        feeds2 = feed_store.read_feeds()
        assert feeds2[0]["name"] == "Other"


# ---------------------------------------------------------------------------
# add_feed
# ---------------------------------------------------------------------------

class TestAddFeed:
    def test_add_returns_feed_dict(self):
        result = feed_store.add_feed("https://example.com/feed.xml", "Example")
        assert result["name"] == "Example"
        assert result["url"] == "https://example.com/feed.xml"
        assert result["enabled"] is True
        assert "id" in result
        assert "added_date" in result

    def test_add_persists_to_file(self):
        feed_store.add_feed("https://example.com/feed.xml", "Example")
        feeds = feed_store.read_feeds()
        urls = [f["url"] for f in feeds]
        assert "https://example.com/feed.xml" in urls

    def test_add_generates_uuid(self):
        r1 = feed_store.add_feed("https://a.com/feed.xml", "A")
        r2 = feed_store.add_feed("https://b.com/feed.xml", "B")
        assert r1["id"] != r2["id"]

    def test_add_raises_on_duplicate_url(self):
        feed_store.add_feed("https://example.com/feed.xml", "Example")
        with pytest.raises(ValueError, match="already exists"):
            feed_store.add_feed("https://example.com/feed.xml", "Duplicate")

    def test_add_multiple_feeds(self):
        feed_store.add_feed("https://a.com/feed.xml", "A")
        feed_store.add_feed("https://b.com/feed.xml", "B")
        feeds = feed_store.read_feeds()
        urls = [f["url"] for f in feeds]
        assert "https://a.com/feed.xml" in urls
        assert "https://b.com/feed.xml" in urls


# ---------------------------------------------------------------------------
# update_feed
# ---------------------------------------------------------------------------

class TestUpdateFeed:
    def test_update_enabled_false(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Example")
        result = feed_store.update_feed(feed["id"], {"enabled": False})
        assert result["enabled"] is False

    def test_update_name(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Old Name")
        result = feed_store.update_feed(feed["id"], {"name": "New Name"})
        assert result["name"] == "New Name"

    def test_update_persists_to_file(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Example")
        feed_store.update_feed(feed["id"], {"enabled": False})
        feeds = feed_store.read_feeds()
        match = next(f for f in feeds if f["id"] == feed["id"])
        assert match["enabled"] is False

    def test_update_ignores_disallowed_fields(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Example")
        original_url = feed["url"]
        original_id = feed["id"]
        result = feed_store.update_feed(feed["id"], {
            "url": "https://evil.com/feed.xml",
            "id": "hacked",
            "added_date": "1970-01-01T00:00:00Z",
            "name": "OK",
        })
        assert result["url"] == original_url
        assert result["id"] == original_id
        assert result["name"] == "OK"

    def test_update_returns_none_for_unknown_id(self):
        result = feed_store.update_feed("nonexistent-id", {"enabled": False})
        assert result is None


# ---------------------------------------------------------------------------
# delete_feed
# ---------------------------------------------------------------------------

class TestCutoffDays:
    def test_add_feed_has_default_cutoff_days(self):
        result = feed_store.add_feed("https://example.com/feed.xml", "Example")
        assert result["cutoff_days"] == 60

    def test_update_cutoff_days(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Example")
        result = feed_store.update_feed(feed["id"], {"cutoff_days": 120})
        assert result["cutoff_days"] == 120

    def test_update_cutoff_days_persists(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Example")
        feed_store.update_feed(feed["id"], {"cutoff_days": 90})
        feeds = feed_store.read_feeds()
        match = next(f for f in feeds if f["id"] == feed["id"])
        assert match["cutoff_days"] == 90

    def test_default_feed_has_cutoff_days(self):
        feeds = feed_store.read_feeds()
        assert "cutoff_days" in feeds[0]
        assert feeds[0]["cutoff_days"] == 60


class TestDeleteFeed:
    def test_delete_returns_true(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Example")
        assert feed_store.delete_feed(feed["id"]) is True

    def test_delete_removes_from_file(self):
        feed = feed_store.add_feed("https://example.com/feed.xml", "Example")
        feed_store.delete_feed(feed["id"])
        feeds = feed_store.read_feeds()
        ids = [f["id"] for f in feeds]
        assert feed["id"] not in ids

    def test_delete_returns_false_for_unknown_id(self):
        assert feed_store.delete_feed("nonexistent-id") is False

    def test_delete_leaves_other_feeds_intact(self):
        f1 = feed_store.add_feed("https://a.com/feed.xml", "A")
        f2 = feed_store.add_feed("https://b.com/feed.xml", "B")
        feed_store.delete_feed(f1["id"])
        feeds = feed_store.read_feeds()
        ids = [f["id"] for f in feeds]
        assert f1["id"] not in ids
        assert f2["id"] in ids
