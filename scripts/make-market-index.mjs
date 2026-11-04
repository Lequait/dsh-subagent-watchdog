#!/usr/bin/env node
/**
 * Generates the format-1 plugin market index entry and validates it with the host's own
 * `parseMarketIndex`, so the listing is checked by the same code DSH uses to read indexes.
 *
 * Run it with the app's own Node, because only Electron's patched `fs` can read app.asar:
 *   ELECTRON_RUN_AS_NODE=1 "DSH NEXT.exe" scripts/make-market-index.mjs --commit <40-hex>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function asarCandidate() {
  const explicit = process.env.DSH_APP_ASAR;
  if (explicit !== undefined && explicit !== '') return explicit;
  const local = process.env.LOCALAPPDATA ?? '';
  return path.join(local, 'Programs/DSH NEXT/resources/app.asar');
}

async function loadValidator() {
  const file = path.join(
    asarCandidate(),
    'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js',
  );
  if (!fs.existsSync(file)) {
    throw new Error(`Cannot find the host validator at ${file}. Set DSH_APP_ASAR.`);
  }
  return import(pathToFileURL(file).href);
}

function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

const CATEGORY = { id: 'orchestration', en: 'Orchestration', zh: '编排' };
const LABELS = [
  { id: 'subagent', en: 'Subagent', zh: '子代理' },
  { id: 'reliability', en: 'Reliability', zh: '可靠性' },
  { id: 'notification', en: 'Notification', zh: '通知' },
];

function buildDoc({ pkg, commit, iconSvg, publishTimestamp }) {
  return {
    format: 1,
    title: { en: 'Subagent Watchdog', zh: '子代理看门狗' },
    description: {
      en: 'Tells the parent agent when a subagent died from an upstream failure instead of finishing.',
      zh: '子代理被上游断线打死时，替它给父代理报丧。',
    },
    metadata: {
      categories: { [CATEGORY.id]: { title: { en: CATEGORY.en, zh: CATEGORY.zh } } },
      labels: Object.fromEntries(
        LABELS.map((l) => [l.id, { title: { en: l.en, zh: l.zh } }]),
      ),
      sortKeys: {},
    },
    plugins: [
      {
        name: pkg.name,
        title: { en: 'Subagent Watchdog', zh: '子代理看门狗' },
        description: {
          en: 'Listens to agent/error on every agent. If the child is still not running after a short settle delay, it delivers a followup turn to the parent with the child id, the failure, and the options the parent has. Cooldown and per-child caps keep a flapping provider from flooding the parent.',
          zh: '监听每个 agent 的 agent/error。短暂静置后若子代理仍未恢复运行，就向父代理投递一条后续轮：带上子代理 id、失败原因，以及父代理可选的处置方式。冷却时间与每子代理上限避免上游抖动时刷屏。',
        },
        ...(iconSvg === undefined
          ? {}
          : { icon: `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}` }),
        author: 'Lequait',
        metadata: {
          category: CATEGORY.id,
          keywords: ['subagent', 'watchdog', 'agent-teams', 'failure', 'notification'],
          labels: LABELS.map((l) => l.id),
          sortKeys: {},
        },
        versions: [
          {
            version: pkg.version,
            publishTimestamp,
            source: {
              type: 'git',
              url: 'https://github.com/Lequait/dsh-subagent-watchdog',
              commit,
            },
            engines: { dsh: pkg.engines.dsh },
          },
        ],
      },
    ],
  };
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const commit = argOf('commit', headCommit());
if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
  throw new Error(`Need a 40-hex commit, got ${String(commit)}`);
}
const iconPath = path.join(ROOT, 'market/icon.svg');
const iconSvg = fs.existsSync(iconPath) ? fs.readFileSync(iconPath, 'utf8') : undefined;
const out = argOf('out', path.join(ROOT, 'market/index.json'));
const publishTimestamp = Number(argOf('timestamp', Math.floor(Date.now() / 1000)));

const doc = buildDoc({ pkg, commit, iconSvg, publishTimestamp });
const { parseMarketIndex } = await loadValidator();
const indexUrl = argOf('index-url', 'https://github.com/Lequait/dsh-subagent-watchdog/raw/main/market/index.json');
const parsed = parseMarketIndex(doc, indexUrl);
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`wrote ${out}`);
console.log(`validated: ${parsed.plugins.length} plugin(s), ${parsed.plugins[0].name}@${parsed.plugins[0].versions[0].version}`);
