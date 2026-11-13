"""SQLite log of every application Filla helps submit.

Connections are opened per operation because FastAPI runs sync endpoints in
a thread pool and SQLite connections cannot be shared across threads.
Opening a connection is cheap at this scale.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    company TEXT,
    title TEXT,
    url TEXT,
    ats TEXT,
    track TEXT,
    status TEXT DEFAULT 'tailored',
    pdf_path TEXT
);
"""


@contextmanager
def _conn(db_path: Path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def init(db_path: Path) -> None:
    with _conn(db_path):
        pass


def log_application(db_path: Path, app_id, job, track, pdf_path):
    with _conn(db_path) as conn:
        # One row per job: re-tailoring the same posting replaces the old
        # seen row. Submitted applications are history and are never touched.
        url = job.get("url")
        if url:
            conn.execute(
                "DELETE FROM applications WHERE url = ? AND status != 'applied'",
                (url,),
            )
        conn.execute(
            """INSERT OR REPLACE INTO applications (id, company, title, url, ats, track, pdf_path)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (app_id, job.get("company"), job.get("title"), job.get("url"),
             job.get("ats"), track, str(pdf_path)),
        )


def set_status(db_path: Path, app_id, status):
    with _conn(db_path) as conn:
        conn.execute("UPDATE applications SET status = ? WHERE id = ?", (status, app_id))


def list_applications(db_path: Path, limit=200):
    with _conn(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM applications ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]
