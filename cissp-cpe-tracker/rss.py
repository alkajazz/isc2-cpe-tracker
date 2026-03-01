"""
RSS feed fetcher and CISSP domain classifier for Cybersecurity CPE Tracker.

Responsibilities
----------------
- Fetch RSS feeds (any podcast) and return entries ready for CSV storage
- Fetch the Security Now podcast RSS feed (``feeds.twit.tv/sn.xml``)
- Parse episode metadata: title, description, URL, publish date, duration
- Classify episodes against the 8 CISSP domains using keyword scoring
- Normalise Security Now episode titles: ``SN 999:`` → ``Security Now 999:``
- Extract presenter names from RSS ``media:credit`` tags

Domain classification
---------------------
Title and description text are lowercased and scored against per-domain
keyword lists (substring matching).  All domains whose score is >= 50 % of
the top score are returned, up to a cap of ``max_domains`` (default 3).
This allows a single episode that spans multiple domains to be tagged
accordingly.  When no keywords match, the default domain
(``Security Operations``) is returned.

CPE hours
---------
Episode duration is read from the ``itunes:duration`` RSS tag and rounded to
the nearest 0.25-hour increment.  A minimum of 0.25 h is enforced; the
fallback for missing/unparseable durations is 1.0 h.
"""

import logging
import re
import feedparser
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from typing import Optional

logger = logging.getLogger(__name__)

# Episodes older than this many days are skipped at fetch time.
FETCH_CUTOFF_DAYS = 60

SECURITY_NOW_RSS = "https://feeds.twit.tv/sn.xml"

CISSP_DOMAIN_DEFAULT = "Security Operations"

# Keyword lists scored against title + description (lowercased).
# Keywords are substrings — "authenticat" matches authenticate/authentication/etc.
_DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "Security and Risk Management": [
        "risk management", "risk assessment", "risk framework", "compliance",
        "governance", "policy", "regulation", "regulatory", "nist", "iso 27001",
        "gdpr", "hipaa", "fedramp", "sox", "legal", "liability", "audit",
        "business continuity", "disaster recovery", "bcp", "due diligence",
        "due care", "ethics", "cia triad",
    ],
    "Asset Security": [
        "data classification", "data handling", "data lifecycle", "data retention",
        "data ownership", "data custodian", "pii", "personally identifiable",
        "sensitive data", "data destruction", "media sanitization", "scoping",
        "asset inventory", "data privacy",
    ],
    "Security Architecture and Engineering": [
        "cryptograph", "encrypt", "decrypt", "cipher", "algorithm", "hash",
        "pki", "certificate authority", "digital signature", "key management",
        "tpm", "hsm", "secure boot", "hardware security", "quantum cryptograph",
        "architecture", "security model", "trusted computing", "side channel",
        "secure enclave", "key exchange", "diffie-hellman", "rsa", "aes",
        "elliptic curve", "block cipher", "stream cipher",
    ],
    "Communication and Network Security": [
        "network", "firewall", "vpn", "tcp/ip", "tcp ", " udp", "dns",
        "http", "tls", "ssl", "wireless", "wi-fi", "wifi", "bluetooth",
        "routing", "bgp", "ospf", "vlan", "packet", "proxy", "cdn",
        "load balancer", "nat ", "ipv6", "ipv4", "protocol", "port scanning",
        "network segmentation", "dmz", "ipsec",
    ],
    "Identity and Access Management": [
        "identity", "authenticat", "authoriz", "access control", " iam ",
        "single sign-on", "sso", "multi-factor", "mfa", "two-factor", "2fa",
        "oauth", "saml", "openid", "ldap", "active directory", "zero trust",
        "privileged access", "least privilege", "credential", "password",
        "biometric", "federation", "provisioning", "kerberos",
    ],
    "Security Assessment and Testing": [
        "vulnerabilit", "penetration test", "pentest", "pen test", "exploit",
        "vulnerability scan", "bug bounty", "cve-", "patch", "zero-day",
        "zero day", "proof of concept", "poc ", "fuzzing", "code review",
        "static analysis", "dynamic analysis", "red team", "blue team",
        "purple team", "security audit", "risk assessment",
    ],
    "Security Operations": [
        "incident response", "incident ", "forensic", "malware", "ransomware",
        "threat intelligence", "threat actor", "attack", "siem", " soc ",
        "monitor", "detection", "indicator of compromise", "ioc", "phishing",
        "botnet", "trojan", "backdoor", "apt ", "advanced persistent",
        "breach", "intrusion", "edr", "endpoint detection", "playbook",
        "chain of custody", "log analysis",
    ],
    "Software Development Security": [
        "software development", "secure coding", "sdlc", "devsecops", "devops",
        "web application", "api security", "sql injection", "xss",
        "cross-site", "buffer overflow", "owasp", "static analysis",
        "dependency", "supply chain", "code injection", "deserialization",
        "secure design", "threat model",
    ],
}


def classify_domains(title: str, description: str, max_domains: int = 3) -> list[str]:
    """
    Score title+description against CISSP domain keywords.
    Returns all domains whose score >= 50% of the top score, capped at max_domains.
    Falls back to [CISSP_DOMAIN_DEFAULT] when no keywords match.
    """
    text = (title + " " + description).lower()
    scores: dict[str, int] = {
        domain: sum(1 for kw in keywords if kw in text)
        for domain, keywords in _DOMAIN_KEYWORDS.items()
    }
    top_score = max(scores.values())
    if top_score == 0:
        return [CISSP_DOMAIN_DEFAULT]

    threshold = top_score * 0.5
    qualifying = sorted(
        [d for d, s in scores.items() if s >= threshold],
        key=lambda d: scores[d],
        reverse=True,
    )
    return qualifying[:max_domains] if qualifying else [CISSP_DOMAIN_DEFAULT]


def classify_domain(title: str, description: str) -> str:
    """Backward-compatible shim — returns the single top-scoring domain."""
    return classify_domains(title, description)[0]


def _get_raw_duration(entry) -> str:
    """Return the raw itunes:duration string from a feedparser entry, or ''."""
    raw = getattr(entry, "itunes_duration", None)
    if raw is None:
        try:
            raw = entry.get("itunes_duration", "")
        except AttributeError:
            raw = ""
    return str(raw).strip()


def parse_duration(entry) -> float:
    """
    Parse itunes:duration from a feedparser entry to CPE hours.
    Rounds to the nearest 0.25 increment (1 hour = 1.0 CPE).
    Returns 1.0 as fallback if duration is missing or unparseable.
    """
    raw = getattr(entry, "itunes_duration", None)
    if raw is None:
        try:
            raw = entry.get("itunes_duration", "")
        except AttributeError:
            raw = ""

    raw = str(raw).strip()
    try:
        parts = raw.split(":")
        if len(parts) == 3:
            total_seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            total_seconds = int(parts[0]) * 60 + int(parts[1])
        else:
            total_seconds = int(raw)

        total_hours = total_seconds / 3600
        rounded = round(round(total_hours / 0.25) * 0.25, 2)
        return min(max(rounded, 0.25), 40.0)
    except (ValueError, TypeError):
        return 1.0


def _parse_date(entry) -> str:
    """
    Extract the publish date from a feedparser entry and return an ISO-8601
    UTC timestamp string.

    Attempts three strategies in order:
    1. ``entry.published``        — RFC 2822 string parsed via ``email.utils``
    2. ``entry.published_parsed`` — ``struct_time`` converted via ``time.mktime``
    3. Fallback to the current UTC time when both of the above fail.
    """
    try:
        if hasattr(entry, "published"):
            dt = parsedate_to_datetime(entry.published)
            return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    try:
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            import time
            ts = time.mktime(entry.published_parsed)
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except Exception:
        pass
    return datetime.now(timezone.utc).isoformat()


def _clean_text(text: Optional[str], max_len: int = 500) -> str:
    """
    Strip HTML tags from ``text`` and truncate to ``max_len`` characters.

    Returns an empty string for ``None`` or empty input.  The truncation
    appends ``"..."`` so callers can tell the description was cut.
    """
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", "", text)
    text = text.strip()
    if len(text) > max_len:
        text = text[:max_len] + "..."
    return text


def _within_cutoff(date_str: str, days: int = FETCH_CUTOFF_DAYS) -> bool:
    """
    Return True if ``date_str`` (ISO-8601 UTC) is within the past ``days`` days.
    Returns True on parse failure so ambiguous entries are never silently dropped.
    """
    try:
        dt = datetime.fromisoformat(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        return dt >= cutoff
    except Exception:
        return True


def fetch_security_now() -> list[dict]:
    """
    Fetch the Security Now RSS feed and return a list of episode dicts ready
    to be inserted into the CSV by ``storage.add_entries()``.

    Each returned dict contains:
    - ``title``          — normalised episode title (SN → Security Now prefix)
    - ``subtitle``       — short topic label from itunes:subtitle (e.g. "Cybercrime Goes Pro")
    - ``description``    — HTML-stripped, truncated episode summary
    - ``url``            — canonical episode link (used for deduplication)
    - ``published_date`` — ISO-8601 UTC string
    - ``source``         — always ``"Security Now Podcast"``
    - ``type``           — always ``"podcast"``
    - ``cpe_hours``      — duration rounded to nearest 0.25 h (string)
    - ``duration``       — raw itunes:duration string (e.g. "1:32:45")
    - ``domain``         — primary (highest-scoring) CISSP domain
    - ``domains``        — pipe-separated list of up to 3 CISSP domains
    - ``presenter``      — from ``media:credit`` host roles, or ``"Steve Gibson"``
    - ``cpe_summary``   — empty string (filled in manually by the user)
    """
    feed = feedparser.parse(SECURITY_NOW_RSS)
    entries = []

    for item in feed.entries:
        title = item.get("title", "Untitled")
        title = re.sub(r'^SN\s+(\d+):', r'Security Now \1:', title)

        # itunes:subtitle — short topic label (e.g. "Cybercrime Goes Pro")
        subtitle = _clean_text(
            item.get("itunes_subtitle", "") or item.get("subtitle", ""),
            max_len=200,
        )

        # Drop the subtitle from the title — it always appears as " - <subtitle>"
        # e.g. "Security Now 1064: Least Privilege - Cybercrime Goes Pro" -> "Security Now 1064: Least Privilege"
        if subtitle and title.endswith(f" - {subtitle}"):
            title = title[: len(title) - len(subtitle) - 3]
        url = item.get("link", "")
        description = _clean_text(item.get("summary", ""))
        published_date = _parse_date(item)
        if not _within_cutoff(published_date):
            continue
        domains_list = classify_domains(title, description)
        cpe_hours = parse_duration(item)
        duration_raw = _get_raw_duration(item)

        credits = item.get("media_credit", [])
        hosts = [c["content"] for c in credits if isinstance(c, dict) and c.get("role") == "host" and c.get("content")]
        presenter = " & ".join(hosts) if hosts else "Steve Gibson"

        podcast_entry = {
            "title": title,
            "subtitle": subtitle,
            "description": description,
            "url": url,
            "published_date": published_date,
            "source": "Security Now Podcast",
            "type": "podcast",
            "cpe_hours": str(cpe_hours),
            "domain": domains_list[0],
            "domains": "|".join(domains_list),
            "presenter": presenter,
            "cpe_summary": "",
            "duration": duration_raw,
        }
        entries.append(podcast_entry)

    return entries


def fetch_feed(url: str, name: str, cutoff_days: int = FETCH_CUTOFF_DAYS) -> list[dict]:
    """
    Fetch any RSS podcast feed and return a list of entry dicts.

    Works with any feed that exposes standard RSS/Atom fields.  Unlike
    ``fetch_security_now()``, no Security Now-specific normalisation is
    applied (no title prefix rewrite, no subtitle stripping).

    Each returned dict contains the same fields as ``fetch_security_now()``:
    ``title``, ``subtitle``, ``description``, ``url``, ``published_date``,
    ``source`` (set to *name*), ``type``, ``cpe_hours``, ``duration``,
    ``domain``, ``domains``, ``presenter``, ``cpe_summary``.

    :param cutoff_days: Only include entries published within this many days.
    """
    parsed = feedparser.parse(url)
    feed_author = parsed.feed.get("author", "") if hasattr(parsed, "feed") else ""
    entries = []

    for item in parsed.entries:
        title = item.get("title", "Untitled")
        subtitle = _clean_text(
            item.get("itunes_subtitle", "") or item.get("subtitle", ""),
            max_len=200,
        )
        item_url = item.get("link", "")
        description = _clean_text(item.get("summary", ""))
        published_date = _parse_date(item)
        if not _within_cutoff(published_date, days=cutoff_days):
            continue
        domains_list = classify_domains(title, description)
        cpe_hours = parse_duration(item)
        duration_raw = _get_raw_duration(item)

        presenter = item.get("author", "") or feed_author

        entries.append({
            "title": title,
            "subtitle": subtitle,
            "description": description,
            "url": item_url,
            "published_date": published_date,
            "source": name,
            "type": "podcast",
            "cpe_hours": str(cpe_hours),
            "domain": domains_list[0],
            "domains": "|".join(domains_list),
            "presenter": presenter,
            "cpe_summary": "",
            "duration": duration_raw,
        })

    return entries


def fetch_all(feeds: list[dict]) -> list[dict]:
    """
    Fetch all enabled feeds and return a single flat list of entry dicts.

    Each feed dict must have at minimum ``url``, ``name``, and ``enabled``
    keys (as stored by ``feed_store``).  Disabled feeds are skipped.  A
    failed feed is logged and skipped so other feeds are unaffected.
    """
    results = []
    for feed in feeds:
        if not feed.get("enabled", True):
            continue
        try:
            results.extend(fetch_feed(
                feed["url"], feed["name"],
                feed.get("cutoff_days", FETCH_CUTOFF_DAYS),
            ))
        except Exception as e:
            logger.error("feed fetch failed %s: %s", feed.get("url"), e)
    return results
