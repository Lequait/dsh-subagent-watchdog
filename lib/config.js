/**
 * Configuration surface and defaults.
 *
 * The plugin is deliberately conservative: it only speaks when a subagent
 * actually stopped after an error, it never retries anything on its own, and
 * every notification is bounded by a cooldown and a per-child cap.
 * @module dsh-subagent-watchdog/config
 */

/** @typedef {ReturnType<typeof resolveConfig>} WatchdogConfig */

export const DEFAULTS = Object.freeze({
  /** Master switch; `false` leaves the harness untouched. */
  enabled: true,
  /**
   * How long to wait after `agent/error` before deciding the child is dead.
   * A child that is `running` again when the timer fires recovered on its own
   * (the harness retried the request), so nothing is sent. A child that is
   * still `idle` did not recover — that is the disconnect case.
   */
  settleDelayMs: 2500,
  /** Minimum gap between two notifications about the same child. */
  cooldownMs: 60000,
  /** Hard cap on notifications about one child, per host process. */
  maxPerChild: 5,
  /** Also report a child that is disposed while a failure is still pending. */
  notifyOnDisposed: true,
  /** Log the notice instead of delivering it. Useful for a first install. */
  dryRun: false,
  /** Prefix on the delivered notice, so the parent can recognise it. */
  messagePrefix: '[subagent-watchdog]',
});

/**
 * @param {any} raw
 * @returns {WatchdogConfig}
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined) config[key] = input[key];
  }
  config.enabled = Boolean(config.enabled);
  config.notifyOnDisposed = Boolean(config.notifyOnDisposed);
  config.dryRun = Boolean(config.dryRun);
  config.settleDelayMs = clampNumber(config.settleDelayMs, 0, 120000, DEFAULTS.settleDelayMs);
  config.cooldownMs = clampNumber(config.cooldownMs, 0, 3600000, DEFAULTS.cooldownMs);
  config.maxPerChild = Math.max(0, Math.floor(clampNumber(config.maxPerChild, 0, 1000, DEFAULTS.maxPerChild)));
  config.messagePrefix = typeof config.messagePrefix === 'string' && config.messagePrefix
    ? config.messagePrefix
    : DEFAULTS.messagePrefix;
  return config;
}

/**
 * Name the options that do not exist, so a typo is reported instead of
 * silently behaving like an uninstalled plugin.
 * @param {any} raw
 * @returns {Array<{key: string, message: string}>}
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const known = new Set(Object.keys(DEFAULTS));
  const warnings = [];
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      warnings.push({ key, message: `unknown option "${key}" (known: ${[...known].join(', ')})` });
    }
  }
  return warnings;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
