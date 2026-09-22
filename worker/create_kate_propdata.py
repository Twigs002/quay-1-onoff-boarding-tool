#!/usr/bin/env python3
"""
One-off PropData (PDMS) create for Kate Ashley Talbot.

Follows the smoke_propdata.py safety pattern:

  * REFUSES the live create unless you pass --yes-create-real-user;
  * runs HEADED by default so you watch every field go in (pass --headless to hide);
  * calls _create_live directly for this ONE record, so it does not touch the
    sheet bus and does not read or change the global DRY_RUN switch;
  * --dry opens no browser and just prints the intended field values.

Usage (from the worker/ directory):
    ./.venv/bin/python create_kate_propdata.py --dry
    ./.venv/bin/python create_kate_propdata.py --yes-create-real-user

PropData create is NOT idempotent. If this raises after the Save, check PDMS
(Users -> search "Talbot") BEFORE re-running, or you will create a duplicate
agent that has to be set to Inactive by hand.
"""
from __future__ import annotations

import argparse
import os
import sys

import config
from provisioners import propdata
from provisioners.base import Person

PHOTO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "assets", "kate-talbot-profile.png")


def _person() -> Person:
    return Person(
        full_name="Kate Ashley Talbot",
        first_name="Kate",
        quay_email="kate@quay1.co.za",
        cell="082 817 7768",
        payload={
            "last_name": "Ashley Talbot",
            "ffc_status": "full",          # full FFC, non-principal
            "role": "agent",               # -> Designation "Non-Principal Property Practitioner"
            "photo_path": PHOTO,           # already branded, so no rembg/composite build
        },
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="PropData create for Kate Ashley Talbot")
    ap.add_argument("--yes-create-real-user", action="store_true",
                    help="actually create the PDMS profile on the live portal")
    ap.add_argument("--dry", action="store_true",
                    help="print the intended field values only; opens no browser")
    ap.add_argument("--headless", action="store_true",
                    help="run without a visible window (default is headed so you can watch)")
    args = ap.parse_args()

    if not os.path.exists(PHOTO):
        print("ERROR: profile photo missing at %s" % PHOTO, file=sys.stderr)
        return 2

    person = _person()
    prov = propdata._provisioner

    if args.dry or not args.yes_create_real_user:
        if not args.dry:
            print("Refusing to create a real PDMS user without --yes-create-real-user.\n"
                  "Showing the dry-run plan instead:\n")
        print("\nDRY plan result:", prov._create_dry(person))
        return 0

    if not config.PORTAL_ACCOUNTS["propdata"]["user"]:
        print("ERROR: PROPDATA_ADMIN_USER is not set (worker/.env). Cannot log in.", file=sys.stderr)
        return 2

    config.HEADLESS = args.headless
    print("Creating LIVE PDMS profile: %s (%s)" % (person.full_name, person.quay_email))
    print("  Designation : Non-Principal Property Practitioner")
    print("  Branch      : %s" % config.PROPDATA_BRANCH)
    print("  Cell        : +27 (ZA) %s" % person.cell)
    print("  Photo       : %s" % PHOTO)
    print("  Headless    : %s\n" % config.HEADLESS)

    res = prov._create_live(person)
    print("\nLIVE create result:", res)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
