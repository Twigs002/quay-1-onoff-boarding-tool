#!/usr/bin/env python3
"""
PropData (PDMS) provisioner - browser-driven.

PropData has no usable user-management API, so a new agent profile is created by
driving the PDMS admin (manage.propdata.net) exactly the way an admin does by
hand. The flow below was mapped from a live walk-through of the "Add User" form;
every control is targeted by its accessible name (React combobox / textbox), not
a brittle id, so it survives PDMS re-renders.

CREATE flow (mirrors the recorded walk-through):
  Record Details -> Status=Active, Branch=Quay 1 International Realty,
                    Display on Branches=Quay 1 International Realty
  User Details   -> First Name, Last Name, Email, Country Code=+27 (ZA), Cell,
                    and Designation ONLY for full-FFC agents (candidates keep the
                    default "-")
  Portal Feeds   -> add one row: Status=Active, Portal=Property24,
                    Branch=Quay 1 International Realty
  Profile Picture-> upload the photo (Quay 1 logo for candidates; a per-person
                    Canva headshot later for full-status agents)
  Save User

Designation rule (from the induction FFC status):
  blank / candidate  -> "-"  (form default, left untouched)
  full status        -> "Non-Principal Property Practitioner"

Safety: like every provisioner this honors config.DRY_RUN. In dry-run it logs the
exact fields it WOULD enter and never opens a browser or submits.

Arming (live) needs, once, on this Mac:
  - a CLI-readable Keychain item for the PDMS admin login, e.g.
      security add-generic-password -s propdata-admin -a pagan@quay1.co.za -w
  - PROPDATA_ADMIN_USER=pagan@quay1.co.za in the worker env
  - a first headed login (HEADLESS=0) so the persistent context stores the
    session cookie for subsequent headless runs.
"""
from __future__ import annotations

import re

import config
from log_setup import get_logger
from .base import Person, Provisioner, Skip, result
from .browser import portal_page

log = get_logger("propdata")

PROFILE_NAME = "propdata"

# --- live DOM selectors (mapped from the PDMS "Add User" page) --------------
# PDMS builds each field as a react-select or a plain input inside a group div
# with a stable id "field-<name>". react-select needs: click the .control, filter,
# then click the matching .option (get_by_role/label do NOT work on react-select).
F_STATUS = "#field-active"                    # Status (Active/Inactive)
F_BRANCH = "#field-branches"                  # Branch
F_DISPLAY = "#field-display_on_branches"      # Display on Branches
F_DESIGNATION = "#field-designation"          # Designation
F_COUNTRY = "#field-cell_number"              # Country Code react-select lives here
I_FIRST = "#input-field-first_name"
I_LAST = "#input-field-last_name"
I_EMAIL = "#input-field-email"
I_CELL = "#input-cell_number"
FILE_PHOTO = "#image"                          # profile-picture <input type=file>, hidden
# Portal Feeds row (created by the single "Add" button) uses dynamic UUID ids, so
# its three selects are targeted by exact label text, taking the LAST occurrence
# (Record Details already owns a "Status"/"Branch" group above).
PF_STATUS = 'div.form-group:has(> label:text-is("Status"))'
PF_PORTAL = 'div.form-group:has(> label:text-is("Portal"))'
PF_BRANCH = 'div.form-group:has(> label:text-is("Branch"))'

# Fixed PDMS field values for a Quay 1 agent (see module docstring).
BRANCH = config.PROPDATA_BRANCH
PORTAL = config.PROPDATA_PORTAL
STATUS_ACTIVE = "Active"
COUNTRY_CODE = "+27 (ZA)"
DESIGNATION_FULL = "Non-Principal Property Practitioner"
DESIGNATION_CANDIDATE = "-"  # the form default; left untouched for candidates

_LOGIN_URL = "https://manage.propdata.net/login"

# PDMS embeds a HubSpot marketing "Popup CTA" iframe that overlays the form and
# intercepts clicks (and re-injects itself if removed). Abort these requests so it
# never loads. Purely a tracker/marketing block - none are needed to save a user.
_MARKETING_BLOCK = re.compile(
    r"(hs-sites\.com|hubspot|hs-scripts|hs-banner|hs-analytics|hsforms|"
    r"usemessages|hsadspixel|hscollectedforms|js\.hs)", re.I)


def _add_url() -> str:
    return "https://manage.propdata.net/secure/%s/agents/add" % config.PROPDATA_COMPANY_ID


def _agents_url() -> str:
    return "https://manage.propdata.net/secure/%s/agents/" % config.PROPDATA_COMPANY_ID


def _designation_for(person: Person) -> str:
    """Map induction FFC status -> PDMS Designation. A full-FFC holder is a
    'Non-Principal Property Practitioner'; anyone else (blank/candidate) keeps the
    form's default "-". The payload's precomputed value wins if present."""
    pd = person.payload or {}
    explicit = str(pd.get("designation") or "").strip()
    if explicit:
        return explicit
    ffc = str(pd.get("ffc_status") or "").strip().lower()
    role = str(pd.get("role") or "").strip().lower()
    is_full = ffc == "full" or role == "agent"
    return DESIGNATION_FULL if is_full else DESIGNATION_CANDIDATE


def _last_name(person: Person) -> str:
    pd = person.payload or {}
    if pd.get("last_name"):
        return str(pd["last_name"])
    # fall back to everything after the first token of the full name
    parts = (person.full_name or "").split()
    return " ".join(parts[1:]) if len(parts) > 1 else ""


def _email(person: Person) -> str:
    pd = person.payload or {}
    return person.quay_email or str(pd.get("email") or "")


def _photo_path(person: Person) -> str:
    """Light resolver (no network/build): an explicit payload path, else the logo.
    Used by the dry-run log. The LIVE path calls _resolve_photo() which may build."""
    pd = person.payload or {}
    return str(pd.get("photo_path") or "") or config.PROPDATA_DEFAULT_PHOTO


def _resolve_photo(person: Person) -> str:
    """Live photo path. Full-status agents with a FICA headshot get a branded Prop24
    photo built on the fly (download headshot -> rembg -> composite). Any failure, or
    no headshot, falls back to the Quay 1 logo so a save never ships a blank picture."""
    pd = person.payload or {}
    if pd.get("photo_path"):                       # explicit override wins
        return str(pd["photo_path"])
    file_id = str(pd.get("photo_file_id") or "").strip()
    if not file_id:
        return config.PROPDATA_DEFAULT_PHOTO
    try:
        import os
        import tempfile
        import drive
        import photo_pipeline
        tmp = tempfile.mkdtemp(prefix="p24_")
        src = drive.download_file(file_id, os.path.join(tmp, "headshot"))
        return photo_pipeline.build_prop24_photo(src, os.path.join(tmp, "p24.png"))
    except Exception as e:
        log.warning("prop24 photo build failed (%s) - using default logo", e)
        return config.PROPDATA_DEFAULT_PHOTO


class PropDataProvisioner(Provisioner):
    system = "propdata"

    # ---- dry-run: spell out the exact intended live steps -------------------
    def _create_dry(self, person: Person) -> dict:
        designation = _designation_for(person)
        log.info(
            "[DRY_RUN] propdata.create WOULD: log in to PDMS as %s, open Add User, set "
            "Status=Active Branch=%r Display=%r; First=%r Last=%r Email=%r Country=%r Cell=%r "
            "Designation=%r; add Portal Feed (Active/%s/%r); upload photo=%r; Save User",
            config.PORTAL_ACCOUNTS["propdata"]["user"] or "<unset>",
            BRANCH, BRANCH, person.first_name, _last_name(person), _email(person),
            COUNTRY_CODE, person.cell, designation, PORTAL, BRANCH, _photo_path(person),
        )
        pd = person.payload or {}
        would_photo = ("branded Prop24 photo built from FICA headshot id=%s"
                       % pd["photo_file_id"]) if pd.get("photo_file_id") else _photo_path(person)
        return result(True, "create", self.system, simulated=True,
                      would="add PDMS agent profile",
                      would_email=_email(person),
                      would_designation=designation,
                      would_photo=would_photo)

    def _deactivate_dry(self, person: Person) -> dict:
        log.info("[DRY_RUN] propdata.deactivate WOULD: log in, find user by email=%r, "
                 "set Status=Inactive, Save", _email(person))
        return result(True, "deactivate", self.system, simulated=True,
                      would="set PDMS agent Inactive", would_email=_email(person))

    # ---- live create --------------------------------------------------------
    def _create_live(self, person: Person) -> dict:
        email = _email(person)
        if not (person.first_name and email):
            raise ValueError("propdata create needs at least first_name and email")
        designation = _designation_for(person)

        with portal_page(PROFILE_NAME) as page:
            page.route(_MARKETING_BLOCK, lambda route: route.abort())  # kill the HubSpot popup
            self._login(page)  # returns only once authenticated AND on the Add User page
            self._dismiss_autosave(page)
            log.info("propdata add-page url=%s title=%r", page.url, page.title())
            try:
                page.wait_for_selector(F_STATUS, state="attached", timeout=30000)
            except Exception:
                import os as _os
                dbg = _os.environ.get("PROPDATA_DEBUG_SHOT", "/tmp/propdata_debug.png")
                try:
                    page.screenshot(path=dbg, full_page=True)
                    log.error("Status field missing; url=%s title=%r saved shot=%s",
                              page.url, page.title(), dbg)
                except Exception:  # noqa: BLE001
                    pass
                raise

            # Record Details
            self._rs(page, page.locator(F_STATUS), STATUS_ACTIVE)
            self._rs(page, page.locator(F_BRANCH), BRANCH)
            self._rs(page, page.locator(F_DISPLAY), BRANCH)

            # User Details
            page.locator(I_FIRST).fill(person.first_name)
            page.locator(I_LAST).fill(_last_name(person))
            page.locator(I_EMAIL).fill(email)
            self._rs(page, page.locator(F_COUNTRY), COUNTRY_CODE)
            page.locator(I_CELL).fill(person.cell or "")
            # Designation is REQUIRED: candidates get "-" (actively selected, not defaulted),
            # full-status agents get the practitioner title.
            self._rs(page, page.locator(F_DESIGNATION), designation)

            # Portal Feeds -> one Property24 row (best-effort: a failure here must not
            # lose the whole create - the agent record still saves without the feed).
            portal_added = self._try_portal_feed(page)

            # Profile Picture (best-effort for the same reason).
            photo_added = self._try_photo(page, _resolve_photo(person))

            # Save
            self._save(page)
            self._await_save(page)

        log.info("propdata.create OK: %s (%s) designation=%s portal_feed=%s photo=%s",
                 person.full_name, email, designation, portal_added, photo_added)
        return result(True, "create", self.system, email=email, designation=designation,
                      portal_feed_added=portal_added, photo_added=photo_added)

    def _deactivate_live(self, person: Person) -> dict:
        # The offboard/deactivate DOM path was not part of the mapped walk-through.
        # Skip (terminal, not a retryable error) so an admin sets the user Inactive
        # by hand until this flow is mapped and verified.
        raise Skip("PropData deactivate not mapped yet - set the PDMS user Status=Inactive manually")

    # ---- helpers ------------------------------------------------------------
    def _login(self, page) -> None:
        """Return only once we are authenticated AND sitting on the Add User page.

        PDMS is an SPA whose auth token is written to storage slightly AFTER the
        post-login route change, so a hard navigation immediately after sign-in can
        race and bounce back to /login. We therefore loop: navigate to the add page,
        and if it bounces to /login, submit credentials and retry (with a settle
        delay) until the add page holds."""
        for attempt in range(4):
            page.goto(_add_url(), wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(1500)  # allow the SPA's client-side auth redirect
            if "/login" not in page.url:
                return  # authenticated and on the Add User page
            if attempt == 3:
                break
            self._submit_login(page)
            page.wait_for_timeout(2500)  # let the auth token persist before re-navigating
        self._shot(page, "_login")
        raise Skip("Could not reach an authenticated PDMS Add User page "
                   "(login rejected, or session not persisting?)")

    def _submit_login(self, page) -> None:
        """Fill the PDMS login form and submit. Does NOT navigate afterwards - the
        caller re-navigates to the target page once the session settles."""
        acct = config.PORTAL_ACCOUNTS["propdata"]
        if not acct["user"]:
            raise Skip("PROPDATA_ADMIN_USER not set - cannot log in to PDMS")
        pw = config.get_password(acct["keychain_service"], acct["user"])
        uname = page.locator("#input-username")
        pwd = page.locator("#input-password")
        uname.click()
        uname.fill(acct["user"])
        pwd.click()
        pwd.fill("")
        pwd.press_sequentially(pw, delay=25)  # real keystrokes for the react-controlled field
        log.info("propdata login: field lens user=%d pass=%d",
                 len(uname.input_value() or ""), len(pwd.input_value() or ""))
        page.get_by_role("button", name="Sign in").click()
        # Poll for the client-side route to leave /login (a rejected login stays put).
        for _ in range(30):
            page.wait_for_timeout(500)
            if "/login" not in page.url:
                page.wait_for_load_state("networkidle", timeout=20000)
                return
        self._shot(page, "_login")
        raise Skip("PDMS login rejected (check the propdata-admin Keychain password)")

    def _shot(self, page, suffix: str) -> None:
        import os as _os
        dbg = _os.environ.get("PROPDATA_DEBUG_SHOT", "/tmp/propdata_debug.png")
        try:
            page.screenshot(path=dbg.replace(".png", suffix + ".png"))
        except Exception:  # noqa: BLE001
            pass

    def _dismiss_autosave(self, page) -> None:
        """PDMS offers to restore a half-finished draft ('You have unsaved work').
        Always Discard it so each run starts from a clean form."""
        try:
            btn = page.get_by_role("button", name="Discard")
            if btn.count() and btn.first.is_visible():
                btn.first.click()
        except Exception:  # noqa: BLE001 - banner is best-effort, never fatal
            pass

    def _rs(self, page, group, value: str) -> None:
        """Pick `value` in a PDMS react-select. Opens the control, waits for options
        (some load async), and clicks the exact-text option. If the option is not
        already shown (e.g. the huge Country Code list), narrows it with REAL
        keystrokes - react-select ignores Playwright's fill(), so press_sequentially
        is required to trigger its search."""
        exact_re = re.compile(r"^\s*%s\s*$" % re.escape(value))
        group.locator(".react-select__control").first.click()
        opts = page.locator(".react-select__option")
        try:
            opts.first.wait_for(state="visible", timeout=6000)
        except Exception:  # noqa: BLE001
            pass
        if opts.filter(has_text=exact_re).count() == 0:
            group.locator("input.react-select__input").first.press_sequentially(value, delay=30)
            page.wait_for_timeout(900)
        exact = opts.filter(has_text=exact_re)
        target = exact if exact.count() else opts.filter(has_text=value)
        if target.count():
            target.first.click()
        else:
            group.locator("input.react-select__input").first.press("Enter")
        page.wait_for_timeout(150)

    def _try_portal_feed(self, page) -> bool:
        """Add one Portal Feed row (Active / Property24 / Quay 1). Best-effort: any
        failure is logged and swallowed so the agent still saves without the feed."""
        try:
            page.get_by_role("button", name="Add", exact=True).first.click()
            page.wait_for_timeout(500)
            # The new row's three selects share labels with fields above, so take .last.
            self._rs(page, page.locator(PF_STATUS).last, STATUS_ACTIVE)
            self._rs(page, page.locator(PF_PORTAL).last, PORTAL)
            self._rs(page, page.locator(PF_BRANCH).last, BRANCH)
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("propdata portal-feed step failed (agent still saved): %s", e)
            return False

    def _try_photo(self, page, path: str) -> bool:
        """Set the profile picture by feeding the hidden file input directly (no OS
        chooser needed). Best-effort: logged and swallowed on failure."""
        try:
            page.locator(FILE_PHOTO).set_input_files(path)
            page.wait_for_timeout(500)
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("propdata photo upload failed (agent still saved): %s", e)
            return False

    def _save(self, page) -> None:
        """Click the Save User control (a styled <div>, not a <button>)."""
        btn = page.locator("div.save.navitem")
        if btn.count():
            btn.first.click()
        else:
            page.get_by_text("Save User", exact=True).click()

    def _await_save(self, page) -> None:
        """Confirm the save actually persisted. On success PDMS leaves the /add page
        (back to the users list). If it stays on /add, the form was rejected - gather
        the visible 'required' field errors and raise so the caller reports failure
        instead of a false success."""
        for _ in range(30):
            page.wait_for_timeout(500)
            url = page.url
            if "/login" in url:
                # bounced to login mid-save = session expired, NOT a successful save. Fail loudly so
                # the row is not falsely recorded as done with no PDMS profile actually created.
                raise RuntimeError("PDMS session expired during save - agent may not have been created")
            # Success only when PDMS leaves the add form FOR the users list / a user detail page.
            if "/agents/add" not in url and "/agents" in url:
                return
        # still on the add form -> collect actionable diagnostics (not just "unknown"): (a) any field
        # group carrying a required/invalid/error marker (by class OR text, since PDMS does not always
        # print the word "required"), and (b) any visible alert / toast / validation banner text.
        info = {}
        try:
            info = page.evaluate(
                """() => {
                    const norm = t => (t||'').replace(/\\s+/g,' ').trim();
                    const fields = [...document.querySelectorAll('.form-group, [class*=field-]')]
                        .filter(g => /required|invalid|error/i.test(g.className + ' ' + g.innerText))
                        .map(g => norm((g.querySelector('label')||{}).textContent)).filter(Boolean);
                    const banners = [...document.querySelectorAll('.alert, .toast, .notification, [class*=error], [role=alert]')]
                        .map(n => norm(n.innerText)).filter(Boolean);
                    return { fields: [...new Set(fields)].slice(0,12), banners: [...new Set(banners)].slice(0,6) };
                }""") or {}
        except Exception:  # noqa: BLE001
            info = {}
        self._shot(page, "_savefail")
        fields = info.get("fields") or []
        banners = info.get("banners") or []
        detail = "; ".join(p for p in [
            ("fields flagged: " + ", ".join(fields)) if fields else "",
            ("messages: " + " | ".join(banners)) if banners else "",
        ] if p) or "no field/banner captured - see the _savefail screenshot"
        raise RuntimeError("PDMS did not save (still on Add User). %s" % detail)


# module-level singletons for the dispatch table in poll.py
_provisioner = PropDataProvisioner()


def create(person: Person) -> dict:
    return _provisioner.create(person)


def deactivate(person: Person) -> dict:
    return _provisioner.deactivate(person)
