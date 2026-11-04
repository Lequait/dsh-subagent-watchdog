/**
 * The configuration surface, declared as a real Cordis/Schemastery schema.
 *
 * Without an exported `Config`, the host treats this plugin's options as
 * unknown configuration: a profile patch gets no validation and
 * `dsh --dump-config-schema` can only say "unknown".
 * @module dsh-subagent-watchdog/schema
 */

import Schema from 'schemastery';

import { DEFAULTS } from './config.js';

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(DEFAULTS.enabled)
    .description('Master switch. `false` leaves the harness completely untouched.'),

  settleDelayMs: Schema.number()
    .min(0)
    .max(120000)
    .default(DEFAULTS.settleDelayMs)
    .description('Wait this long after `agent/error` before deciding the child is dead. A child that is running again when the timer fires recovered on its own and is not reported.'),

  cooldownMs: Schema.number()
    .min(0)
    .max(3600000)
    .default(DEFAULTS.cooldownMs)
    .description('Minimum gap between two notifications about the same child.'),

  maxPerChild: Schema.number()
    .min(0)
    .max(1000)
    .default(DEFAULTS.maxPerChild)
    .description('Hard cap on notifications about one child, per host process.'),

  notifyOnDisposed: Schema.boolean()
    .default(DEFAULTS.notifyOnDisposed)
    .description('Also report a child that is disposed while a failure is still pending.'),

  dryRun: Schema.boolean()
    .default(DEFAULTS.dryRun)
    .description('Log the notice instead of delivering it. Useful for a first install.'),

  messagePrefix: Schema.string()
    .default(DEFAULTS.messagePrefix)
    .description('Prefix on the delivered notice, so the parent can recognise it.'),
});
