import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

// ─── Original test (unchanged) ───────────────────────────────────────────────

test('rate limit: allow 5 per minute, 6th is 429', async () => {
  const proc = spawn('node', ['src/server.js'], { env: { ...process.env, API_KEY: 'k', PORT: '9092', RATE_LIMIT_PER_MIN: '5' } });
  await wait(300);

  const base = 'http://localhost:9092';
  const statuses = [];
  for (let i=0;i<6;i++){
    const code = await postStatus(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u1', type: 'note', payload: String(i) }
    });
    statuses.push(code);
  }
  const counts = statuses.reduce((acc,c)=> (acc[c]=(acc[c]||0)+1, acc), {});
  assert.ok(counts[200] >= 5);
  assert.ok(counts[429] >= 1);
  proc.kill();
});

// ─── New test: concurrent burst ───────────────────────────────────────────────

test('rate limit is safe under concurrent burst', async () => {
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9094',
      RATE_LIMIT_PER_MIN: '5',
      DATABASE_URL: './data/test_rl_concurrent.db',
      DB_FAIL_RATE: '0',
    },
  });
  await wait(300);

  const base = 'http://localhost:9094';

  // Fire 10 parallel POST requests for the same userId.
  const statuses = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      postStatus(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'u1', type: 'note', payload: String(i) },
      })
    )
  );

  const counts = statuses.reduce((acc, c) => (acc[c] = (acc[c] || 0) + 1, acc), {});

  // checkAndConsume is synchronous — the event loop processes each handler's
  // rate-limit check serially before any handler yields to the DB call.
  // Exactly 5 must be accepted (200) and 5 must be rejected (429).
  assert.equal(counts[200], 5, `expected exactly 5 accepted, got ${counts[200]} (statuses: ${statuses})`);
  assert.equal(counts[429], 5, `expected exactly 5 rate-limited, got ${counts[429]} (statuses: ${statuses})`);

  proc.kill();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function postStatus(url, { headers, body }){
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}
