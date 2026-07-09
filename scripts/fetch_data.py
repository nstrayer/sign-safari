"""Downloads the AADL Summer Game map data feed to summer_game_2026_raw.json.

Usage: python3 scripts/fetch_data.py

The endpoint is public (no AADL login required). After fetching, run
scripts/prepare_data.py and scripts/build_network.py to refresh the app data.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "summer_game_2026_raw.json"
URL = "https://aadl.org/summergame/map/data/SummerGame2026"
EXPECTED_KEYS = frozenset({"homecodes", "bizcodes", "badges"})


def main() -> None:
    req = urllib.request.Request(
        URL,
        headers={"User-Agent": "sign-safari-data-refresh/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read()
            status = resp.status
    except urllib.error.HTTPError as err:
        print(f"fetch failed: HTTP {err.code} {err.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as err:
        print(f"fetch failed: {err.reason}", file=sys.stderr)
        sys.exit(1)

    if status != 200:
        print(f"fetch failed: HTTP {status}", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(body)
    except json.JSONDecodeError as err:
        print(f"fetch failed: invalid JSON ({err})", file=sys.stderr)
        sys.exit(1)

    if not isinstance(data, dict) or not EXPECTED_KEYS.issubset(data.keys()):
        missing = EXPECTED_KEYS - set(data.keys()) if isinstance(data, dict) else EXPECTED_KEYS
        print(f"fetch failed: unexpected response (missing keys: {sorted(missing)})", file=sys.stderr)
        sys.exit(1)

    OUT.write_bytes(body)
    counts = {key: len(data[key]) for key in sorted(EXPECTED_KEYS)}
    print(f"wrote {OUT.relative_to(ROOT)} ({len(body)} bytes)")
    for key, count in counts.items():
        print(f"  {key}: {count}")


if __name__ == "__main__":
    main()
