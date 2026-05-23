"""
Logging setup for the chatbot service.

Writes structured logs to /data/chatbot.log (rotating, 10 MB × 5 files).
Falls back to /tmp/chatbot.log when /data is not available.
All chatbot modules import _log = logging.getLogger(__name__) — no other
config needed after calling configure_logging() at startup.
"""
import logging
import logging.handlers
import os


def configure_logging() -> None:
    log_dir = "/data" if os.path.isdir("/data") else "/tmp"
    log_path = os.path.join(log_dir, "chatbot.log")

    root = logging.getLogger()
    if root.handlers:
        return  # already configured (e.g. running under pytest)

    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)-8s %(name)-28s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    # Rotating file — keeps last 50 MB across 5 files
    file_handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(logging.DEBUG)

    # Console — INFO+ only so uvicorn output stays readable
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    console_handler.setLevel(logging.INFO)

    root.setLevel(logging.DEBUG)
    root.addHandler(file_handler)
    root.addHandler(console_handler)

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    logging.getLogger(__name__).info("Logging initialised — writing to %s", log_path)
