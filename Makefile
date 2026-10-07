# Quay 1 Boarding Tool - task runner.
#
# One entry point for the offline test suite documented in docs/TEST-REPORT.md.
# Everything here is offline and side-effect free: no live Google/Supabase/portal
# calls, DRY_RUN defaults on, the python harness installs a hard socket guard.
# CI (.github/workflows/tests.yml) calls these same targets so local == CI.
#
#   make test    - the correctness gate: syntax + the 3 authoritative harnesses
#   make check   - test + the advisory seam heuristic (never fails the build)
#   make syntax  - node --check + py_compile only
#   make seam    - static seam heuristic alone (advisory; see note below)
#   make deploy-web / make deploy-apps-script - manual, user-run deploy reminders

SHELL := /bin/bash
.DEFAULT_GOAL := test

APPS_JS   := $(wildcard apps-script/*.js)
WEB_JS    := $(wildcard web/*.js)
WORKER_PY := worker/poll.py worker/config.py worker/sheets.py worker/log_setup.py $(wildcard worker/provisioners/*.py)

.PHONY: test check syntax harness seam deploy-web deploy-apps-script help

## test: syntax + the three authoritative harnesses (this is the merge gate)
test: syntax harness
	@echo "== TEST SUITE GREEN =="

## check: test plus the advisory seam heuristic
check: test seam

## syntax: node --check every JS + py_compile every worker module
syntax:
	@for f in $(APPS_JS) $(WEB_JS); do node --check "$$f" || exit 1; done
	@python3 -m py_compile $(WORKER_PY)
	@echo "syntax OK (js + py)"

## harness: the real offline behavioural gates (all must exit 0)
harness:
	node    tests/node_harness.js   # backend + queue-column cross-check + offboarding lifecycle
	python3 tests/py_harness.py     # worker dry-run + column cross-check + network guard
	node    tests/e2e_doPost.js     # AUTHORITATIVE seam gate: real doPost vs CONTRACTS

## seam: static grep heuristic - ADVISORY only. It can lag a normalize-shim, so
## e2e_doPost.js above is the source of truth when they disagree (docs/TEST-REPORT.md).
## Non-fatal on purpose (leading '-') so an advisory drift never blocks a merge.
seam:
	-node tests/seam_check.js

## deploy-web: reminder - GitHub Actions (pages.yml) auto-deploys web/ on push to main
deploy-web:
	@echo "web/ deploys automatically via .github/workflows/pages.yml on push to main."

## deploy-apps-script: reminder - manual, user-run (never automated from this repo)
deploy-apps-script:
	@echo "Manual: cd apps-script && clasp push && clasp deploy --description \"...\"  (see README.md)"

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'
