"""SQLite log of every application Filla helps submit."""

from __future__ import annotations

import sqlite3
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


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute(SCHEMA)
    return conn


def log_application(conn, app_id, job, track, pdf_path):
    conn.execute(
        """INSERT OR REPLACE INTO applications (id, company, title, url, ats, track, pdf_path)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (app_id, job.get("company"), job.get("title"), job.get("url"),
         job.get("ats"), track, str(pdf_path)),
    )
    conn.commit()


def set_status(conn, app_id, status):
    conn.execute("UPDATE applications SET status = ? WHERE id = ?", (status, app_id))
    conn.commit()


def list_applications(conn, limit=200):
    rows = conn.execute(
        "SELECT * FROM applications ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]
