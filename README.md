# Polica

Android app for finding where an article stands on a shelf. Scan a barcode or type an article number or name
and see the module, shelf and notch, with the product highlighted on the planogram.

- Planogram PDFs (Spaceman exports) are imported on the phone; a newer PDF replaces the older one and the
  changes are listed.
- Small product photos are cut out of the PDF and shown next to each article.
- It can look an unknown barcode up in the store system's web front and flag articles that customers ordered.
- It updates itself: when opened, it looks for a newer version in `dist/`, downloads it, checks the SHA-256
  and the signing key, and asks Android to install it.

## Layout

- `assets/` the interface (served by MainActivity from https://appassets.androidplatform.net/assets/)
  - `js/core.js` planogram reader and lookup, `js/extract.js` text and photo boxes from pdf.js,
    `js/docs.js` import and drawing, `js/app.js` UI, `orders-driver.js` reads the order lists
  - `vendor/pdfjs` pdf.js 6.2.108 legacy build
- `src/ba/polica/` MainActivity (WebView, import, bridge), ScanActivity (Camera2 + ZXing), StorefrontActivity,
  OrdersActivity, Updater
- `third_party/zxing` ZXing 3.5.4 decoder sources (Apache 2.0)
- `dist/` the current APK (`Polica.apk`) and `version.json` that the app reads to update itself

## Build

`./build.sh` builds `out/Polica-<version>.apk` without Gradle (aapt2, javac, dx, uber-apk-signer; tools in
`/home/claude/tools/bin`). It needs `keystore/release.jks`, `keystore/password.txt` and `keystore/host.txt`
(the address of the store system's web front); those files are private and not in this repository.

`./release.sh <version name> "<notes>"` builds, copies the APK to `dist/`, writes `dist/version.json`
(version code, name, notes, size, SHA-256) and pushes.
