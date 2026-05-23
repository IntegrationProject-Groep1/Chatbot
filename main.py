import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import logging_config
logging_config.configure_logging()

from api import app  # noqa: F401 — uvicorn entry point
