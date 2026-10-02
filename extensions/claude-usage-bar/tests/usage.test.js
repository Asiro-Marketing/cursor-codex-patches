const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchCodexUsage, normalizeCodexUsage } = require('../codex-usage');
const { createUsageState, refreshUsageState } = require('../usage-state');
const { buildHtml } = require('../usage-view');

const weekly = { rateLimits: { limitId: 'codex', primary: {
  usedPercent: 43, windowDurationMins: 10080, resetsAt: 1790137704,
} } };

test('weekly-only primary uses the real duration and used percentage', () => {
  assert.deepEqual(normalizeCodexUsage(weekly), [{ label: 'Weekly', tag: '7d', utilization: 43,
    resets_at: '2026-09-23T04:28:24.000Z', accent: 'blue' }]);
});

test('codex bucket wins over legacy/other buckets and preserves both windows', () => {
  const entries = normalizeCodexUsage({ ...weekly, rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 12.6, windowDurationMins: 300 },
    secondary: { usedPercent: 76, windowDurationMins: 10080 },
  } } });
  assert.deepEqual(entries.map(({ tag, utilization }) => [tag, utilization]), [['5h', 13], ['7d', 76]]);
});

test('unknown/missing data never invents five-hour limits or 0% usage', () => {
  assert.deepEqual(normalizeCodexUsage(null), []);
  assert.deepEqual(normalizeCodexUsage({ rateLimits: { primary: {} } }), []);
  assert.deepEqual(normalizeCodexUsage({ rateLimits: { limitId: 'other', primary: { usedPercent: 30 } } }), []);
  const [entry] = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 120, resetsAt: 1e30 } } });
  assert.equal(entry.label, 'Usage');
  assert.equal(entry.tag, '');
  assert.equal(entry.resets_at, null);
  assert.equal(entry.utilization, 100);
});

function fixture(context, response) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-usage-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fake-codex');
  fs.writeFileSync(file, '#!/bin/sh\n' + response, { mode: 0o700 });
  return file;
}

test('stdio handshake handles notifications, partial chunks and immediate EOF', async context => {
  const executable = fixture(context, `read -r init
printf '%s\\n' '{"id":1,"result":{}}'
read -r ready
read -r request
case "$request" in *account/rateLimits/read*) ;; *) exit 1 ;; esac
printf '%s\\n' '{"method":"notification"}'
printf '%s' '{"id":2,"res'
printf '%s\\n' 'ult":${JSON.stringify(weekly)}}'
`);
  assert.equal((await fetchCodexUsage({ executable }))[0].utilization, 43);
});

test('authentication failure becomes an actionable message without raw server details', async context => {
  const executable = fixture(context, `read -r init
printf '%s\\n' '{"id":1,"error":{"message":"authentication required: private details"}}'
`);
  await assert.rejects(fetchCodexUsage({ executable }), error => error.code === 'auth'
    && error.message === 'Codexでログインしてください');
});

test('missing executable fails without launching a shell', async () => {
  await assert.rejects(fetchCodexUsage({ executable: '/not-installed/codex' }), { code: 'missing-cli' });
});

test('unresponsive process times out and abort cancels an active request', async context => {
  const executable = fixture(context, 'read -r init\nread -r wait_forever\n');
  await assert.rejects(fetchCodexUsage({ executable, timeoutMs: 100 }), { code: 'timeout' });
  const controller = new AbortController();
  const pending = fetchCodexUsage({ executable, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
});

test('parallel callers are deduplicated and cache preserves its fetch time', async () => {
  const state = createUsageState();
  let complete;
  let calls = 0;
  const fetch = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
  const pending = refreshUsageState(state, fetch, () => {});
  await refreshUsageState(state, fetch, () => {}, true);
  complete(['live']);
  await pending;
  const updated = state.updatedAt;
  await refreshUsageState(state, fetch, () => {});
  assert.equal(calls, 1);
  assert.equal(state.updatedAt, updated);
});

test('provider failures are isolated and stale data/backoff survive manual refresh', async () => {
  const claude = createUsageState();
  const codex = createUsageState();
  await Promise.all([
    refreshUsageState(claude, async () => { throw new Error('auth unavailable'); }, () => {}),
    refreshUsageState(codex, async () => normalizeCodexUsage(weekly), () => {}),
  ]);
  assert.equal(codex.data[0].utilization, 43);
  assert.equal(claude.data, null);
  const updated = codex.updatedAt;
  await refreshUsageState(codex, async () => { throw Object.assign(new Error('rate limit'), { code: 429, waitSec: 900 }); }, () => {}, true);
  await refreshUsageState(codex, async () => { assert.fail('backoff was bypassed'); }, () => {}, true);
  assert.equal(codex.data[0].utilization, 43);
  assert.equal(codex.updatedAt, updated);
  assert.match(codex.error, /15分/);
});

test('Codex is always blue at 0%, 43%, 75% and 100%', () => {
  for (const percent of [0, 43, 75, 100]) {
    const codex = { ...createUsageState(), data: normalizeCodexUsage({ rateLimits: {
      primary: { usedPercent: percent, windowDurationMins: 10080 },
    } }), updatedAt: Date.now() };
    const html = buildHtml({ claude: createUsageState(), codex });
    const section = html.slice(html.indexOf('<section aria-label="CODEX USAGE"'));
    assert.match(section, /linear-gradient\(90deg,#2563eb,#60a5fa\)/);
    assert.match(section, /color:var\(--codex-blue\)/);
    assert.ok(!section.includes('#ef6c00') && !section.includes('#e53935'));
  }
});

test('Claude rows, Fable accent and safe error rendering coexist with Codex', () => {
  const claude = { ...createUsageState(), data: { five_hour: { utilization: 12 },
    limits: [{ percent: 30, scope: { model: { display_name: 'Fable' } } },
      { percent: 20, scope: { model: { display_name: '<script>bad</script>' } } }] } };
  const html = buildHtml({ claude, codex: { ...createUsageState(), error: '<img src=x onerror=bad()>' } });
  assert.match(html, /CLAUDE USAGE/);
  assert.match(html, /CODEX USAGE/);
  assert.match(html, /class="row is-fable"/);
  assert.match(html, /Session/);
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  assert.match(html, /Content-Security-Policy/);
});
