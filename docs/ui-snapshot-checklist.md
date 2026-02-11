# UI Snapshot Checklist

- App empty: two-column layout stays fixed and no global page scroll.
- One track added: right panel width and position remain unchanged.
- Ten tracks added: only the tracks list scrolls (`overflow-y`), no global scroll.
- Create release folder OFF: release name stays visible but disabled/dimmed, no extra helper text.
- Create release folder ON: release name re-enables with no vertical layout jump.
- Rendering four tracks: single overall progress bar moves smoothly and monotonically with human-looking percentage.
