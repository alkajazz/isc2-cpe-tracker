"""Tests for rss.py — domain classification and duration parsing."""
import pytest
from unittest.mock import MagicMock, patch
from rss import classify_domain, classify_domains, parse_duration, _DOMAIN_KEYWORDS


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
        entry.published = "Mon, 01 Jan 2024 00:00:00 +0000"
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
