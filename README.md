# Strava Tidy

A mobile-first, installable web app (PWA) that cleans up noisy GPS tracks from runs. You import a GPX or TCX file (exported from Strava or Google Health), the app snaps the track to the roads and paths you actually ran on, and you download or share the tidied file to upload to Strava as a new activity.

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

The `app/` folder is a static site. Upload or point a host at it:

- **GitHub Pages**: publish the contents of `app/` (for example from a `gh-pages` branch or a Pages workflow with `app` as the artifact path).
- **Netlify**: drag-and-drop the `app/` folder, or set the publish directory to `app`, with no build command.
- **Cloudflare Pages**: set the build output directory to `app`, with no build command.

All paths in the app are relative, so it also works from a sub-path such as `https://user.github.io/strava-tidy/`. The service worker and install prompt require HTTPS. Once deployed, open the URL on your phone and use "Add to Home Screen" (iOS Safari: Share, Add to Home Screen; Android Chrome: menu, Install app).

## Using it with Strava

1. On the Strava website, open the activity, click the three-dot menu (⋯), and choose **Export GPX**.
2. Open Strava Tidy and choose that file. Optionally tick "Add (tidied) to the activity name".
3. Wait for matching to finish, check the map, then tap **Download tidied file** (or **Share to Strava…** on phones that support it).
4. Upload the tidied file at <https://www.strava.com/upload/select>.

Notes:

- Strava may flag the upload as a duplicate of the original. Delete the original activity first if you want to replace it, or keep it and accept the duplicate warning.
- Cadence is not included in Strava's GPX export, so a re-uploaded activity will not have cadence data. Heart rate and timestamps are preserved.

## Using it from Google Health (Android)

1. Install Strava Tidy from Chrome (menu, Add to Home screen / Install app). Android only offers an app as a share target once it is installed.
2. In Google Health, open the run and use Export. Choose the TCX file (`exercise_tcx_file.tcx`) and pick **Strava Tidy** in the share sheet.
3. The app opens and tidies the track automatically. Review the map.
4. Tap **Share to Strava…** and choose the Strava app, or tap **Download tidied file** and upload it at <https://www.strava.com/upload/select>.
5. If the original activity already synced to Strava, delete it first. Otherwise Strava treats the upload as a duplicate.

Honest limits:

- Share target and share-out behaviour depend on Android and Chrome, and on the Strava app accepting a TCX file shared from another app. If it does not, use the download and the Strava website upload page.
- Fully automatic upload to Strava is not possible from a static site: Strava's API needs a client secret and a server.
- TCX distances are recalculated from the tidied path; other fields are left as they were.

## Known limits

- Needs an internet connection to download map data (previously used areas are cached for 30 days). The public Overpass servers are sometimes overloaded, which is why the OSM API is used as a fallback; very large areas may be refused by the OSM API.
- Quality depends on OpenStreetMap coverage. Missing paths cause those stretches to stay unsnapped.
- The GPX or TCX must contain a timestamp on every trackpoint.
- Very long activities are processed on-device and can take a while on older phones.
- The orange "left unchanged" dots on the map are inferred from points whose position did not move.
- Map tiles come from the public OpenStreetMap tile server and are subject to its usage policy; they are not cached for offline use.
