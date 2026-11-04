import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { install, resolveParent } from '../lib/watchdog.js';

/** Minimal stand-in for the Cordis plugin context. */
function makeCtx({ agents = [] } = {}) {
  const handlers = new Map();
  const registry = {
    list: () => agents,
    get: (id) => agents.find((agent) => agent.id === id),
    isOwnedBy: (childId, owner) => {
      const child = agents.find((agent) => agent.id === childId);
      return Boolean(child && child.ownerId === owner.id);
    },
  };
  const ctx = {
    agents: registry,
    logger: { info() {}, warn() {}, debug() {} },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
  return ctx;
}

function makeAgent(id, { status = 'idle', ownerId, parentSession, depth } = {}) {
  return {
    id,
    status,
    ownerId,
    followups: [],
    followup(message) {
      this.followups.push(message);
    },
    session: { header: { id, parentSession, delegationDepth: depth } },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function config(overrides = {}) {
  return resolveConfig({ settleDelayMs: 10, cooldownMs: 0, ...overrides });
}

test('reports a child that errored and stayed idle', async () => {
  const parent = makeAgent('parent', { status: 'running' });
  const child = makeAgent('child', { ownerId: 'parent', depth: 1 });
  const ctx = makeCtx({ agents: [parent, child] });
  install(ctx, config());

  ctx.emit('agent/error', { agent: child, turn: 2, step: 5, error: new Error('socket hang up') });
  await sleep(40);

  assert.equal(parent.followups.length, 1);
  const text = parent.followups[0].content[0].text;
  assert.match(text, /子代理中断/);
  assert.match(text, /socket hang up/);
  assert.match(text, /turn 2 \/ step 5/);
  assert.equal(parent.followups[0].source.kind, 'subagent-watchdog');
});

test('stays silent when the child recovered and is running again', async () => {
  const parent = makeAgent('parent', { status: 'running' });
  const child = makeAgent('child', { ownerId: 'parent', depth: 1 });
  const ctx = makeCtx({ agents: [parent, child] });
  install(ctx, config({ settleDelayMs: 30 }));

  ctx.emit('agent/error', { agent: child, turn: 1, step: 1, error: new Error('timeout') });
  child.status = 'running';
  ctx.emit('agent/status', { agent: child, status: 'running' });
  await sleep(60);

  assert.equal(parent.followups.length, 0);
});

test('ignores a top-level agent with no parent', async () => {
  const root = makeAgent('root', { status: 'idle' });
  const ctx = makeCtx({ agents: [root] });
  install(ctx, config());

  ctx.emit('agent/error', { agent: root, turn: 1, step: 1, error: new Error('boom') });
  await sleep(40);

  assert.equal(root.followups.length, 0);
});

test('falls back to fork lineage when ownership is unknown', async () => {
  const parent = makeAgent('parent', { status: 'running' });
  const child = makeAgent('child', { parentSession: 'parent', depth: 1 });
  const ctx = makeCtx({ agents: [parent, child] });
  install(ctx, config());

  ctx.emit('agent/error', { agent: child, turn: 1, step: 1, error: new Error('502') });
  await sleep(40);

  assert.equal(parent.followups.length, 1);
});

test('honours the cooldown', async () => {
  const parent = makeAgent('parent', { status: 'running' });
  const child = makeAgent('child', { ownerId: 'parent', depth: 1 });
  const ctx = makeCtx({ agents: [parent, child] });
  install(ctx, config({ cooldownMs: 60000 }));

  ctx.emit('agent/error', { agent: child, turn: 1, step: 1, error: new Error('first') });
  await sleep(40);
  ctx.emit('agent/error', { agent: child, turn: 2, step: 2, error: new Error('second') });
  await sleep(40);

  assert.equal(parent.followups.length, 1);
});

test('honours maxPerChild', async () => {
  const parent = makeAgent('parent', { status: 'running' });
  const child = makeAgent('child', { ownerId: 'parent', depth: 1 });
  const ctx = makeCtx({ agents: [parent, child] });
  install(ctx, config({ maxPerChild: 2 }));

  for (let index = 0; index < 5; index += 1) {
    ctx.emit('agent/error', { agent: child, turn: index, step: 1, error: new Error(`e${index}`) });
    await sleep(30);
  }

  assert.equal(parent.followups.length, 2);
});

test('reports a child disposed while a failure is pending', async () => {
  const parent = makeAgent('parent', { status: 'running' });
  const child = makeAgent('child', { ownerId: 'parent', depth: 1 });
  const ctx = makeCtx({ agents: [parent, child] });
  install(ctx, config({ settleDelayMs: 5000 }));

  ctx.emit('agent/error', { agent: child, turn: 1, step: 1, error: new Error('died') });
  ctx.emit('agent/disposed', { agent: child });

  assert.equal(parent.followups.length, 1);
  assert.match(parent.followups[0].content[0].text, /已销毁/);
});

test('dry run never delivers', async () => {
  const parent = makeAgent('parent', { status: 'running' });
  const child = makeAgent('child', { ownerId: 'parent', depth: 1 });
  const ctx = makeCtx({ agents: [parent, child] });
  install(ctx, config({ dryRun: true }));

  ctx.emit('agent/error', { agent: child, turn: 1, step: 1, error: new Error('x') });
  await sleep(40);

  assert.equal(parent.followups.length, 0);
});

test('resolveParent prefers creation ownership over lineage', () => {
  const owner = makeAgent('owner');
  const lineage = makeAgent('lineage');
  const child = makeAgent('child', { ownerId: 'owner', parentSession: 'lineage' });
  const ctx = makeCtx({ agents: [owner, lineage, child] });

  assert.equal(resolveParent(ctx, child)?.id, 'owner');
});
