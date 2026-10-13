# World Population Distribution

An interactive 3D globe of population density for the whole world. Zooming in, the globe turns into a flat map (or stays a globe, if you prefer) and the camera tilts so the spikes stay visible from the side. Beyond the finest level (~0.7 km² hexagons) the spikes shrink on screen (set with `MAX_HEX_PX` in `web/app.js`), so streets and neighbourhoods stay visible. Borders and major roads are drawn with extra contrast just below the columns; place names sit on top.

- **Data:** [Kontur Population](https://data.humdata.org/dataset/kontur-population-dataset), refreshed automatically when Kontur publishes a new release. The 2023-11-01 release has 33 million H3 hexagons (resolution 8, ~400 m), 8.03 billion people in total. Licence CC BY 4.0.
- **Countries:** Natural Earth 1:50m (public domain). Search uses [Photon](https://photon.komoot.io) (OpenStreetMap).
- **Basemap:** CARTO Dark Matter.
- **Stack:** MapLibre GL 5 (globe ↔ flat) with deck.gl 9 interleaved into it, which draws the hexagonal columns. There's no build step: everything is static.

## Layout

```
web/                 the site (static, host as-is)
  tiles/<variant>/{z}/{x}/{y}.bin  Float32 [lng, lat, population, people/km²] per hexagon;
                                   variant = fewest / few / medium / many / most ("Number of spikes")
  tiles/meta.json        dataset version; per variant zoom→H3 resolution and tile index;
                         statistics per resolution
  data/countries.json    country list
  vendor/                MapLibre and deck.gl (local, no CDN needed)
scripts/
  build_tiles.py         Kontur GeoPackage → tiles
  build_countries.py     Natural Earth → countries.json
  update_data.py         checks HDX for a new Kontur release and rebuilds everything (cron)
deploy/
  deploy.sh              publishes the site code to the web root
  update-data.sh         cron wrapper around update_data.py (venv, nice, log file)
  popmap-update.cron     cron schedule, for /etc/cron.d
  nginx-popmap.conf      nginx site config
```

**Generated data is not in git.** `web/tiles/`, `web/data/countries.json` and the Kontur
downloads are ignored (the tiles alone are ~2.6 GB). You build them yourself with the
scripts below; on a server a cron job keeps them up to date.

## Requirements

- A Unix-like system (Linux, macOS) for the data scripts
- Python 3.10+ with the packages in `requirements.txt`
- ~15 GB free disk and ~4 GB RAM while building the data
- For a server: any web server that can serve static files, and cron

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# download the newest Kontur release (2.4 GB) and build tiles + country list
.venv/bin/python scripts/update_data.py --web-dir web --work-dir work

# serve the site
python3 -m http.server 8000 --directory web
```

Then open http://localhost:8000. Run the `update_data.py` line again at any time to
pick up a new release. Add `--keep-download` to keep the 2.4 GB source file in `work/`.

To build from a GeoPackage you already have:

```bash
.venv/bin/python scripts/build_tiles.py --gpkg path/to/kontur_population_YYYYMMDD.gpkg --out web
.venv/bin/python scripts/build_countries.py --out web/data/countries.json
```

Which H3 resolution belongs to which zoom level is set by `ZOOM_RES` in `scripts/build_tiles.py`. `VARIANTS` sets how many resolution steps coarser (or finer) each variant is. Thickness and height per variant are in `SPIKES` in `web/app.js`; the colour palettes are in `PALETTES`.

## Run on a server

The paths below are examples; use whatever fits your setup.

| path | what |
| --- | --- |
| `/opt/popmap` | checkout of this repository, with a venv in `.venv/` |
| `/var/www/popmap` | web root: site code + generated `tiles/` and `data/` |
| `/var/lib/popmap` | downloads, lock file and `update.log` |

1. Get the code and install the dependencies:
   ```bash
   git clone <repo-url> /opt/popmap
   cd /opt/popmap
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   ```
2. Copy the site code to the web root and build the data once:
   ```bash
   ./deploy/deploy.sh /var/www/popmap
   ./deploy/update-data.sh
   ```
3. Schedule the data updates with cron, weekly or monthly. Either install
   `deploy/popmap-update.cron` in `/etc/cron.d/` (set the user and path in it), or add
   this to a crontab:
   ```
   17 4 * * 1  /opt/popmap/deploy/update-data.sh > /dev/null
   ```
4. Point your web server at `/var/www/popmap`. `deploy/nginx-popmap.conf` is an example
   config for nginx; with any other server, serve `meta.json` and `countries.json` with
   `Cache-Control: no-cache`. Use HTTPS for public access.

The user running the scripts needs write access to the web root and the work dir.
Paths can be changed with `POPMAP_WEB_DIR`, `POPMAP_WORK_DIR`, `POPMAP_VENV` and
`POPMAP_LOG` (environment variables or `/etc/default/popmap`).

**Code updates:** `git pull && ./deploy/deploy.sh /var/www/popmap`. This leaves the
generated data alone. From another machine: `./deploy/deploy.sh user@server [/path/to/webroot]`.

### How the data updates work

`update_data.py` asks the [HDX API](https://data.humdata.org/dataset/kontur-population-dataset)
for the newest `kontur_population_YYYYMMDD.gpkg.gz` and compares it with `version` in
`tiles/meta.json`. Kontur releases about once a year, so most runs only make that one
API call and refresh `countries.json`. When there is a new release it:

1. downloads it to the work dir (resumes if interrupted),
2. builds the tiles into `<web root>/tiles-<version>/`,
3. switches the `tiles` symlink to the new folder atomically and deletes the old one.

The live site is never touched by a run that fails halfway. Tile URLs carry
`?v=<version>`, so visitors get the new data straight away even if tiles are cached.

```bash
./deploy/update-data.sh --check   # exit code 10 = update available
./deploy/update-data.sh --force   # rebuild anyway
```

### Notes for public use

- **CARTO basemap:** free for non-commercial use with attribution. For heavy traffic or commercial use, switch to your own map style (e.g. OpenFreeMap or self-hosted PMTiles) by changing `BASEMAP` in `web/app.js`.
- **Photon search:** a free public service with a fair-use policy. With many visitors, host it yourself.
- **Attribution:** the Kontur source is shown bottom right; OSM and CARTO are in the map's attribution. Keep them.
