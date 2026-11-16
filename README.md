# Dr.Doc

Offline document toolkit for Android, desktop (Windows) and the web. All processing happens on the device; nothing is uploaded.

One React + TypeScript codebase:

| Target | Wrapper | Output folder | Receives files via |
|---|---|---|---|
| Android APK | Capacitor (`android/`) | `Documents/Dr.Doc` | Share sheet (WhatsApp, Gmail, Files…) and “Open with” |
| Windows desktop | Electron (`electron/`) | `Documents\Dr.Doc` | Drag & drop, “Open with” for .pdf/.docx |
| Web / PWA | Service worker (`public/sw.js`) | Browser storage + Download | Share sheet once installed on Android |

## Features

- **Merge & combine:** merge PDFs, merge Word (.docx, keeps formatting/images/lists), combine any mix (incl. PowerPoint and old .doc) into one PDF or one Word file, images → PDF
- **PDF tools:** split, extract, delete, reorder, rotate pages, compress, page numbers, watermark, edit metadata
- **Scan & OCR (offline, English + Hindi):** make scanned PDFs/photos searchable; scanned PDF/photo → Word, text, Markdown. PDF → Word falls back to OCR for scanned pages automatically.
- **Security:** unlock a PDF (with its password), protect a PDF with a password (AES-256, print/copy/edit permissions)
- **From PDF:** Word (headings, bold/italic, pictures, two-column reading order), text, Markdown, HTML, PNG, JPG
- **To PDF:** Word, old Word (.doc), PowerPoint (.pptx), text, Markdown, HTML, Excel/CSV, with real selectable text on every platform
- **Word & text:** Word ↔ text/HTML/Markdown, old .doc → .docx/text, Markdown ↔ HTML, etc.
- **PowerPoint:** .pptx → PDF, Word, text, Markdown, PNG/JPG slides
- **Images:** PNG/JPG/WEBP conversion, images → Word
- **Spreadsheets:** CSV ↔ XLSX, sheets → PDF/HTML/Word

Limitations: old .ppt files are not supported; .doc conversion keeps text and simple tables only; PowerPoint charts/SmartArt are skipped; PDF tables become paragraphs in Word. On phone/web, PDF pages containing scripts outside the Latin set (e.g. Hindi) are saved as images; the desktop app keeps them as text. OCR text for Hindi is recognised but not yet added as a searchable layer in PDFs.

The OCR engine and language data (~16 MB) are copied from `node_modules` into `public/ocr/` automatically before `dev`/`build`.

## Commands

```bash
npm install
npm run dev            # web app at http://localhost:5173
npm run build          # production web build in dist/
npm run desktop        # run the desktop app
npm run desktop:dist   # build release/Dr.Doc-<version>-portable.exe
npm run android:sync   # copy the web build into the Android project
```

### Building the APK

- **GitHub (no local setup):** push this folder to a GitHub repo. `.github/workflows/android-apk.yml` builds a debug APK on each push to `main` (or run it manually from the Actions tab); download it from the run’s *Artifacts*.
- **Locally:** install Android Studio (JDK 21 + Android SDK 35), run `npm run android:sync`, then either `npm run android:open` and *Build › Build APK(s)*, or `cd android && gradlew assembleDebug`. The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`.

To install it, copy the APK to the phone and open it (allow “Install unknown apps” for your file manager when asked).

## Tests

```bash
powershell -File tests/make-office-fixtures.ps1   # optional: real .doc/.pptx + scan image (needs MS Office)
npm run test:fixtures                    # create sample inputs in tests/fixtures
npm run dev                              # in another terminal
npm run test:smoke                       # runs every tool in Electron, writes tests/out
node tests/verify.mjs tests/out          # inspect outputs (page counts, text, images)
```

If Electron starts as plain Node (`app` is undefined), clear `ELECTRON_RUN_AS_NODE` first; VS Code terminals set it.
