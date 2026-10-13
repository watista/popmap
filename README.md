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
downloads (`data/`) are ignored: the tiles alone are ~2.6 GB. Build them locally (below),
and on the server they're built and kept up to date by a cron job.

## Run locally

Build the data first (next section), then:

```bash
wsl -e python3 -m http.server 8765 --directory /mnt/c/Users/Wouter/Documents/popmap/web
```

Then open http://localhost:8765.

## Build the data

The easiest way is the same updater the server uses. It downloads the newest Kontur
release (2.4 GB) and builds the tiles in about a minute. Use the WSL disk for the work
dir, because it's much faster than `/mnt/c`:

```bash
python3 -m venv ~/popmap-venv && ~/popmap-venv/bin/pip install -r requirements.txt
~/popmap-venv/bin/python scripts/update_data.py --web-dir web --work-dir ~/popmap-work --keep-download
```

Locally `web/tiles` then becomes a symlink to `web/tiles-<version>/`. To build by hand
from a GeoPackage you already have:

```bash
~/popmap-venv/bin/python scripts/build_tiles.py --gpkg ~/popmap-work/kontur_population_20231101.gpkg --out web
~/popmap-venv/bin/python scripts/build_countries.py --out web/data/countries.json
```

Which H3 resolution belongs to which zoom level is set by `ZOOM_RES` in `scripts/build_tiles.py`. `VARIANTS` sets how many resolution steps coarser (or finer) each variant is. Thickness and height per variant are in `SPIKES` in `web/app.js`; the colour palettes are in `PALETTES`.

## Deploy to the Ubuntu server

The server holds a git checkout (code + scripts) and a separate web root that nginx
serves. The cron job writes the data straight into the web root.

| path | what |
| --- | --- |
| `/opt/popmap` | git checkout, Python venv in `.venv/` |
| `/var/www/popmap` | web root: site code (from `deploy.sh`) + `tiles/` and `data/` (from cron) |
| `/var/lib/popmap` | downloads, lock file and `update.log` (~10 GB free needed during a rebuild) |

The tile build needs about 4 GB of RAM; ~15 GB of free disk in total covers a rebuild.

1. Install the packages and create a service user:
   ```bash
   sudo apt install git nginx certbot python3-certbot-nginx python3-venv rsync
   sudo useradd --system --home /var/lib/popmap --shell /usr/sbin/nologin popmap
   sudo mkdir -p /opt/popmap /var/www/popmap /var/lib/popmap
   sudo chown popmap: /opt/popmap /var/www/popmap /var/lib/popmap
   ```
2. Check out the code and install the Python dependencies:
   ```bash
   sudo -u popmap git clone <repo-url> /opt/popmap
   sudo -u popmap python3 -m venv /opt/popmap/.venv
   sudo -u popmap /opt/popmap/.venv/bin/pip install -r /opt/popmap/requirements.txt
   ```
3. Publish the site code and build the data for the first time (download + build, a few minutes):
   ```bash
   sudo -u popmap /opt/popmap/deploy/deploy.sh /var/www/popmap
   sudo -u popmap /opt/popmap/deploy/update-data.sh
   ```
4. Schedule the updates. The cron file runs weekly; edit it for monthly:
   ```bash
   sudo install -m 644 /opt/popmap/deploy/popmap-update.cron /etc/cron.d/popmap-update
   ```
5. Put `deploy/nginx-popmap.conf` in `/etc/nginx/sites-available/popmap`, set `server_name` and enable the site:
   `sudo ln -s /etc/nginx/sites-available/popmap /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx`
6. Request an HTTPS certificate: `sudo certbot --nginx -d yourdomain.com`.

### Code updates

```bash
cd /opt/popmap && sudo -u popmap git pull && sudo -u popmap ./deploy/deploy.sh /var/www/popmap
```

`deploy.sh` leaves `tiles/` and `data/countries.json` alone. You can also push the code
from your own machine with `./deploy/deploy.sh user@server`.

### How the data updates work

`update_data.py` asks the [HDX API](https://data.humdata.org/dataset/kontur-population-dataset)
for the newest `kontur_population_YYYYMMDD.gpkg.gz` and compares it with `version` in
`tiles/meta.json`. Kontur releases about once a year, so most runs only make that one
API call and refresh `countries.json`. When there is a new release it:

1. downloads it to the work dir (resumes if interrupted),
2. builds the tiles into `/var/www/popmap/tiles-<version>/`,
3. switches the `tiles` symlink to the new folder atomically and deletes the old one.

The live site is never touched by a run that fails halfway. Tile URLs carry
`?v=<version>` and `meta.json` is served with `no-cache`, so visitors get the new data
straight away even though tiles are cached for 30 days.

Useful commands:

```bash
sudo -u popmap /opt/popmap/deploy/update-data.sh --check   # exit code 10 = update available
sudo -u popmap /opt/popmap/deploy/update-data.sh --force   # rebuild anyway
tail -f /var/lib/popmap/update.log
```

Paths can be changed with `POPMAP_WEB_DIR`, `POPMAP_WORK_DIR`, `POPMAP_VENV` and
`POPMAP_LOG` in `/etc/default/popmap`.

### Notes for public use

- **CARTO basemap:** free for non-commercial use with attribution. For heavy traffic or commercial use, switch to your own map style (e.g. OpenFreeMap or self-hosted PMTiles) by changing `BASEMAP` in `web/app.js`.
- **Photon search:** a free public service with a fair-use policy. With many visitors, host it yourself.
- **Attribution:** the Kontur source is shown bottom right; OSM and CARTO are in the map's attribution. Keep them.
