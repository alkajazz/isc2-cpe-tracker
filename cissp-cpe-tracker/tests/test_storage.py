"""Tests for storage.py — read/write/update/soft-delete/purge/deduplication."""
import os
import pytest
import storage as st


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _entry(**kwargs):
    defaults = {
        "title": "Test Episode",
        "description": "A test episode.",
        "url": "https://example.com/ep1",
        "published_date": "2024-01-01T00:00:00+00:00",
        "source": "Manual",
        "type": "podcast",
        "cpe_hours": "1.0",
        "domain": "Security Operations",
        "domains": "Security Operations",
        "notes": "",
        "status": "pending",
        "presenter": "",
        "isc2_summary": "",
        "proof_image": "",
        "subtitle": "",
        "duration": "",
        "submitted_date": "",
    }
    defaults.update(kwargs)
    return defaults


def _seed(tmp_path, entries):
    """Temporarily override CSV_PATH and insert entries, returning the path."""
    csv_path = str(tmp_path / "cpes.csv")
    monkeypatch_csv(csv_path)
    for e in entries:
        st.add_entry(dict(e))
    return csv_path


def monkeypatch_csv(path):
    st.CSV_PATH = path


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def isolated_csv(tmp_path):
    """Each test gets its own temp CSV and the module-level CSV_PATH is restored afterwards."""
    original = st.CSV_PATH
    st.CSV_PATH = str(tmp_path / "cpes.csv")
    yield
    st.CSV_PATH = original


# ---------------------------------------------------------------------------
# read_all / add_entry basics
# ---------------------------------------------------------------------------

class TestReadWrite:
    def test_empty_csv_returns_empty_list(self):
        assert st.read_all() == []

    def test_add_entry_assigns_uuid(self):
        row = st.add_entry(_entry())
        assert row["id"] and len(row["id"]) == 36

    def test_add_entry_persists(self):
        st.add_entry(_entry(title="Ep 1"))
        rows = st.read_all()
        assert len(rows) == 1
        assert rows[0]["title"] == "Ep 1"

    def test_multiple_entries_ordered_by_insertion(self):
        st.add_entry(_entry(title="A", url="https://example.com/a"))
        st.add_entry(_entry(title="B", url="https://example.com/b"))
        rows = st.read_all()
        assert [r["title"] for r in rows] == ["A", "B"]


# ---------------------------------------------------------------------------
# add_entries deduplication
# ---------------------------------------------------------------------------

class TestAddEntries:
    def test_deduplication_skips_existing_url(self):
        st.add_entry(_entry(url="https://example.com/ep1"))
        added = st.add_entries([_entry(url="https://example.com/ep1", title="Dup")])
        assert added == []
        assert len(st.read_all()) == 1

    def test_new_url_is_added(self):
        st.add_entry(_entry(url="https://example.com/ep1"))
        added = st.add_entries([_entry(url="https://example.com/ep2", title="New")])
        assert len(added) == 1
        assert len(st.read_all()) == 2

    def test_deduplication_blocks_soft_deleted_url(self):
        """A soft-deleted entry's URL must still block re-insertion from RSS."""
        entry = st.add_entry(_entry(url="https://example.com/ep1"))
        st.delete_entry(entry["id"])  # soft delete

        added = st.add_entries([_entry(url="https://example.com/ep1", title="Re-fetched")])
        assert added == []  # must not be re-added
        assert len(st.read_all()) == 1  # only the soft-deleted row


# ---------------------------------------------------------------------------
# update_entry
# ---------------------------------------------------------------------------

class TestUpdateEntry:
    def test_update_allowed_field(self):
        row = st.add_entry(_entry())
        updated = st.update_entry(row["id"], {"notes": "great episode"})
        assert updated["notes"] == "great episode"

    def test_update_protected_field_is_ignored(self):
        row = st.add_entry(_entry(url="https://example.com/ep1"))
        st.update_entry(row["id"], {"url": "https://evil.com"})
        assert st.read_all()[0]["url"] == "https://example.com/ep1"

    def test_update_nonexistent_id_returns_none(self):
        assert st.update_entry("no-such-id", {"notes": "x"}) is None

    def test_submitted_status_stamps_submitted_date(self):
        row = st.add_entry(_entry())
        assert row.get("submitted_date") == ""
        st.update_entry(row["id"], {"status": "submitted"})
        updated = st.read_all()[0]
        assert updated["submitted_date"] != ""

    def test_non_submitted_status_does_not_stamp_date(self):
        row = st.add_entry(_entry())
        st.update_entry(row["id"], {"status": "archived"})
        assert st.read_all()[0]["submitted_date"] == ""

    def test_domains_syncs_primary_domain(self):
        row = st.add_entry(_entry())
        st.update_entry(row["id"], {"domains": "Asset Security|Security Operations"})
        updated = st.read_all()[0]
        assert updated["domain"] == "Asset Security"


# ---------------------------------------------------------------------------
# delete_entry (soft delete)
# ---------------------------------------------------------------------------

class TestSoftDelete:
    def test_soft_delete_sets_status_deleted(self):
        row = st.add_entry(_entry())
        result = st.delete_entry(row["id"])
        assert result is True
        rows = st.read_all()
        assert len(rows) == 1
        assert rows[0]["status"] == "deleted"

    def test_soft_delete_row_remains_in_csv(self):
        row = st.add_entry(_entry())
        st.delete_entry(row["id"])
        # Row must still be present for deduplication
        assert len(st.read_all()) == 1

    def test_soft_delete_proof_image_preserved(self, tmp_path):
        """Proof image file must NOT be removed on soft delete."""
        attachments = tmp_path / "attachments"
        attachments.mkdir()
        proof_file = attachments / "proof.png"
        proof_file.write_bytes(b"fake-png")

        row = st.add_entry(_entry(proof_image="proof.png"))
        st.delete_entry(row["id"])

        assert proof_file.exists()

    def test_soft_delete_nonexistent_id_returns_false(self):
        assert st.delete_entry("no-such-id") is False

    def test_restore_via_update(self):
        row = st.add_entry(_entry())
        st.delete_entry(row["id"])
        st.update_entry(row["id"], {"status": "pending"})
        updated = st.read_all()[0]
        assert updated["status"] == "pending"


# ---------------------------------------------------------------------------
# purge_entry (hard delete)
# ---------------------------------------------------------------------------

class TestPurgeEntry:
    def test_purge_removes_row(self):
        row = st.add_entry(_entry())
        result = st.purge_entry(row["id"])
        assert result is True
        assert st.read_all() == []

    def test_purge_deletes_proof_image(self, tmp_path):
        attachments = tmp_path / "attachments"
        attachments.mkdir()
        proof_file = attachments / f"proof.png"
        proof_file.write_bytes(b"fake-png")

        row = st.add_entry(_entry(proof_image="proof.png"))
        st.purge_entry(row["id"])

        assert not proof_file.exists()

    def test_purge_missing_proof_does_not_raise(self):
        row = st.add_entry(_entry(proof_image="nonexistent.png"))
        st.purge_entry(row["id"])  # should not raise

    def test_purge_nonexistent_id_returns_false(self):
        assert st.purge_entry("no-such-id") is False

    def test_purge_allows_url_re_insertion(self):
        """After a hard purge the URL should no longer block re-insertion."""
        row = st.add_entry(_entry(url="https://example.com/ep1"))
        st.purge_entry(row["id"])
        added = st.add_entries([_entry(url="https://example.com/ep1", title="Re-added")])
        assert len(added) == 1


# ---------------------------------------------------------------------------
# get_existing_urls
# ---------------------------------------------------------------------------

class TestGetExistingUrls:
    def test_includes_soft_deleted_urls(self):
        row = st.add_entry(_entry(url="https://example.com/ep1"))
        st.delete_entry(row["id"])
        urls = st.get_existing_urls()
        assert "https://example.com/ep1" in urls

    def test_excludes_purged_urls(self):
        row = st.add_entry(_entry(url="https://example.com/ep1"))
        st.purge_entry(row["id"])
        assert "https://example.com/ep1" not in st.get_existing_urls()
