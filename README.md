# fRender

fRender is a deterministic desktop publisher for audio-to-video exports: static cover image, one or more audio tracks, bundled FFmpeg/FFprobe, and a strict 1 FPS policy for predictable output.

## Requirements

- Node.js `v24.13.0` (current local version used in this repo)
- Supported targets: macOS and Windows

## Development

```bash
npm i
npm start
```

## Release

- Para fazer release, siga `docs/release-checklist.md`.
- Windows requer bins vendorizados + `verify:win-bins`.
- Logs por sessão em `%APPDATA%/.../logs/...` (ver `logger.ready`).
- Compatibilidade de paths: logs/diagnostics mantêm pastas legadas em disco (`Album-to-Video`) por enquanto.

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
npm run dist:mac:arm64  # macOS arm64 .dmg + .zip + manifest
npm run dist:mac:x64    # macOS x64 .dmg + .zip + manifest
npm run dist:mac        # builds arm64 then x64
npm run dist:win   # nsis installer + portable .exe
```

Artifact naming uses `fRender-<version>-<os>-<arch>.<ext>` (ex: `fRender-1.0.0-mac-arm64.dmg`).

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

Dual-arch macOS build notes:

- Vendor binaries under `resources/bin/darwin-x64` and `resources/bin/darwin-arm64`.
- On each architecture, run `npm run bootstrap:mac-bins` to refresh local vendored binaries.
- Bootstrap is idempotent by default. Use `npm run bootstrap:mac-bins -- --force` to overwrite.
- `npm run verify:mac-bins` checks all required binaries before every mac build.
- Outputs are isolated per target:
  - `dist/mac-arm64/*`
  - `dist/mac-x64/*`

Windows build contract (deterministic / vendored):

- Vendor binaries under `resources/bin/win32/ffmpeg.exe` and `resources/bin/win32/ffprobe.exe`.
- `npm run dist:win` always runs `npm run verify:win-bins` first.
- `verify:win-bins` enforces:
  - file presence
  - PE executable signature (`MZ`)
  - pinned SHA256 for both binaries
- Packaging fails fast if any check does not match.
- After build, confirm the packaged paths:
  - `dist/win-unpacked/resources/bin/win32/ffmpeg.exe`
  - `dist/win-unpacked/resources/bin/win32/ffprobe.exe`

Quick verification:

```bash
ls -lh dist/win-unpacked/resources/bin/win32/
shasum -a 256 dist/win-unpacked/resources/bin/win32/ffmpeg.exe dist/win-unpacked/resources/bin/win32/ffprobe.exe
```

## Artifacts

Build artifacts are generated under `dist/`.

## Manual UI Test

Manual preset-by-preset UI checklist:

- `tests/manual/ui-preset-checklist.md`
