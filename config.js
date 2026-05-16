// Edit this file to change extension defaults. Constants only — no logic.
window.MORPH_CONFIG = {
  // Where the backend lives. For local dev change to http://localhost:8000.
  API_BASE: "https://morph.hugmediary.com",
  // Endpoints derived from API_BASE
  get MORPH_URL() { return this.API_BASE + "/morph"; },
  get PRESETS_URL() { return this.API_BASE + "/presets"; },

  MODES: ["fast", "slow"],
  DEFAULT_MODE: "fast",

  // Bytes of body HTML to send. Server clamps further.
  MAX_HTML_CHARS: 120000,
  FAST_HTML_CHARS: 8000,

  TIMEOUT_MS: 180000,
  UNDO_DEPTH: 20,

  // Cache presets locally for this long before re-fetching.
  PRESETS_TTL_MS: 5 * 60 * 1000,

  // Storage key for the anonymous per-install user UUID.
  USER_ID_KEY: "morph_user_id",
};
