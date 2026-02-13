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

## Release

- Para fazer release, siga `docs/release-checklist.md`.
- Windows requer bins vendorizados + `verify:win-bins`.
- Logs por sessão em `%APPDATA%/.../logs/...` (ver `logger.ready`).

## Local build

```bash
npm run dist
```

If you only want unpacked output:

```bash
npx electron-builder --dir
```

## Artifacts

Build artifacts are generated under `dist/`.
