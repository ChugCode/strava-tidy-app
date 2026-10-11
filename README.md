# Strava Tidy

A mobile-first, installable web app (PWA) that cleans up noisy GPS tracks from runs. You import a GPX or TCX file (exported from Strava or Google Health), the app snaps the track to the roads and paths you actually ran on, and you download the tidied file and upload it to Strava as a new activity.

Everything runs in your browser or phone. There is no backend and no account. Plain JavaScript ES modules, no framework, no bundler, no npm runtime dependencies.

## How it works

1. The GPX or TCX file is parsed and its bounding box is split into small cells.
2. Road and path data for each cell is downloaded from OpenStreetMap: first the Overpass API (three public mirrors tried in order), then the OSM API map endpoint as a fallback. Parsed results are cached in IndexedDB for 30 days.
3. The matcher snaps the track to the road/path network. Stretches that are not near any mapped way are left alone.
4. Only `lat`/`lon` values are rewritten. Timestamps, elevation, heart rate and any other data stay byte-identical.
5. The result view shows distance before and after, per-km splits, and a map (original track in red, tidied track in blue, unchanged points in orange).

The matching engine lives in `app/src/` (`gpx.js`, `osm.js`, `matcher.js`, `report.js`, `pipeline.js`). The app layer is `ui.js`, `worker.js` (runs the pipeline in a Web Worker), `osm-fetch.js` (network provider and cache), `map-view.js` and `sw.js` (service worker, caches the app shell only, never map tiles or OSM responses).

## Run locally

Requires Node 18+ (developed on Node 24).

```
cd app
npm run serve     # http://localhost:8080
npm test          # engine tests, network provider tests, precache checks
```

`localhost` counts as a secure context, so the service worker works there. If you change any file in the precache list in `app/sw.js`, bump the `CACHE` version string so installed copies update.

To regenerate the icons: `npm run icons` (writes PNGs to `app/icons/`).

## Deploy

The `app/` folder is a static site. This repository deploys it to GitHub Pages with `.github/workflows/pages.yml`: every push to `main` runs the tests and publishes the app shell (no tests, scripts or fixtures). In the repository settings, set Pages → Source to **GitHub Actions**. The site is then at `https://<user>.github.io/<repo>/`.

Any other static host works too (Netlify, Cloudflare Pages: publish directory `app`, no build command). All paths are relative, so sub-paths are fine. The service worker and install prompt require HTTPS.

## Using it (Android, from Google Health)

This is the intended day-to-day workflow. Turn off Google Health's automatic upload to Strava first, so the untidied run never reaches Strava and there is nothing to delete later.

1. **Install the app once.** Open the site in Chrome and use menu → **Install app**. A plain "Add to Home screen" shortcut is not enough: Android only lists Strava Tidy as a share target when it is properly installed. If you installed an older version, remove it and install again.
2. In Google Health, open the run, tap **Export** and choose **Strava Tidy** in the share list. The app opens and tidies the track automatically (it needs a connection to download map data).
3. Check the map and the before/after distance and splits.
4. Tap **Download tidied file**. It is saved to your Downloads folder as `exercise_tcx_file-tidied.tcx`.
5. Open <https://www.strava.com/upload/select>, tap the upload button and choose the file. If Android's picker only shows photos and videos, open its menu (☰ or ⋮) and pick **Downloads**.

If Strava Tidy does not appear in the share list, export the TCX to your phone instead, open the app and use **Choose GPX or TCX file**.

Notes:

- Only positions change. Timestamps, heart rate, cadence, altitude and the rest of the file are left alone. In a TCX file the running distance values (per point and per lap) are recalculated from the tidied path so the file stays consistent.
- There is no share-to-Strava button: in testing, sharing the tidied TCX from the app failed with "Permission denied" (Chrome limits which file types a web page may share), so use Download and the Strava website upload.
- Fully automatic upload to Strava is not possible from a static site: Strava's API needs a client secret, which means a server.
- If a run already synced to Strava before you turned automatic upload off, delete that activity first, otherwise Strava flags the upload as a duplicate.

## Using it with a Strava export (GPX)

You can also tidy an activity that is already on Strava:

1. On the Strava website, open the activity, click the three-dot menu (⋯) and choose **Export GPX**.
2. Open Strava Tidy, choose the file, optionally tick "Add (tidied) to the activity name" (GPX only), then download the result.
3. Delete the original activity on Strava, then upload the tidied file at <https://www.strava.com/upload/select>.

Strava's GPX export has heart rate but no cadence, so a re-uploaded activity loses its cadence data. The Google Health TCX route above avoids this because the TCX is the original file.

## Known limits

- Needs an internet connection to download map data (previously used areas are cached for 30 days). The public Overpass servers are sometimes overloaded, which is why the OSM API is used as a fallback; very large areas may be refused by the OSM API.
- Quality depends on OpenStreetMap coverage. Missing paths cause those stretches to stay unsnapped.
- The GPX or TCX must contain a timestamp on every trackpoint.
- Very long activities are processed on-device and can take a while on older phones.
- The orange "left unchanged" dots on the map are inferred from points whose position did not move.
- Map tiles come from the public OpenStreetMap tile server and are subject to its usage policy; they are not cached for offline use.
