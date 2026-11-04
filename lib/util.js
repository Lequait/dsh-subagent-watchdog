/**
 * Small helpers shared by the plugin. Nothing here may throw: a watchdog that
 * breaks the host is worse than the silence it was meant to fix.
 * @module dsh-subagent-watchdog/util
 */

/**
 * Resolve a Cordis service without assuming it exists.
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
export function serviceOf(ctx, name) {
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Log through whatever the host exposes, without ever throwing.
 * @param {any} ctx
 * @param {'info'|'warn'|'debug'} level
 * @param {string} message
 * @param {any} [data]
 */
export function log(ctx, level, message, data) {
  const logger = serviceOf(ctx, 'logger');
  try {
    const fn = logger?.[level] ?? logger?.log;
    if (typeof fn === 'function') {
      fn.call(logger, `[subagent-watchdog] ${message}`, data ?? '');
      return;
    }
    const plain = serviceOf(ctx, 'log');
    if (typeof plain === 'function') {
      plain(level, `[subagent-watchdog] ${message}`, data ?? '');
      return;
    }
    // Headless and early-boot contexts have no logger service yet; without this
    // fallback a load failure would look exactly like a plugin that never ran.
    const sink = level === 'warn' ? console.warn : console.log;
    sink(`[subagent-watchdog] ${message}`, data ?? '');
  } catch {
    // Logging must never break the watchdog.
  }
}

/**
 * Render any thrown value as one readable line.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const record = /** @type {Record<string, any>} */ (error);
    const message = typeof record.message === 'string' ? record.message : undefined;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const status = record.status !== undefined ? String(record.status) : undefined;
    const parts = [message ?? (code ? undefined : safeString(error))];
    if (code) parts.push(`code=${code}`);
    if (status) parts.push(`status=${status}`);
    const text = parts.filter(Boolean).join(' ');
    return text || 'unknown error';
  }
  return String(error);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Shorten a session id for logs and notices.
 * @param {unknown} id
 * @returns {string}
 */
export function shortId(id) {
  const text = typeof id === 'string' ? id : String(id ?? '?');
  return text.length <= 12 ? text : `${text.slice(0, 8)}…`;
}
