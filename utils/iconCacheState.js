const ICON_FETCH_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
const REMOTE_FETCH_TIMEOUT_MS = 15000;
const REMOTE_FETCH_MAX_RETRIES = 2;
const REMOTE_FETCH_MAX_REDIRECTS = 3;

const iconFetchFailureUntil = new Map();
const iconFetchInProgress = new Set();

module.exports = {
  ICON_FETCH_FAILURE_COOLDOWN_MS,
  REMOTE_FETCH_TIMEOUT_MS,
  REMOTE_FETCH_MAX_RETRIES,
  REMOTE_FETCH_MAX_REDIRECTS,
  iconFetchFailureUntil,
  iconFetchInProgress
};
