"""Tests for rss.py — domain classification, duration parsing, and multi-feed fetching."""
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch
from rss import classify_domain, classify_domains, parse_duration, _DOMAIN_KEYWORDS, _within_cutoff


# ---------------------------------------------------------------------------
# classify_domain (backward-compat shim)
# ---------------------------------------------------------------------------

class TestClassifyDomain:
    """Unit tests for ``classify_domain()``, the single-domain backward-compat shim."""

    def test_network_keywords_map_to_network_domain(self):
        result = classify_domain(
            "TLS 1.3 and the Future of VPN Protocols",
            "A deep dive into TLS handshake, VPN tunneling, and firewall rules."
        )
        assert result == "Communication and Network Security"

    def test_cryptography_maps_to_architecture(self):
        result = classify_domain(
            "RSA vs Elliptic Curve Cryptography",
            "Comparing RSA and elliptic curve algorithms for key exchange and PKI."
        )
        assert result == "Security Architecture and Engineering"

    def test_malware_maps_to_security_operations(self):
        result = classify_domain(
            "New Ransomware Campaign Targets Healthcare",
            "Incident response playbook for ransomware. Threat actor used backdoor."
        )
        assert result == "Security Operations"

    def test_identity_keywords(self):
        result = classify_domain(
            "Multi-Factor Authentication Deep Dive",
            "Exploring MFA, SAML, OAuth, and zero trust identity architectures."
        )
        assert result == "Identity and Access Management"

    def test_vulnerability_maps_to_assessment(self):
        result = classify_domain(
            "Critical CVE-2024-9999 — Zero-Day in OpenSSL",
            "Penetration testers and bug bounty hunters are exploiting this flaw."
        )
        assert result == "Security Assessment and Testing"

    def test_sdlc_maps_to_software_development(self):
        result = classify_domain(
            "Secure Software Development Lifecycle",
            "OWASP top 10, SQL injection, XSS, and secure coding practices in DevSecOps."
        )
        assert result == "Software Development Security"

    def test_compliance_maps_to_risk_management(self):
        result = classify_domain(
            "GDPR and HIPAA Compliance in 2024",
            "Risk management frameworks, NIST guidance, and regulatory audit preparation."
        )
        assert result == "Security and Risk Management"

    def test_no_keywords_returns_default(self):
        assert classify_domain("Episode 999", "Steve and Leo chat.") == "Security Operations"

    def test_case_insensitive(self):
        assert classify_domain("RANSOMWARE INCIDENT RESPONSE", "FORENSIC ANALYSIS OF MALWARE") == "Security Operations"

    def test_empty_strings_return_default(self):
        assert classify_domain("", "") == "Security Operations"

    def test_title_contributes_to_score(self):
        assert classify_domain("DNS Hijacking via BGP Routing Attack", "") == "Communication and Network Security"

    def test_returns_string_not_list(self):
        assert isinstance(classify_domain("TLS Handshake", "Network firewall VPN"), str)


# ---------------------------------------------------------------------------
# classify_domains (multi-domain)
# ---------------------------------------------------------------------------

class TestClassifyDomains:
    """Unit tests for ``classify_domains()``, the multi-domain classifier."""

    def test_returns_list(self):
        result = classify_domains("Ransomware Incident Response", "Malware forensics.")
        assert isinstance(result, list)
        assert len(result) >= 1

    def test_top_domain_is_first(self):
        result = classify_domains(
            "TLS 1.3 and VPN Protocols",
            "Deep dive into TLS handshake, firewall, VPN, tcp/ip, and DNS routing."
        )
        assert result[0] == "Communication and Network Security"

    def test_shim_returns_first_element(self):
        title = "RSA Encryption and PKI"
        desc  = "cryptograph key management pki certificate authority digital signature"
        assert classify_domain(title, desc) == classify_domains(title, desc)[0]

    def test_no_more_than_three_domains(self):
        result = classify_domains(
            "ransomware tls cryptograph sql injection identity risk",
            "malware network encrypt authenticat compliance pentest devops"
        )
        assert len(result) <= 3

    def test_secondary_domain_included_above_threshold(self):
        result = classify_domains(
            "Ransomware and Cryptography",
            "Malware incident response with RSA encryption and PKI key management."
        )
        assert len(result) >= 2

    def test_no_keywords_returns_default_as_list(self):
        assert classify_domains("Episode 999", "Steve and Leo chat.") == ["Security Operations"]

    def test_empty_input_returns_default_list(self):
        assert classify_domains("", "") == ["Security Operations"]

    def test_all_results_are_valid_domains(self):
        result = classify_domains(
            "Zero trust identity and PKI certificate authority",
            "Authenticat, oauth, ldap, active directory, kerberos, RSA, elliptic curve."
        )
        for d in result:
            assert d in _DOMAIN_KEYWORDS

    def test_low_scoring_domain_excluded(self):
        result = classify_domains(
            "TLS Firewall VPN DNS Routing",
            "Network protocol BGP OSPF VLAN packet proxy firewall."
        )
        assert "Asset Security" not in result


# ---------------------------------------------------------------------------
# parse_duration
# ---------------------------------------------------------------------------

def _make_entry(**kwargs):
    entry = MagicMock()
    entry.get = lambda key, default="": kwargs.get(key, default)
    for k, v in kwargs.items():
        setattr(entry, k, v)
    return entry


class TestParseDuration:
    """Unit tests for ``parse_duration()``, covering all supported iTunes duration formats."""

    def test_hh_mm_ss_format(self):
        assert parse_duration(_make_entry(itunes_duration="02:15:30")) == 2.25

    def test_mm_ss_format(self):
        assert parse_duration(_make_entry(itunes_duration="45:00")) == 0.75

    def test_seconds_only_format(self):
        assert parse_duration(_make_entry(itunes_duration="3600")) == 1.0

    def test_rounds_to_nearest_quarter(self):
        assert parse_duration(_make_entry(itunes_duration="01:07:00")) == 1.0

    def test_rounds_up_to_quarter(self):
        assert parse_duration(_make_entry(itunes_duration="01:22:30")) == 1.5

    def test_missing_duration_returns_default(self):
        assert parse_duration(_make_entry(itunes_duration="")) == 1.0

    def test_no_itunes_duration_attribute(self):
        assert parse_duration(MagicMock(spec=[])) == 1.0

    def test_minimum_is_quarter_hour(self):
        assert parse_duration(_make_entry(itunes_duration="00:01:00")) == 0.25

    def test_long_episode(self):
        assert parse_duration(_make_entry(itunes_duration="03:00:00")) == 3.0

    def test_maximum_is_40_hours(self):
        assert parse_duration(_make_entry(itunes_duration="50:00:00")) == 40.0

    def test_invalid_value_returns_default(self):
        assert parse_duration(_make_entry(itunes_duration="not-a-duration")) == 1.0


# ---------------------------------------------------------------------------
# fetch_security_now field checks (mocked feed)
# ---------------------------------------------------------------------------

class TestFetchSecurityNowFields:
    """Integration tests for ``fetch_security_now()`` using a mocked feedparser response."""

    def _mock_entry(self, title="VPN Deep Dive", link="https://example.com/1",
                    summary="TLS handshake, VPN protocols, firewall, DNS routing.",
                    duration="01:00:00"):
        entry = MagicMock()
        entry.get = lambda key, default="": {
            "title": title, "link": link, "summary": summary,
        }.get(key, default)
        entry.itunes_duration = duration
        # Use a recent date so the 60-day cutoff filter doesn't drop this entry
        recent = (datetime.now(timezone.utc) - timedelta(days=7)).strftime(
            "%a, %d %b %Y %H:%M:%S +0000"
        )
        entry.published = recent
        return entry

    def test_entry_has_domains_field(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value.entries = [self._mock_entry()]
            from rss import fetch_security_now
            entries = fetch_security_now()
        assert "domains" in entries[0]
        assert len(entries[0]["domains"]) > 0

    def test_domain_is_first_of_domains(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value.entries = [self._mock_entry()]
            from rss import fetch_security_now
            entries = fetch_security_now()
        entry = entries[0]
        assert entry["domain"] == entry["domains"].split("|")[0]

    def test_presenter_is_steve_gibson(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value.entries = [self._mock_entry()]
            from rss import fetch_security_now
            entries = fetch_security_now()
        assert entries[0]["presenter"] == "Steve Gibson"

    def test_isc2_summary_field_present_and_empty(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value.entries = [self._mock_entry()]
            from rss import fetch_security_now
            entries = fetch_security_now()
        assert "isc2_summary" in entries[0]
        assert entries[0]["isc2_summary"] == ""


# ---------------------------------------------------------------------------
# fetch_feed and fetch_all (multi-feed)
# ---------------------------------------------------------------------------

def _make_parsed_feed(title="Test Podcast", entries=None):
    """Build a minimal feedparser result object for mocking."""
    parsed = MagicMock()
    parsed.feed.get = lambda key, default="": {"title": title}.get(key, default)
    parsed.entries = entries or []
    return parsed


def _make_feed_entry(title="Episode 1", link="https://example.com/ep1",
                     summary="Security episode about network and VPN.",
                     duration="01:00:00", author="Jane Doe", days_ago=7):
    entry = MagicMock()
    entry.get = lambda key, default="": {
        "title": title, "link": link, "summary": summary, "author": author,
    }.get(key, default)
    entry.itunes_duration = duration
    recent = (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime(
        "%a, %d %b %Y %H:%M:%S +0000"
    )
    entry.published = recent
    return entry


class TestFetchFeed:
    """Tests for the generic fetch_feed() function."""

    def test_source_field_set_from_name_param(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(
                title="My Podcast",
                entries=[_make_feed_entry()],
            )
            from rss import fetch_feed
            entries = fetch_feed("https://example.com/feed.xml", "My Custom Name")
        assert entries[0]["source"] == "My Custom Name"

    def test_returns_expected_fields(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(entries=[_make_feed_entry()])
            from rss import fetch_feed
            entries = fetch_feed("https://example.com/feed.xml", "Test")
        entry = entries[0]
        for field in ("title", "url", "description", "source", "type",
                      "cpe_hours", "domain", "domains", "presenter",
                      "isc2_summary", "duration", "published_date"):
            assert field in entry, f"Missing field: {field}"

    def test_empty_feed_returns_empty_list(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(entries=[])
            from rss import fetch_feed
            entries = fetch_feed("https://example.com/feed.xml", "Empty")
        assert entries == []


class TestWithinCutoff:
    """Unit tests for _within_cutoff()."""

    def test_recent_date_returns_true(self):
        recent = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        assert _within_cutoff(recent) is True

    def test_old_date_returns_false(self):
        old = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        assert _within_cutoff(old) is False

    def test_exactly_60_days_ago_is_false(self):
        cutoff = (datetime.now(timezone.utc) - timedelta(days=60, seconds=1)).isoformat()
        assert _within_cutoff(cutoff) is False

    def test_within_60_days_returns_true(self):
        borderline = (datetime.now(timezone.utc) - timedelta(days=59)).isoformat()
        assert _within_cutoff(borderline) is True

    def test_unparseable_date_returns_true(self):
        # Fail-safe: unknown dates are not silently dropped
        assert _within_cutoff("not-a-date") is True

    def test_custom_days_window(self):
        date_30_days_ago = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        assert _within_cutoff(date_30_days_ago, days=60) is True
        assert _within_cutoff(date_30_days_ago, days=20) is False


class TestFetchFeedCutoff:
    """Verify that fetch_feed() drops entries older than FETCH_CUTOFF_DAYS."""

    def test_old_entries_are_filtered(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(entries=[
                _make_feed_entry(days_ago=90),   # too old
                _make_feed_entry(link="https://example.com/ep2", days_ago=10),  # recent
            ])
            from rss import fetch_feed
            entries = fetch_feed("https://example.com/feed.xml", "Test")
        assert len(entries) == 1
        assert entries[0]["url"] == "https://example.com/ep2"

    def test_all_recent_entries_pass_through(self):
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(entries=[
                _make_feed_entry(days_ago=5),
                _make_feed_entry(link="https://example.com/ep2", days_ago=30),
            ])
            from rss import fetch_feed
            entries = fetch_feed("https://example.com/feed.xml", "Test")
        assert len(entries) == 2


class TestFetchAll:
    """Tests for the multi-feed fetch_all() function."""

    def test_skips_disabled_feeds(self):
        feeds = [
            {"url": "https://enabled.com/feed.xml", "name": "Enabled", "enabled": True},
            {"url": "https://disabled.com/feed.xml", "name": "Disabled", "enabled": False},
        ]
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(entries=[_make_feed_entry()])
            from rss import fetch_all
            entries = fetch_all(feeds)
        # feedparser.parse should only have been called once (for the enabled feed)
        assert mock_parse.call_count == 1

    def test_continues_past_failed_feed(self):
        feeds = [
            {"url": "https://bad.com/feed.xml", "name": "Bad", "enabled": True},
            {"url": "https://good.com/feed.xml", "name": "Good", "enabled": True},
        ]
        call_count = 0

        def side_effect(url):
            nonlocal call_count
            call_count += 1
            if "bad" in url:
                raise RuntimeError("Connection refused")
            return _make_parsed_feed(entries=[_make_feed_entry()])

        with patch("rss.feedparser.parse", side_effect=side_effect):
            from rss import fetch_all
            entries = fetch_all(feeds)

        assert call_count == 2
        assert len(entries) == 1  # only the good feed's entry

    def test_empty_feed_list_returns_empty(self):
        from rss import fetch_all
        assert fetch_all([]) == []

    def test_fetch_all_passes_per_feed_cutoff(self):
        """fetch_all() passes each feed's cutoff_days to fetch_feed()."""
        feeds = [
            {"url": "https://a.com/feed.xml", "name": "Feed A", "enabled": True, "cutoff_days": 10},
            {"url": "https://b.com/feed.xml", "name": "Feed B", "enabled": True, "cutoff_days": 90},
        ]
        # Entry published 30 days ago — inside Feed B's window, outside Feed A's
        old_entry = _make_feed_entry(
            link="https://a.com/ep-old",
            days_ago=30,
        )
        call_args = []

        def side_effect(url):
            call_args.append(url)
            return _make_parsed_feed(entries=[old_entry])

        with patch("rss.feedparser.parse", side_effect=side_effect):
            from rss import fetch_all
            entries = fetch_all(feeds)

        # Feed A (cutoff=10): 30-day-old entry dropped → 0 entries
        # Feed B (cutoff=90): 30-day-old entry kept → 1 entry
        assert len(entries) == 1


class TestFetchFeedCustomCutoff:
    """Verify that fetch_feed() honours the cutoff_days parameter."""

    def test_fetch_feed_respects_custom_cutoff(self):
        """Entry older than cutoff_days is excluded; recent entry is kept."""
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(entries=[
                _make_feed_entry(link="https://example.com/old", days_ago=45),   # outside 30-day cutoff
                _make_feed_entry(link="https://example.com/new", days_ago=10),   # inside 30-day cutoff
            ])
            from rss import fetch_feed
            entries = fetch_feed("https://example.com/feed.xml", "Test", cutoff_days=30)
        assert len(entries) == 1
        assert entries[0]["url"] == "https://example.com/new"

    def test_fetch_feed_default_cutoff_is_60(self):
        """When cutoff_days is not supplied, the 60-day default applies."""
        with patch("rss.feedparser.parse") as mock_parse:
            mock_parse.return_value = _make_parsed_feed(entries=[
                _make_feed_entry(link="https://example.com/ep-50", days_ago=50),  # within 60 days
                _make_feed_entry(link="https://example.com/ep-70", days_ago=70),  # outside 60 days
            ])
            from rss import fetch_feed
            entries = fetch_feed("https://example.com/feed.xml", "Test")
        assert len(entries) == 1
        assert entries[0]["url"] == "https://example.com/ep-50"
