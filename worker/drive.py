"""
drive.py - minimal read-only Google Drive download for the worker.

Uses the SAME service-account key as the sheet client (config.GOOGLE_KEY_PATH) to
fetch a candidate's FICA headshot by Drive file id, so photo_pipeline.py can build
the branded profile photo. The apps-script side shares each headshot with this service
account at enqueue time (see _sharePhotoWithWorker_), so the SA can read it.

Imported lazily by the PropData provisioner; only full-status agents ever call it.
"""
from __future__ import annotations

import pathlib

import config

_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def download_file(file_id: str, dest_path: str, key_path: str | None = None) -> str:
    """Download the Drive file `file_id` to `dest_path` and return that path.

    Raises on any failure (missing key, no access, unknown id) so the caller can
    fall back to the default photo rather than silently shipping a blank picture.
    """
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    key = key_path or config.GOOGLE_KEY_PATH
    creds = service_account.Credentials.from_service_account_file(key, scopes=_SCOPES)
    svc = build("drive", "v3", credentials=creds, cache_discovery=False)
    data = svc.files().get_media(fileId=file_id).execute()   # returns bytes
    dest = pathlib.Path(dest_path)
    dest.write_bytes(data)
    return str(dest)
