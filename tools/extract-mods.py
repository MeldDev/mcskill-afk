"""Extract literal id/version pairs from the official FML state report; no secrets.

Usage: python tools/extract-mods.py path/to/fml-log output.json
Does not infer versions from jar filenames or echo a server's ModList.
"""
import json
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors="replace")
mods = {}
for line in text.splitlines():
    match = re.match(r"^\s*U\w*\s+([^\s{}]+)\{([^{}]+)\}", line)
    if match:
        mods[match[1]] = match[2]
if not mods:
    raise SystemExit("No FML state report found. Do not guess mod versions.")
Path(sys.argv[2]).write_text(json.dumps([{"modid": k, "version": v} for k, v in mods.items()], indent=2) + "\n", encoding="utf-8")
print(f"Extracted {len(mods)} observed mod identifiers; review against the current installed pack.")
