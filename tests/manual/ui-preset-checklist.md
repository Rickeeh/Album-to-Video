# UI Manual Test Checklist (Per Preset)

Date: 2026-02-09
App: fRender
Scope: renderer UI flow validation for each preset

## Shared setup

1. Launch app (`npm start`).
2. Add test audio files:
   - one file with track metadata (`trackNo`)
   - one file without track metadata
3. Choose cover image.
4. Choose export folder.
5. Keep "Create a release subfolder" enabled and fill release name.

## Preset: Album / EP — Recommended

1. Select preset.
2. Verify description text appears under the preset selector.
3. Export 2+ tracks.
4. Confirm output files are track-number prefixed when all tracks have `trackNo`.
5. Confirm progress/status text remains human-readable.

Expected:
- no raw FFmpeg errors in UI
- output files appear in selected folder/subfolder

## Preset: Single / Track

1. Select preset.
2. Verify description text appears under the preset selector.
3. Try exporting 2 tracks.
4. Confirm UI blocks with message: preset supports only 1 track.
5. Export exactly 1 track.

Expected:
- user-facing limit message is clear
- single output is created successfully

## Preset: Long-form Audio

1. Select preset.
2. Verify description text appears under the preset selector.
3. Export long track(s).
4. Confirm output ordering follows input order.
5. Cancel one run mid-process to verify cancellation copy.

Expected:
- status shows "Stopping export..." then "Export cancelled."
- no crash and UI unlocks after cancel

## Notes / Result Log

- Fill pass/fail per section and attach screenshots of:
  - preset description
  - max-track warning (single preset)
  - cancellation status
