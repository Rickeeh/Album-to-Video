const IS_MAC = process.platform === 'darwin';

const SHARED_ENGINE = {
  vf: "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
  video: () => {
    if (IS_MAC) {
      return [
        '-c:v', 'h264_videotoolbox',
        '-b:v', '6000k',
        '-pix_fmt', 'yuv420p',
      ];
    }
    return [
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      '-g', '1',
      '-keyint_min', '1',
      '-sc_threshold', '0',
    ];
  },
};

const PRESETS = {
  album_ep: {
    key: 'album_ep',
    label: 'Album / EP — Recommended',
    description: 'Use when exporting a release with multiple tracks. Keeps track numbers when tags are available.',
    policy: {
      ordering: 'track_no_if_all_present',
      prefixTrackNumber: true,
      maxTracks: null,
    },
    engine: SHARED_ENGINE,
  },
  single_track: {
    key: 'single_track',
    label: 'Single / Track',
    description: 'Use for one-song exports. Keeps your original order and file name without track number prefix.',
    policy: {
      ordering: 'input',
      prefixTrackNumber: false,
      maxTracks: 1,
    },
    engine: SHARED_ENGINE,
  },
  long_form: {
    key: 'long_form',
    label: 'Long-form Audio',
    description: 'Use for mixes, podcasts, sets, and long recordings. Exports in the exact order you add files.',
    policy: {
      ordering: 'input',
      prefixTrackNumber: false,
      maxTracks: null,
    },
    engine: SHARED_ENGINE,
  },
};

function getPreset(presetKey) {
  return PRESETS[presetKey] || PRESETS.album_ep;
}

function listPresets() {
  return Object.values(PRESETS).map((preset) => ({
    key: preset.key,
    label: preset.label,
    description: preset.description || '',
    policy: {
      ordering: preset.policy.ordering,
      prefixTrackNumber: Boolean(preset.policy.prefixTrackNumber),
      maxTracks: Number.isInteger(preset.policy.maxTracks) ? preset.policy.maxTracks : null,
    },
    recommended: preset.key === 'album_ep',
  }));
}

module.exports = {
  PRESETS,
  getPreset,
  listPresets,
};
