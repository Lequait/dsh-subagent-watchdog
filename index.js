/**
 * dsh-subagent-watchdog — tell the parent when a subagent dies instead of
 * finishing.
 *
 * The harness fires `agent/error` on the child when its upstream provider drops
 * the connection, but nothing forwards that to the parent. The child just
 * becomes `idle`, which is indistinguishable from "finished normally" and
 * "waiting for me", so the parent waits forever. This plugin closes that gap
 * without retrying anything: it confirms the child did not recover, then hands
 * the parent one actionable notice.
 *
 * @module dsh-subagent-watchdog
 */

import { resolveConfig, validateConfig } from './lib/config.js';
import { Config } from './lib/schema.js';
import { errorText, log } from './lib/util.js';
import { install } from './lib/watchdog.js';

export const name = 'subagent-watchdog';

/**
 * The options this plugin accepts, declared so the host can validate a profile
 * patch before the plugin starts and document them in `--dump-config-schema`.
 */
export { Config };

/**
 * The registry is the only hard dependency: it is how a child's parent is
 * resolved and how the notice is delivered. Everything else is feature-detected.
 */
export const inject = ['agents'];

/** @param {any} ctx @param {any} rawConfig */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  // A misspelled option would otherwise make the plugin behave exactly like an
  // uninstalled one, so misconfiguration is reported where it is caused.
  for (const warning of validateConfig(rawConfig)) log(ctx, 'warn', `config: ${warning.message}`);

  if (!config.enabled) {
    log(ctx, 'info', 'disabled by configuration');
    return;
  }

  try {
    install(ctx, config);
    log(
      ctx,
      'info',
      `watching subagents (settle ${config.settleDelayMs}ms, cooldown ${config.cooldownMs}ms, max ${config.maxPerChild}/child${config.dryRun ? ', dry-run' : ''})`,
    );
  } catch (error) {
    log(ctx, 'warn', `install failed: ${errorText(error)}`);
  }
}
