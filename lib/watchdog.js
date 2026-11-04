/**
 * The watchdog itself.
 *
 * The gap this closes: when a subagent dies because its upstream provider
 * dropped the connection, the harness fires `agent/error` on the *child*, but
 * nothing forwards that to the parent. The child simply becomes `idle`, which
 * is indistinguishable from "finished normally" and "waiting for me". The
 * parent then waits forever, or assumes work is still in flight.
 *
 * The fix is deliberately small and does not retry anything:
 *
 * 1. Listen on `agent/error` at root scope (a root listener sees every agent).
 * 2. Resolve the child's parent — by creation ownership first, fork lineage
 *    second.
 * 3. Wait `settleDelayMs`. If the child is `running` again it recovered on its
 *    own (the harness retried the request) and nothing is sent. If it is still
 *    `idle`, it is dead.
 * 4. Deliver one actionable notice to the parent with `followup()`, which wakes
 *    an idle parent and queues a turn behind a running one.
 *
 * @module dsh-subagent-watchdog/watchdog
 */

import { errorText, log, shortId } from './util.js';

/**
 * Install the watchdog on a plugin context.
 * @param {any} ctx
 * @param {import('./config.js').WatchdogConfig} config
 * @returns {() => void} teardown
 */
export function install(ctx, config) {
  /** @type {Map<string, any>} childId -> pending failure record */
  const pending = new Map();
  /** @type {Map<string, {count: number, lastAt: number}>} childId -> delivery history */
  const delivered = new Map();

  const clearRecord = (childId) => {
    const record = pending.get(childId);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    pending.delete(childId);
  };

  const onError = (payload) => {
    try {
      const child = payload?.agent;
      if (!child || typeof child.id !== 'string') return;
      const parent = resolveParent(ctx, child);
      // A top-level agent has no parent to tell; its own failure is already
      // visible to whoever is driving it.
      if (!parent || parent.id === child.id) return;

      const previous = pending.get(child.id);
      if (previous?.timer) clearTimeout(previous.timer);

      const record = {
        child,
        parent,
        error: payload.error,
        turn: payload.turn,
        step: payload.step,
        at: Date.now(),
        timer: undefined,
      };
      pending.set(child.id, record);
      arm(ctx, config, child.id, record, pending, delivered);
    } catch (error) {
      log(ctx, 'warn', `agent/error handler failed: ${errorText(error)}`);
    }
  };

  const onStatus = (payload) => {
    try {
      const agent = payload?.agent;
      if (!agent || typeof agent.id !== 'string') return;
      // The child started working again: whatever failed was retried
      // successfully, so there is nothing to report.
      if (payload.status === 'running') clearRecord(agent.id);
    } catch (error) {
      log(ctx, 'warn', `agent/status handler failed: ${errorText(error)}`);
    }
  };

  const onDisposed = (payload) => {
    try {
      const agent = payload?.agent;
      if (!agent || typeof agent.id !== 'string') return;
      const record = pending.get(agent.id);
      if (!record) return;
      clearRecord(agent.id);
      if (!config.notifyOnDisposed) return;
      deliver(ctx, config, record, delivered, 'disposed');
    } catch (error) {
      log(ctx, 'warn', `agent/disposed handler failed: ${errorText(error)}`);
    }
  };

  ctx.on('agent/error', onError);
  ctx.on('agent/status', onStatus);
  ctx.on('agent/disposed', onDisposed);

  const teardown = () => {
    for (const record of pending.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    pending.clear();
    delivered.clear();
  };

  // Cordis disposes plugin effects with the context; without `effect` the
  // timers are simply left to the process.
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => teardown);
  } catch {
    // Optional.
  }

  return teardown;
}

/**
 * Arm the settle timer for one child.
 * @param {any} ctx
 * @param {import('./config.js').WatchdogConfig} config
 * @param {string} childId
 * @param {any} record
 * @param {Map<string, any>} pending
 * @param {Map<string, {count: number, lastAt: number}>} delivered
 */
function arm(ctx, config, childId, record, pending, delivered) {
  const timer = setTimeout(() => {
    record.timer = undefined;
    try {
      const live = lookup(ctx, childId);
      if (live && live.status === 'running') {
        // Recovered between the error and the timer.
        pending.delete(childId);
        return;
      }
      pending.delete(childId);
      deliver(ctx, config, record, delivered, live ? 'idle' : 'gone');
    } catch (error) {
      log(ctx, 'warn', `settle check failed: ${errorText(error)}`);
    }
  }, config.settleDelayMs);
  // Never hold the host process open just to report a dead child.
  if (typeof timer?.unref === 'function') timer.unref();
  record.timer = timer;
}

/**
 * Deliver one notice to the parent, subject to the cooldown and the cap.
 * @param {any} ctx
 * @param {import('./config.js').WatchdogConfig} config
 * @param {any} record
 * @param {Map<string, {count: number, lastAt: number}>} delivered
 * @param {'idle'|'gone'|'disposed'} reason
 */
function deliver(ctx, config, record, delivered, reason) {
  const child = record.child;
  const childId = child?.id;
  if (typeof childId !== 'string') return;

  const history = delivered.get(childId) ?? { count: 0, lastAt: 0 };
  const now = Date.now();
  if (history.count >= config.maxPerChild) return;
  if (now - history.lastAt < config.cooldownMs) return;

  // The parent may have been disposed while the child was dying.
  const parent = lookup(ctx, record.parent?.id) ?? record.parent;
  if (!parent || parent.id === childId) return;

  const message = buildMessage(record, reason, config);

  if (config.dryRun) {
    log(ctx, 'info', `dry-run: would notify ${shortId(parent.id)} about ${shortId(childId)} (${reason})`, message.content[0].text);
    delivered.set(childId, { count: history.count + 1, lastAt: now });
    return;
  }

  try {
    if (typeof parent.followup === 'function') {
      parent.followup(message);
    } else if (typeof parent.send === 'function') {
      parent.send(message, 'next-turn', true);
    } else {
      log(ctx, 'warn', `parent ${shortId(parent.id)} cannot receive a message`);
      return;
    }
    delivered.set(childId, { count: history.count + 1, lastAt: now });
    log(ctx, 'info', `notified ${shortId(parent.id)} about ${shortId(childId)} (${reason})`);
  } catch (error) {
    log(ctx, 'warn', `delivery to ${shortId(parent.id)} failed: ${errorText(error)}`);
  }
}

/**
 * Build the user message the parent receives.
 * @param {any} record
 * @param {'idle'|'gone'|'disposed'} reason
 * @param {import('./config.js').WatchdogConfig} config
 * @returns {any}
 */
function buildMessage(record, reason, config) {
  const child = record.child;
  const header = child?.session?.header ?? {};
  const depth = typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined;
  const state = reason === 'disposed'
    ? '已销毁（disposed）'
    : reason === 'gone'
      ? '已从注册表消失'
      : '已停止（idle），不会自行恢复';

  const lines = [
    `${config.messagePrefix} 子代理中断`,
    '',
    `子代理: ${child.id}`,
    depth !== undefined ? `层级: ${depth}` : undefined,
    `轮次/步骤: turn ${record.turn ?? '?'} / step ${record.step ?? '?'}`,
    `错误: ${errorText(record.error)}`,
    `状态: ${state}`,
    '',
    '请决定如何处理：',
    '- 重新派发同一任务（spawn 新的子代理）',
    '- 换 provider/model 重试',
    '- 自己接手',
    '- 放弃并记录',
    '',
    '（本条由 dsh-subagent-watchdog 自动投递；若你已收到该子代理的正常完成通知，请忽略。）',
  ].filter((line) => line !== undefined);

  return {
    id: `subagent-watchdog-${child.id}-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'subagent-watchdog', childId: child.id, reason },
  };
}

/**
 * Find the agent that created this one.
 *
 * Creation ownership is the exact answer; fork lineage (`parentSession`) is the
 * fallback for agents restored from a stored child session.
 * @param {any} ctx
 * @param {any} agent
 * @returns {any | undefined}
 */
export function resolveParent(ctx, agent) {
  const registry = ctx?.agents;
  if (!registry || !agent) return undefined;

  try {
    const all = typeof registry.list === 'function' ? registry.list() : [];
    for (const candidate of all) {
      if (!candidate || candidate.id === agent.id) continue;
      try {
        if (typeof registry.isOwnedBy === 'function' && registry.isOwnedBy(agent.id, candidate)) {
          return candidate;
        }
      } catch {
        // Ownership is advisory; keep looking.
      }
    }
  } catch {
    // Fall through to lineage.
  }

  const parentId = agent?.session?.header?.parentSession;
  if (typeof parentId === 'string' && parentId !== agent.id) {
    const parent = lookup(ctx, parentId);
    if (parent) return parent;
  }
  return undefined;
}

/**
 * @param {any} ctx
 * @param {string} id
 * @returns {any | undefined}
 */
function lookup(ctx, id) {
  if (typeof id !== 'string') return undefined;
  try {
    return ctx?.agents?.get?.(id);
  } catch {
    return undefined;
  }
}
