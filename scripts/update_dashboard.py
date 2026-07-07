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
import re
from pathlib import Path
from datetime import datetime, date, timedelta

RECENT_N = 8
SUB_RECENT_N = 5
TASK_N = 5          # how many open tasks to surface on the dashboard
TREND_DAYS = 14     # daily "notes created" sparkline window

WIKI_LINK_RE = re.compile(r"\[\[([^\]\|#\n]+)")
TAG_RE = re.compile(r"(?<![\w#])#([A-Za-z0-9_/\-一-鿿][\w/\-一-鿿]*)")
TASK_RE = re.compile(r"^\s*-\s\[\s\]\s+(.+)$")


def md_files(d: Path, root: Path):
    return [p for p in d.rglob("*.md")
            if not any(part.startswith(".") for part in p.relative_to(root).parts)]


def note_info(p: Path, vault: Path):
    return {"title": p.stem, "path": str(p.relative_to(vault)), "mtime": int(p.stat().st_mtime)}


def recent(files, n, vault):
    ordered = sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[:n]
    return [note_info(p, vault) for p in ordered]


def ctime_of(p: Path) -> float:
    """Creation time: macOS gives st_birthtime, elsewhere fall back to st_mtime."""
    st = p.stat()
    return getattr(st, "st_birthtime", st.st_mtime)


def read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def link_stats(all_files):
    """Approximate Obsidian's resolvedLinks with a wiki-link regex.

    links   = total number of [[wiki links]] that resolve to a note in the vault
    orphans = .md files with zero outgoing links AND never referenced by others
    """
    stems = {}
    for p in all_files:
        stems.setdefault(p.stem.lower(), []).append(p)
    total_links = 0
    outgoing = {}          # path -> resolved outgoing count
    referenced = set()     # lowercase stems that appear as a link target
    for p in all_files:
        out = 0
        for m in WIKI_LINK_RE.finditer(read_text(p)):
            target = m.group(1).strip().split("/")[-1].strip().lower()
            if target and target in stems:
                out += 1
                referenced.add(target)
        outgoing[p] = out
        total_links += out
    orphans = sum(1 for p in all_files
                  if outgoing[p] == 0 and p.stem.lower() not in referenced)
    return total_links, orphans


def collect_tasks(all_files):
    """Open '- [ ]' items from .md files modified in the last 7 days (first TASK_N)."""
    cutoff = datetime.now().timestamp() - 7 * 86400
    fresh = sorted((p for p in all_files if p.stat().st_mtime >= cutoff),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    tasks = []
    for p in fresh:
        for line in read_text(p).splitlines():
            m = TASK_RE.match(line)
            if m:
                tasks.append({"text": m.group(1).strip()[:80], "done": False})
                if len(tasks) >= TASK_N:
                    return tasks
    return tasks


def daily_streak(all_files) -> int:
    """Consecutive days (ending today, or yesterday if today is quiet) with edits."""
    days = {date.fromtimestamp(p.stat().st_mtime) for p in all_files}
    day = date.today()
    if day not in days:
        day -= timedelta(days=1)
    streak = 0
    while day in days:
        streak += 1
        day -= timedelta(days=1)
    return streak


def health_score(notes: int, links: int, orphans: int, streak: int) -> int:
    """0-100: 50% linked ratio, 30% link density (2 links/note = full), 20% streak."""
    if not notes:
        return 0
    linked_ratio = 1 - orphans / notes
    link_density = min(1.0, links / (notes * 2))
    activity = min(1.0, streak / 14)
    return round(100 * (0.5 * linked_ratio + 0.3 * link_density + 0.2 * activity))


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

    # ---- HUD extras: health / stats / streak / tasks ----
    links, orphans = link_stats(all_files)
    streak = daily_streak(all_files)

    trend = [0] * TREND_DAYS
    created_30d = 0
    for p in all_files:
        age = (today - date.fromtimestamp(ctime_of(p))).days
        if age < 30:
            created_30d += 1
        if 0 <= age < TREND_DAYS:
            trend[TREND_DAYS - 1 - age] += 1   # oldest -> newest

    tags = set()
    for p in all_files:
        tags.update(t.rstrip("/") for t in TAG_RE.findall(read_text(p)))

    folder_count = sum(1 for d in root.rglob("*")
                       if d.is_dir() and not any(part.startswith(".")
                                                 for part in d.relative_to(root).parts))
    attachments = sum(1 for f in root.rglob("*")
                      if f.is_file() and f.suffix.lower() != ".md"
                      and not any(part.startswith(".") for part in f.relative_to(root).parts))

    data = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "vault": vault_name,
        "totalNotes": len(all_files),
        "todayUpdated": today_count,
        "health": {
            "score": health_score(len(all_files), links, orphans, streak),
            "notes": len(all_files),
            "links": links,
            "orphans": orphans,
        },
        "streak": {"days": streak},
        "stats": {
            "files": len(all_files),
            "folders": folder_count,
            "tags": len(tags),
            "attachments": attachments,
            "created30d": created_30d,
            "trend": trend,
        },
        "tasks": collect_tasks(all_files),
        "recentAll": recent(all_files, 6, vault),
        "folders": folders,
    }
    out.write_text("window.GALAXY_DATA = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n",
                   encoding="utf-8")
    print(f"OK -> {out}  ({len(folders)} planets, {len(all_files)} notes, "
          f"{today_count} updated today)")


if __name__ == "__main__":
    main()
