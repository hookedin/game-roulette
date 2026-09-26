import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { LIMITS, DEVELOPER_PROTOCOL } from '@hookedin/play/sdk/developer';
import { RouletteWheel } from './worker.ts';

const CASINO = 'https://casino.test',
  ROUND = '0x' + 'd'.repeat(64);
const body = async (response: Response) => (await response.json()) as any;

/** A casino that can be taken away and put back, and somewhere for the Durable Object to keep its state. */
function worker(t: { mock: { method: typeof import('node:test').mock.method } }) {
  const calls: string[] = [];
  let reachable = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = String(url).slice(CASINO.length);
    calls.push(path);
    if (!reachable) throw new TypeError('Network connection lost.');
    if (path === '/api/config')
      return Response.json({
        chainId: '31337',
        contractAddress: '0x' + 'c'.repeat(40),
        developerProtocol: DEVELOPER_PROTOCOL,
        limits: LIMITS,
      });
    // The wheel opens its spin's rounds, which the casino names.
    if (path === '/api/rounds') return Response.json({ id: ROUND, status: 'open' });
    if (path === `/api/rounds/${ROUND}`) return Response.json({ id: ROUND, status: 'open' });
    if (path.startsWith('/api/developer-bets?')) return Response.json({ bets: [], cursor: '', more: false });
    return Response.json({ error: 'Not found' }, { status: 404 });
  });
  const stored = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => void stored.set(key, value),
      setAlarm: async () => {},
    },
  } as unknown as DurableObjectState;
  const wheel = new RouletteWheel(ctx, {
    CASINO_URL: CASINO,
    GAME_NAME: 'roulette',
    DEVELOPER_KEY: Wallet.createRandom().privateKey,
  } as never);
  return {
    calls,
    start: () => void (reachable = true),
    table: () => wheel.fetch(new Request('https://roulette.test/api/table?asset=test')),
  };
}

test('a wheel that could not reach the casino opens at the next request', async t => {
  const x = worker(t);
  const down = await x.table();
  assert.equal(down.status, 503);
  assert.match((await body(down)).error, /Network connection lost/);
  x.start();
  // The pages keep asking, and the one that arrives after the casino is back opens the table.
  const up = await x.table();
  assert.equal(up.status, 200);
  assert.match((await body(up)).spin, /^[0-9a-f]{64}$/, 'on a spin of rounds the casino named');
});

test('every request that arrives while the wheel is opening shares the one attempt', async t => {
  const x = worker(t);
  x.start();
  const [first, second] = await Promise.all([x.table(), x.table()]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.deepEqual(
    x.calls.filter(path => path === '/api/config'),
    ['/api/config'],
  );
});
