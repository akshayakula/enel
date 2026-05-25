"""Structured logging shared across the package.

We log to both stderr (for humans) and a JSONL file inside the workspace
(for the Node server to tail and surface in the dashboard).
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path
from typing import Any, Optional


_JSONL_PATH: Optional[Path] = None


class _JsonlHandler(logging.Handler):
    def __init__(self, path: Path) -> None:
        super().__init__()
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = path.open("a", buffering=1)  # line-buffered

    def emit(self, record: logging.LogRecord) -> None:
        payload: dict[str, Any] = {
            "ts": time.time(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if extra := getattr(record, "structured", None):
            payload.update(extra)
        if record.exc_info:
            payload["exc"] = self.format(record)
        self._fh.write(json.dumps(payload) + "\n")


def setup(workspace: Optional[Path] = None, level: int = logging.INFO) -> Path | None:
    global _JSONL_PATH
    root = logging.getLogger()
    root.setLevel(level)
    # Reset handlers so re-runs in the same process don't double-log.
    root.handlers.clear()

    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-5s %(name)s | %(message)s")
    )
    root.addHandler(stream)

    if workspace is not None:
        _JSONL_PATH = workspace / "events.jsonl"
        root.addHandler(_JsonlHandler(_JSONL_PATH))

    return _JSONL_PATH


def event(msg: str, **fields: Any) -> None:
    """Log a structured event. Fields are attached as JSON in the JSONL stream."""
    logging.getLogger("splat.event").info(msg, extra={"structured": fields})
