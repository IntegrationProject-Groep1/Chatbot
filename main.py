import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from api import app  # noqa: F401 — uvicorn entry point
