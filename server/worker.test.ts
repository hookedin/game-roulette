import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { DEVELOPER_PROTOCOL } from '@hookedin/play/sdk/developer';
import { RouletteWheel } from './worker.ts';
import { BETTING_MS, HEARTBEAT_MS, RETRY_MS } from './wheel.ts';

const CASINO = 'https://casino.test',
  ROUND = '0x' + 'd'.repeat(64);
const body = async (response: Response) => (await response.json()) as any;

/** A casino that can be taken away and put back, somewhere for the Durable Object to keep its state, the alarms it
 * asks for, a clock, and pages that watch the table. */
function worker(t: { mock: { method: typeof import('node:test').mock.method }; after: (fn: () => unknown) => void }) {
  const calls: string[] = [],
    alarms: number[] = [],
    watching: (() => Promise<void>)[] = [];
  t.after(() => Promise.all(watching.map(stop => stop())));
  let reachable = false,
    now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = String(url).slice(CASINO.length);
    calls.push(path);
    if (!reachable) throw new TypeError('Network connection lost.');
    if (path === '/api/config')
      return Response.json({
        chainId: '31337',
        contractAddress: '0x' + 'c'.repeat(40),
        developerProtocol: DEVELOPER_PROTOCOL,
      });
    // The wheel opens its spin's rounds, which the casino names.
    if (path === '/api/rounds') return Response.json({ id: ROUND, status: 'open' });
    if (path === `/api/rounds/${ROUND}`) return Response.json({ id: ROUND, status: 'open' });
    if (path.startsWith('/api/developer-bets?')) {
      // The casino holds a wait until a bet comes; none does.
      if (path.includes('&wait=')) await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({ bets: [], cursor: '0', more: false });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  });
  const stored = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => void stored.set(key, value),
      setAlarm: async (at: number) => void alarms.push(at),
    },
  } as unknown as DurableObjectState;
  const wheel = new RouletteWheel(ctx, {
    CASINO_URL: CASINO,
    GAME_NAME: 'roulette',
    DEVELOPER_KEY: Wallet.createRandom().privateKey,
  } as never);
  return {
    calls,
    alarms,
    start: () => void (reachable = true),
    stop: () => void (reachable = false),
    later: (ms: number) => void (now += ms),
    now: () => now,
    live: () => wheel.fetch(new Request('https://roulette.test/api/live')),
    /** A page watching the table: the first table it hears, and how it stops watching, after which the wheel has
     * stopped following the casino's bets for it. */
    async watch() {
      const response = await wheel.fetch(new Request('https://roulette.test/api/live')),
        reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = '';
      const stop = async () => {
        await reader.cancel().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 50));
      };
      watching.push(stop);
      while (!/^data: /m.test(text)) text += (await reader.read()).value;
      return { response, table: JSON.parse(/^data: (.*)$/m.exec(text)![1]!), stop };
    },
    alarm: () => wheel.alarm(),
  };
}

test('a wheel that could not reach the casino opens at the next request', async t => {
  const x = worker(t);
  const down = await x.live();
  assert.equal(down.status, 503);
  assert.match((await body(down)).error, /Network connection lost/);
  x.start();
  // The pages keep asking, and the one that arrives after the casino is back opens the table.
  const up = await x.watch();
  assert.equal(up.response.status, 200);
  assert.equal(up.response.headers.get('content-type'), 'text/event-stream');
  assert.match(up.table.spin, /^[0-9a-f]{64}$/, 'on a spin of rounds the casino named');
});

test('every request that arrives while the wheel is opening shares the one attempt', async t => {
  const x = worker(t);
  x.start();
  const [first, second] = await Promise.all([x.watch(), x.watch()]);
  assert.deepEqual([first.response.status, second.response.status], [200, 200]);
  assert.deepEqual(
    x.calls.filter(path => path === '/api/config'),
    ['/api/config'],
  );
});

test('a watched table keeps its heartbeat and follows the casino’s bets, and lets both go once nobody watches', async t => {
  const x = worker(t);
  x.start();
  const page = await x.watch();
  assert.ok(x.alarms.at(-1)! <= x.now() + HEARTBEAT_MS, 'a watched wheel wakes for its heartbeat');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(
    x.calls.some(path => path.startsWith('/api/developer-bets?') && path.includes('&wait=25')),
    'and waits for bets',
  );
  await page.stop();
  const lapsed = x.alarms.length;
  await x.alarm();
  assert.equal(x.alarms.length, lapsed, 'a table nobody is at or watches asks for no alarm');
});

test('an alarm that cannot reach the casino asks to be woken again, before the wheel opens and after', async t => {
  const x = worker(t);
  t.mock.method(console, 'error', () => {});
  await x.alarm();
  assert.deepEqual(x.alarms, [x.now() + RETRY_MS], 'the wheel could not open');
  x.start();
  await x.alarm();
  assert.equal(x.alarms.length, 1, 'the wheel opens its spin, and a table nobody is at asks for no alarm');
  x.stop();
  x.later(BETTING_MS);
  await x.alarm();
  assert.deepEqual(x.alarms.at(-1), x.now() + RETRY_MS, 'the wheel could not take its turn');
  // Once the casino answers, the turn lands, and a table with nothing on it asks for no alarm.
  x.start();
  x.later(RETRY_MS);
  const lapsed = x.alarms.length;
  await x.alarm();
  assert.equal(x.alarms.length, lapsed);
});
