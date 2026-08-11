#!/usr/bin/env python3
"""
Worker configuration + secret access.

Loads settings from the environment (optionally seeded from a local .env file),
and reads portal passwords from the macOS Keychain the same way
virtual-agent-lookup does - so no secret ever sits in committed source.
"""
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no dependency). Only sets keys not already in the
    environment, so real env vars always win over the file."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


_load_dotenv(ROOT / ".env")


def _bool(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


# ---- safety --------------------------------------------------------------
# The ONLY values that arm live provisioning (turn dry-run OFF). Must be an exact,
# trimmed, lowercased match.
_DRY_RUN_LIVE_VALUES = {"0", "false", "no", "off"}


def _dry_run_from_env() -> bool:
    """Master safety switch, fail-safe by construction. DRY_RUN is ON (dry) for
    ANY value that is not an exact, trimmed, lowercased member of the live-set.
    Unset, empty, or a typo (e.g. 'ture', 'flase', 'yes') therefore stays DRY -
    the switch must never fail OPEN to live provisioning. Live requires a
    deliberate, correctly-spelled '0'/'false'/'no'/'off'."""
    raw = os.environ.get("DRY_RUN", "1").strip().lower()
    return raw not in _DRY_RUN_LIVE_VALUES


DRY_RUN: bool = _dry_run_from_env()

# ---- sheet bus -----------------------------------------------------------
SHEET_ID: str = os.environ.get("SHEET_ID", "").strip()
GOOGLE_KEY_PATH: str = os.environ.get("GOOGLE_KEY_PATH", str(ROOT / "service-account.json"))
PROVISIONING_TAB: str = os.environ.get("PROVISIONING_TAB", "Provisioning Queue")
OFFBOARDING_TAB: str = os.environ.get("OFFBOARDING_TAB", "Offboarding Queue")

# ---- browser -------------------------------------------------------------
HEADLESS: bool = _bool("HEADLESS", "1")
PROFILE_DIR: Path = Path(os.environ.get("PROFILE_DIR", str(ROOT / "browser_profile")))

# ---- run limits ----------------------------------------------------------
MAX_ROWS_PER_PASS: int = _int("MAX_ROWS_PER_PASS", 25)   # 0 = no limit
MAX_ATTEMPTS: int = _int("MAX_ATTEMPTS", 3)

# ---- per-portal admin identities ----------------------------------------
# (username from env, password from Keychain via get_password()).
PORTAL_ACCOUNTS = {
    "property24": {
        "user": os.environ.get("P24_ADMIN_USER", "").strip(),
        "keychain_service": os.environ.get("P24_KEYCHAIN_SERVICE", "property24-admin"),
    },
    "cma": {
        "user": os.environ.get("CMA_ADMIN_USER", "").strip(),
        "keychain_service": os.environ.get("CMA_KEYCHAIN_SERVICE", "cma-info"),
    },
    "dialfire": {
        "user": os.environ.get("DIALFIRE_ADMIN_USER", "").strip(),
        "keychain_service": os.environ.get("DIALFIRE_KEYCHAIN_SERVICE", "dialfire-admin"),
    },
    "propdata": {
        "user": os.environ.get("PROPDATA_ADMIN_USER", "").strip(),
        "keychain_service": os.environ.get("PROPDATA_KEYCHAIN_SERVICE", "propdata-admin"),
    },
}

# ---- Programs-page account-flag mirror tabs -------------------------------
# Same tracker sheet (SHEET_ID above), mirrored 1:1 from apps-script/Config.js's
# CFG.TAB.CMA_ACCOUNTS / PROPDATA_ACCOUNTS - see worker/programs_mirror.py.
CMA_ACCOUNTS_TAB: str = os.environ.get("CMA_ACCOUNTS_TAB", "CMA Accounts")
PROPDATA_ACCOUNTS_TAB: str = os.environ.get("PROPDATA_ACCOUNTS_TAB", "PropData Accounts")

# ---- PropData (PDMS) specifics -------------------------------------------
# The company id is the /secure/<id>/ segment of the PDMS admin URL (Quay 1 = 46).
PROPDATA_COMPANY_ID: str = os.environ.get("PROPDATA_COMPANY_ID", "46").strip()
PROPDATA_BRANCH: str = os.environ.get("PROPDATA_BRANCH", "Quay 1 International Realty")
PROPDATA_PORTAL: str = os.environ.get("PROPDATA_PORTAL", "Property24")
# Whether to add the Property24 portal-feed row during a PDMS create. Default OFF: PDMS's own
# marketing/help popups intermittently overlay the Portal section, so the feed selection can fail
# and leave a half-filled row that blocks the whole save. Off = the core agent profile saves
# reliably; the feed can be added manually or re-enabled once the popup handling is solid.
PROPDATA_PORTAL_FEED: bool = _bool("PROPDATA_PORTAL_FEED", "0")
# Default profile picture for candidate ("-") agents: the Quay 1 logo shipped in the repo.
# Full-status agents pass a per-person photo_path (Canva headshot) in the queue payload.
PROPDATA_DEFAULT_PHOTO: str = os.environ.get(
    "PROPDATA_DEFAULT_PHOTO", str(ROOT / "assets" / "quay1_profile.png"))


def get_password(keychain_service: str, account: str) -> str:
    """Read a password from the macOS Keychain (generic password item).

    Mirrors virtual-agent-lookup's get_credentials(). Raises RuntimeError if the
    item is missing so callers fail loudly rather than logging in blank.
    """
    if not account:
        raise RuntimeError(f"no account/username set for keychain service {keychain_service!r}")
    try:
        pw = subprocess.check_output(
            ["security", "find-generic-password",
             "-s", keychain_service, "-a", account, "-w"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        raise RuntimeError(
            f"password not found in Keychain (service={keychain_service!r}, "
            f"account={account!r}): {e}")
    if not pw:
        raise RuntimeError(
            f"Keychain item (service={keychain_service!r}, account={account!r}) is EMPTY. "
            f"Re-store it in a real Terminal: "
            f"security add-generic-password -U -s {keychain_service} -a {account} -w")
    return pw
