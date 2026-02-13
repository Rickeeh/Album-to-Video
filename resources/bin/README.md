# Vendored macOS Binaries

This project expects vendored FFmpeg/FFprobe binaries for both mac architectures:

- `resources/bin/darwin-arm64/ffmpeg`
- `resources/bin/darwin-arm64/ffprobe`
- `resources/bin/darwin-x64/ffmpeg`
- `resources/bin/darwin-x64/ffprobe`

Populate these files by running:

```bash
npm run bootstrap:mac-bins
```

By default this is idempotent and does not overwrite existing files.
To overwrite existing binaries:

```bash
npm run bootstrap:mac-bins -- --force
```

Run that command once on Apple Silicon and once on Intel macOS so both folders exist locally.

Universal mac builds (`npm run dist:mac`) verify these files before packaging.
