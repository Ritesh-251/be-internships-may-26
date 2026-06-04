import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

// ─── Original test (unchanged) ───────────────────────────────────────────────

test('idempotency returns same resource for same key', async () => {
  const proc = spawn('node', ['src/server.js'], { env: { ...process.env, API_KEY: 'k', PORT: '9091' } });
  await wait(300);

  const base = 'http://localhost:9091';
  const idem = 'same-key';

  const a = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' }
  });
  const b = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' }
  });

  assert.equal(a.id, b.id);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  proc.kill();
});

// ─── New test: concurrent requests with the same key ─────────────────────────

test('idempotency is safe under concurrent requests', async () => {
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9093',
      DATABASE_URL: './data/test_idem_concurrent.db',
      DB_FAIL_RATE: '0',
      // Set high enough so rate limiting never interferes with this idempotency test.
      RATE_LIMIT_PER_MIN: '20',
    },
  });
  await wait(600);

  const base = 'http://localhost:9093';
  const idem = 'concurrent-key';
  const userId = 'u-concurrent';

  // Fire 5 parallel POST requests all with the same Idempotency-Key.
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      postJson(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
        body: { userId, type: 'note', payload: 'x' },
      })
    )
  );

  // All 5 responses must share the same id — zero duplicates created.
  const ids = new Set(results.map((r) => r.id));
  assert.equal(
    ids.size,
    1,
    `expected all concurrent responses to share one id, got ids: ${[...ids]}`
  );

  // Confirm exactly 1 row exists in DB for this userId.
  const list = await getJson(
    `${base}/v1/signals?userId=${userId}`,
    { headers: { 'x-api-key': 'k' } }
  );
  assert.equal(
    list.items.length,
    1,
    `expected 1 signal row in DB, got ${list.items.length}`
  );

  proc.kill();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function postJson(url, { headers, body }){
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let chunks=''; res.on('data', d => chunks+=d);
      res.on('end', () => resolve(JSON.parse(chunks||'{}')));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function getJson(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => resolve(JSON.parse(chunks || '{}')));
    });
    req.on('error', reject);
    req.end();
  });
}
