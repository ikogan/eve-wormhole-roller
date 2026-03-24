#!/usr/bin/env python3
"""Update wormhole type data from the EVE Online Static Data Export (SDE).

Downloads the SDE ZIP only if the upstream ETag has changed. Extracts
wormhole types (group 988) from fsd/typeIDs.yaml and writes:
  data/wormhole-types.json  — name→typeID mapping committed to repo
  data/sde-metadata.json    — ETag + SHA256 committed to repo

The SDE ZIP itself is NOT committed (add to .gitignore if needed).

Usage:
  python3 scripts/update-sde.py [--force]

Options:
  --force   Download even if ETag matches
"""
import sys
import json
import hashlib
import io
import zipfile
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

SDE_URL = "https://developers.eveonline.com/static-data/eve-online-static-data-latest-yaml.zip"
DATA_DIR = Path(__file__).parent.parent / "data"
WORMHOLE_TYPES_FILE = DATA_DIR / "wormhole-types.json"
METADATA_FILE = DATA_DIR / "sde-metadata.json"
WORMHOLE_GROUP_ID = 988

# Dogma attribute IDs (used to verify data - not extracted here, fetched at runtime via ESI)
ATTR_MAX_STABLE_MASS = 1383
ATTR_MAX_JUMP_MASS = 1385


def load_metadata():
    if METADATA_FILE.exists():
        with open(METADATA_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_metadata(meta):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(METADATA_FILE, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")


def get_remote_etag():
    """Do a HEAD request to get the current ETag without downloading."""
    req = urllib.request.Request(SDE_URL, method="HEAD")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.headers.get("ETag", "").strip('"')
    except urllib.error.URLError as e:
        print(f"ERROR: Could not reach SDE server: {e}")
        return None


def download_sde(dest_path):
    """Download SDE ZIP to dest_path, printing progress."""
    print(f"Downloading SDE from {SDE_URL} ...")
    req = urllib.request.Request(SDE_URL)
    with urllib.request.urlopen(req) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        sha = hashlib.sha256()
        etag = resp.headers.get("ETag", "").strip('"')
        with open(dest_path, "wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)  # 1 MB chunks
                if not chunk:
                    break
                f.write(chunk)
                sha.update(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded / total * 100
                    print(f"  {downloaded:,} / {total:,} bytes ({pct:.1f}%)", end="\r", flush=True)
    print(f"\n  Downloaded {downloaded:,} bytes")
    return etag, sha.hexdigest()


def parse_wormhole_types(zip_path):
    """Open the SDE ZIP and extract wormhole types from fsd/typeIDs.yaml."""
    try:
        import yaml
    except ImportError:
        print("ERROR: PyYAML not installed. Run: pip install pyyaml")
        sys.exit(1)

    print("Opening SDE ZIP...")
    with zipfile.ZipFile(zip_path) as zf:
        # Find the typeIDs.yaml file (path may vary by SDE version)
        candidates = [n for n in zf.namelist() if n.endswith("typeIDs.yaml")]
        if not candidates:
            print("ERROR: Could not find typeIDs.yaml in SDE ZIP")
            print("Available files (first 20):", zf.namelist()[:20])
            sys.exit(1)

        type_ids_path = candidates[0]
        print(f"  Reading {type_ids_path} ({zf.getinfo(type_ids_path).file_size:,} bytes uncompressed)...")

        with zf.open(type_ids_path) as f:
            print("  Parsing YAML (this may take a moment)...")
            all_types = yaml.safe_load(f)

    print(f"  Loaded {len(all_types):,} types total")

    # Filter wormhole types (groupID 988)
    wh_types = []
    for type_id, type_data in all_types.items():
        if type_data.get("groupID") != WORMHOLE_GROUP_ID:
            continue
        name_data = type_data.get("name", {})
        # name may be dict with language keys, or a string
        if isinstance(name_data, dict):
            full_name = name_data.get("en", "")
        else:
            full_name = str(name_data)

        # Strip "Wormhole " prefix to get short designation (e.g. "Z971")
        short = full_name.replace("Wormhole ", "").strip()
        if short:
            wh_types.append({"name": short, "typeId": int(type_id)})

    print(f"  Found {len(wh_types)} wormhole types in group {WORMHOLE_GROUP_ID}")
    return sorted(wh_types, key=lambda x: x["name"])


def write_wormhole_types(wh_types):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(WORMHOLE_TYPES_FILE, "w", encoding="utf-8") as f:
        json.dump(wh_types, f, indent=2)
        f.write("\n")
    print(f"Wrote {WORMHOLE_TYPES_FILE} ({len(wh_types)} types)")


def main():
    force = "--force" in sys.argv

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    meta = load_metadata()
    stored_etag = meta.get("etag")

    print("Checking SDE ETag...")
    remote_etag = get_remote_etag()
    if remote_etag is None:
        sys.exit(1)

    print(f"  Remote ETag: {remote_etag}")
    print(f"  Stored ETag: {stored_etag or '(none)'}")

    if remote_etag == stored_etag and not force:
        print("SDE is up to date. Use --force to re-download.")
        return

    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        etag, sha256 = download_sde(tmp_path)
        wh_types = parse_wormhole_types(tmp_path)
        write_wormhole_types(wh_types)

        new_meta = {
            "etag": etag or remote_etag,
            "sha256": sha256,
            "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wormholeCount": len(wh_types),
            "source": "sde-download",
        }
        save_metadata(new_meta)
        print(f"Updated {METADATA_FILE}")
        print("Done!")
    finally:
        tmp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
