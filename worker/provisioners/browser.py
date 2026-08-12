#!/usr/bin/env python3
"""
Shared Playwright browser helper.

Same launch pattern as virtual-agent-lookup: a persistent context per portal so
a logged-in session (cookies) is remembered between runs. Each portal gets its
own profile subdirectory to keep sessions isolated.
"""
from __future__ import annotations

from contextlib import contextmanager

import config


@contextmanager
def portal_page(profile_name: str):
    """Yield a Playwright page backed by a persistent context for `profile_name`.

    Usage:
        with portal_page("propdata") as page:
            page.goto(...)
    Never called in dry-run - provisioners short-circuit before opening a browser.
    Playwright is imported lazily here so the whole worker (and its dry-run path)
    imports and runs even where playwright is not installed.
    """
    from playwright.sync_api import sync_playwright

    profile_dir = config.PROFILE_DIR / profile_name
    profile_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=config.HEADLESS,
            args=["--start-maximized"],
            no_viewport=True,
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            yield page
        finally:
            ctx.close()
