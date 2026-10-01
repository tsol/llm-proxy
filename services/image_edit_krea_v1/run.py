#!/usr/bin/env python3
"""Exec wrapper for videogen/edit_image.sh krea."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from edit_common import run_edit

if __name__ == "__main__":
    sys.exit(run_edit("krea"))
