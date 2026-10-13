"""
Keeps the population data on the server up to date. Meant to run from cron.

1. Asks HDX (data.humdata.org) for the newest global Kontur Population release.
2. If it is newer than the published tiles (or --force): downloads it (resumable),
   unpacks it, builds the tiles into <web-dir>/tiles-<version>/ and switches the
   <web-dir>/tiles symlink to it in one atomic step. Old tile folders are removed.
3. Refreshes <web-dir>/data/countries.json (Natural Earth) on every run.

Nothing that is live gets touched until a new build has finished, so a failed run
leaves the site as it was. Runs never overlap (lock file in the work dir).

When run as root, everything written to the web dir is given to --web-owner
(default www-data:www-data) before it goes live, so the web server never sees
root-owned files.

Disk: the work dir needs ~10 GB during a rebuild (2.4 GB download + 6.7 GB unpacked),
the web dir ~2.6 GB per tile set (two sets exist briefly during the switch).

Usage:
  python update_data.py --web-dir /var/www/popmap --work-dir /var/lib/popmap
  python update_data.py ... --check     # only report whether an update is available
  python update_data.py ... --force     # rebuild even if the version is unchanged
"""
import argparse
import fcntl
import glob
import grp
import gzip
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import time
import urllib.request

HDX_API = "https://data.humdata.org/api/3/action/package_show?id=kontur-population-dataset"
RELEASE_RE = re.compile(r"^kontur_population_(\d{8})\.gpkg\.gz$")
USER_AGENT = "popmap-updater/1.0 (+https://data.humdata.org/dataset/kontur-population-dataset)"
HERE = os.path.dirname(os.path.abspath(__file__))
CHUNK = 4 << 20


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def http_get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def latest_release():
    """Newest global release on HDX as (version, url, size); size is 0 if unknown."""
    with http_get(HDX_API) as r:
        resources = json.load(r)["result"]["resources"]
    found = []
    for res in resources:
        m = RELEASE_RE.match(res.get("name", ""))
        if m:
            found.append((m.group(1), res["url"], int(res.get("size") or 0)))
    if not found:
        raise RuntimeError("no kontur_population_YYYYMMDD.gpkg.gz resource found on HDX")
    return max(found)


def parse_owner(spec):
    """'user:group' -> (uid, gid), or None when not running as root (chown impossible)."""
    if os.geteuid() != 0 or not spec:
        return None
    user, _, group = spec.partition(":")
    return pwd.getpwnam(user).pw_uid, grp.getgrnam(group or user).gr_gid


def chown(path, owner, recursive=False):
    if not owner:
        return
    os.chown(path, *owner, follow_symlinks=False)
    if recursive and os.path.isdir(path) and not os.path.islink(path):
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                os.chown(os.path.join(root, name), *owner, follow_symlinks=False)


def published_version(web_dir):
    try:
        with open(os.path.join(web_dir, "tiles", "meta.json")) as f:
            return json.load(f).get("version")
    except (OSError, ValueError):
        return None


def download(url, dest, size):
    """Download with resume support; a finished file of the right size is reused."""
    part = dest + ".part"
    if os.path.exists(dest) and (not size or os.path.getsize(dest) == size):
        log(f"already downloaded: {dest}")
        return
    have = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    log(f"downloading {url}" + (f" (resuming at {have / 1e9:.2f} GB)" if have else ""))
    with http_get(url, headers, timeout=120) as r:
        if have and r.status != 206:  # server ignored the range: start over
            have = 0
        with open(part, "ab" if have else "wb") as f:
            done, next_report = have, have + 250e6
            while chunk := r.read(CHUNK):
                f.write(chunk)
                done += len(chunk)
                if done >= next_report:
                    log(f"  {done / 1e9:.2f}" + (f" / {size / 1e9:.2f}" if size else "") + " GB")
                    next_report += 250e6
    if size and os.path.getsize(part) != size:
        raise RuntimeError(f"download incomplete: {os.path.getsize(part)} of {size} bytes")
    os.replace(part, dest)


def gunzip(src, dest):
    log(f"unpacking to {dest}")
    tmp = dest + ".tmp"
    with gzip.open(src, "rb") as fi, open(tmp, "wb") as fo:
        shutil.copyfileobj(fi, fo, CHUNK)
    os.replace(tmp, dest)


def run(*cmd):
    log("running", " ".join(cmd))
    subprocess.run(cmd, check=True)


def switch_tiles(web_dir, new_dir, owner):
    """Point <web-dir>/tiles at new_dir (relative symlink, swapped atomically)."""
    link = os.path.join(web_dir, "tiles")
    if os.path.isdir(link) and not os.path.islink(link):
        # first run after a manual upload: move the plain folder aside once
        old = published_version(web_dir) or "old"
        aside = os.path.join(web_dir, f"tiles-{old}")
        if os.path.exists(aside):
            aside += f"-{int(time.time())}"
        os.rename(link, aside)
    tmp = link + ".new"
    if os.path.lexists(tmp):
        os.remove(tmp)
    os.symlink(os.path.basename(new_dir), tmp)
    chown(tmp, owner)
    os.replace(tmp, link)


def remove_old_tiles(web_dir, keep):
    for d in glob.glob(os.path.join(web_dir, "tiles-*")):
        if os.path.basename(d) != os.path.basename(keep) and os.path.isdir(d) and not os.path.islink(d):
            log(f"removing {d}")
            shutil.rmtree(d)


def update_tiles(args, version, url, size, owner):
    gz = os.path.join(args.work_dir, f"kontur_population_{version}.gpkg.gz")
    gpkg = gz[:-3]
    download(url, gz, size)
    gunzip(gz, gpkg)

    final = os.path.join(args.web_dir, f"tiles-{version}")
    building = final + ".building"
    shutil.rmtree(building, ignore_errors=True)
    run(sys.executable, os.path.join(HERE, "build_tiles.py"), "--gpkg", gpkg,
        "--out", args.web_dir, "--tiles-dir", building, "--version", version)
    with open(os.path.join(building, "meta.json")) as f:
        if not json.load(f).get("variants"):
            raise RuntimeError("build produced an empty meta.json")
    chown(building, owner, recursive=True)
    shutil.rmtree(final, ignore_errors=True)
    os.rename(building, final)

    switch_tiles(args.web_dir, final, owner)
    log(f"tiles now point to {final}")
    remove_old_tiles(args.web_dir, final)

    os.remove(gpkg)
    if not args.keep_download:
        os.remove(gz)
    for stale in glob.glob(os.path.join(args.work_dir, "kontur_population_*")):
        if version not in os.path.basename(stale):
            os.remove(stale)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--web-dir", default=os.environ.get("POPMAP_WEB_DIR", "/var/www/popmap"))
    ap.add_argument("--work-dir", default=os.environ.get("POPMAP_WORK_DIR", "/var/lib/popmap"))
    ap.add_argument("--force", action="store_true", help="rebuild even if the version is unchanged")
    ap.add_argument("--check", action="store_true", help="only report whether an update is available")
    ap.add_argument("--keep-download", action="store_true", help="keep the .gpkg.gz after a successful build")
    ap.add_argument("--skip-countries", action="store_true")
    ap.add_argument("--web-owner", default=os.environ.get("POPMAP_WEB_OWNER", "www-data:www-data"),
                    help="user:group for files in the web dir when running as root ('' = leave as is)")
    args = ap.parse_args()
    owner = parse_owner(args.web_owner)

    os.makedirs(args.work_dir, exist_ok=True)
    os.makedirs(os.path.join(args.web_dir, "data"), exist_ok=True)
    chown(args.web_dir, owner)
    chown(os.path.join(args.web_dir, "data"), owner)
    lock = open(os.path.join(args.work_dir, "update.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another update is still running, skipping")
        return 0

    version, url, size = latest_release()
    current = published_version(args.web_dir)
    log(f"published: {current or 'none'}, latest on HDX: {version}")
    if args.check:
        return 0 if current == version else 10

    if current != version or args.force:
        update_tiles(args, version, url, size, owner)
    else:
        log("tiles are up to date")

    if not args.skip_countries:
        countries = os.path.join(args.web_dir, "data", "countries.json")
        run(sys.executable, os.path.join(HERE, "build_countries.py"), "--out", countries + ".new")
        chown(countries + ".new", owner)
        os.replace(countries + ".new", countries)
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
