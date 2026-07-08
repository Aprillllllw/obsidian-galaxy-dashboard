#!/usr/bin/env python3
"""Scan an Obsidian vault and generate data.js for Knowledge Galaxy.

Usage:
    python scripts/update_dashboard.py --vault "/path/to/your/Vault"
    python scripts/update_dashboard.py --vault "/path/to/Vault" --root "PARA"

Options:
    --vault   Absolute path to your Obsidian vault (the folder that contains
              your .md files / the .obsidian directory).
    --root    Optional sub-folder inside the vault to treat as the galaxy root.
              Omit to scan the vault top level. Example: --root "PARA"
    --name    Vault name used for obsidian:// links (defaults to the vault
              folder name). Must match the name Obsidian shows in its sidebar.
    --min     Min .md files for a folder to appear as a planet (default 2).
              Folders below this are hidden so the galaxy stays uncluttered.
    --out     Output path for data.js (default: ./data.js next to index.html).

Privacy note: data.js contains your real note titles and paths. It is listed
in .gitignore so you never commit it by accident. The repo ships data.demo.js
instead, and index.html loads your data.js on top of it when present.
"""
import argparse
import json
from pathlib import Path
from datetime import datetime, date

RECENT_N = 8
SUB_RECENT_N = 5


def md_files(d: Path, root: Path):
    return [p for p in d.rglob("*.md")
            if not any(part.startswith(".") for part in p.relative_to(root).parts)]


def note_info(p: Path, vault: Path):
    return {"title": p.stem, "path": str(p.relative_to(vault)), "mtime": int(p.stat().st_mtime)}


def recent(files, n, vault):
    ordered = sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[:n]
    return [note_info(p, vault) for p in ordered]


def main():
    ap = argparse.ArgumentParser(description="Generate data.js from an Obsidian vault.")
    ap.add_argument("--vault", required=True, help="Absolute path to your Obsidian vault.")
    ap.add_argument("--root", default="", help="Optional sub-folder to use as galaxy root.")
    ap.add_argument("--name", default="", help="Vault name for obsidian:// links.")
    ap.add_argument("--min", type=int, default=2, help="Min notes for a folder to show.")
    ap.add_argument("--out", default="", help="Output path for data.js.")
    args = ap.parse_args()

    vault = Path(args.vault).expanduser().resolve()
    if not vault.is_dir():
        raise SystemExit(f"Vault not found: {vault}")
    root = (vault / args.root) if args.root else vault
    if not root.is_dir():
        raise SystemExit(f"Root folder not found: {root}")
    vault_name = args.name or vault.name
    out = Path(args.out) if args.out else Path(__file__).resolve().parent.parent / "data.js"

    folders, all_files = [], []
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        files = md_files(d, root)
        if len(files) < args.min:
            continue
        all_files += files
        subs = []
        for s in sorted(d.iterdir()):
            if s.is_dir() and not s.name.startswith("."):
                sf = md_files(s, root)
                subs.append({"name": s.name, "notes": len(sf),
                             "recent": recent(sf, SUB_RECENT_N, vault)})
        folders.append({"name": d.name, "notes": len(files), "subs": subs,
                        "recent": recent(files, RECENT_N, vault)})

    if not folders:
        raise SystemExit(f"No folders with >= {args.min} notes under {root}. "
                         "Try a lower --min or a different --root.")

    today = date.today()
    today_count = sum(1 for p in all_files if date.fromtimestamp(p.stat().st_mtime) == today)
    data = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "vault": vault_name,
        "totalNotes": len(all_files),
        "todayUpdated": today_count,
        "recentAll": recent(all_files, 6, vault),
        "folders": folders,
    }
    out.write_text("window.GALAXY_DATA = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n",
                   encoding="utf-8")
    print(f"OK -> {out}  ({len(folders)} planets, {len(all_files)} notes, "
          f"{today_count} updated today)")


if __name__ == "__main__":
    main()
