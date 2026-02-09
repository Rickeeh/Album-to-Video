# album-to-video-app

Desktop Electron app that converts one or more audio tracks plus a static cover image into MP4 videos with predictable, offline rendering via bundled FFmpeg/FFprobe.

## Requirements

- Node.js `v24.13.0` (current local version used in this repo)
- Supported targets: macOS and Windows

## Development

```bash
npm i
npm start
```

## Merge PRs #1-#5 in order

Use this script (requires GitHub CLI auth):

```bash
./scripts/merge-prs-1-5.sh
```

The script validates merge readiness and performs ordered merges with merge commits.

## Local build

```bash
npm run dist
```

Platform-specific packages:

```bash
npm run dist:mac   # universal .dmg + .zip (requires vendored mac binaries)
npm run dist:win   # nsis installer + portable .exe
```

If you only want unpacked output:

```bash
npx electron-builder --dir
```

## CI / Signing / Notarization

GitHub Actions runs tests and packaging on macOS + Windows.

- macOS signed + notarized build is enabled when these repository secrets are set:
  - `CSC_LINK`
  - `CSC_KEY_PASSWORD`
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`
- If secrets are missing, CI still builds unsigned mac artifacts.

Universal macOS build notes:

- Vendor binaries under `resources/bin/darwin-x64` and `resources/bin/darwin-arm64`.
- On each architecture, run `npm run bootstrap:mac-bins` to refresh local vendored binaries.
- Bootstrap is idempotent by default. Use `npm run bootstrap:mac-bins -- --force` to overwrite.
- `npm run verify:mac-bins` checks all required binaries before `dist:mac`.
- `build.mac.x64ArchFiles` is set for `Contents/Resources/bin/**` in universal merge.

## Artifacts

Build artifacts are generated under `dist/`.

## Manual UI Test

Manual preset-by-preset UI checklist:

- `tests/manual/ui-preset-checklist.md`
