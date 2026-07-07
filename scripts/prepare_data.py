"""Converts summer_game_2026_raw.json (AADL Summer Game map API dump) into
compact GeoJSON files consumed by the web app in app/public/data/ (Vite
copies them into docs/data/ at build time).

Usage: python3 scripts/prepare_data.py

To refresh data: re-download https://aadl.org/summergame/map/data/SummerGame2026
(requires a logged-in AADL session) to summer_game_2026_raw.json, then rerun.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "app" / "public" / "data"

# Michigan-area sanity bbox; drops the handful of corrupt-coordinate records.
BBOX = {"lat_min": 41.5, "lat_max": 43.5, "lon_min": -85.0, "lon_max": -83.0}


def parse_coords(rec):
    try:
        lat = float(rec.get("lat"))
        lon = float(rec.get("lon"))
    except (TypeError, ValueError):
        return None
    if not (BBOX["lat_min"] <= lat <= BBOX["lat_max"] and BBOX["lon_min"] <= lon <= BBOX["lon_max"]):
        return None
    return [round(lon, 6), round(lat, 6)]


def strip_html(s):
    s = re.sub(r"<[^>]*>", " ", str(s or ""))
    s = s.replace("&amp;", "&").replace("&#039;", "'").replace("&#39;", "'").replace("&quot;", '"')
    return re.sub(r"\s+", " ", s).strip()


def parse_address(html):
    """Addresses arrive as "200 Brookside Dr<br>Ann Arbor, MI<br>48105".
    A few records put a building name on line 1 and the street on line 2."""
    lines = [strip_html(l) for l in re.split(r"<br\s*/?>", str(html or ""), flags=re.I)]
    lines = [l for l in lines if l]
    addr = lines[0] if lines else ""
    rest = lines[1:]
    if addr and not addr[0].isdigit() and rest and rest[0][:1].isdigit():
        addr = f"{rest[0]} ({addr})"
        rest = rest[1:]
    city_line = next((l for l in rest if re.search(r",\s*MI", l, re.I)), rest[0] if rest else "")
    city = re.sub(r",?\s*MI.*$", "", city_line, flags=re.I).strip()
    zip_line = next((l for l in rest if re.fullmatch(r"\d{5}(-\d{4})?", l)), "")
    return addr, city, zip_line


def feature(fid, coords, properties):
    try:
        fid = int(fid)
    except (TypeError, ValueError):
        fid = str(fid)  # the app keys feature-state off properties.id via promoteId
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": coords},
        "properties": properties,
    }


def main():
    raw = json.loads((ROOT / "summer_game_2026_raw.json").read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def write(name, features):
        fc = {"type": "FeatureCollection", "generated": generated, "features": features}
        (OUT_DIR / name).write_text(json.dumps(fc, separators=(",", ":")))

    # Home lawn signs
    signs, dropped = [], 0
    for rec in raw.get("homecodes", []):
        coords = parse_coords(rec)
        if not coords or int(rec.get("display", 0)) != 1:
            dropped += 1
            continue
        addr, city, zip_ = parse_address(rec.get("homecode"))
        signs.append(
            feature(rec["code_id"], coords, {
                "id": str(rec["code_id"]),
                "addr": addr,
                "city": city,
                "zip": zip_,
                "reds": int(rec.get("num_redemptions") or 0),
            })
        )
    write("signs.json", signs)

    # Business codes
    biz, biz_dropped = [], 0
    for rec in raw.get("bizcodes", []):
        coords = parse_coords(rec)
        if not coords:
            biz_dropped += 1
            continue
        addr, city, zip_ = parse_address(rec.get("bizcode"))
        biz.append(
            feature(rec["code_id"], coords, {
                "id": f"biz-{rec['code_id']}",
                "addr": addr,
                "city": city,
                "zip": zip_,
                "reds": int(rec.get("num_redemptions") or 0),
            })
        )
    write("biz.json", biz)

    # Badges (popup HTML + image path, no code_id)
    badges, badge_dropped = [], 0
    for i, rec in enumerate(raw.get("badges", []), start=1):
        coords = parse_coords(rec)
        if not coords:
            badge_dropped += 1
            continue
        badges.append(
            feature(i, coords, {
                "id": f"badge-{i}",
                "label": strip_html(rec.get("popup")),
                "image": rec.get("image") or "",
            })
        )
    write("badges.json", badges)

    print(f"signs.json:  {len(signs)} kept, {dropped} dropped (of {len(raw.get('homecodes', []))})")
    print(f"biz.json:    {len(biz)} kept, {biz_dropped} dropped (of {len(raw.get('bizcodes', []))})")
    print(f"badges.json: {len(badges)} kept, {badge_dropped} dropped (of {len(raw.get('badges', []))})")
    print(f"generated:   {generated}")


if __name__ == "__main__":
    main()
