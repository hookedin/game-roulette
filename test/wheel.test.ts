import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { outcome, seedHash } from '@hookedin/play/sdk/outcome';
import type { Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { BETTING_MS, Wheel, coveredHash } from '../server/wheel.ts';
import type { Spin, WheelState } from '../server/wheel.ts';
import { groupOf, payouts, pocket, wireChips } from '../src/table.ts';
import type { Chips } from '../src/table.ts';

/** A casino that does what the developer kit asks, and a clock the test turns. */
function table() {
  let now = 1_000_000,
    count = 0,
    failing: any = null,
    lose = false,
    decline = false;
  // The developer's rounds, each the hash of a secret, and the seed of its casino bet on it.
  const secret = (n: number) => keccak256('0x' + n.toString(16).padStart(64, '0')),
    seedOf = (id: string) => keccak256(id),
    rounds = new Map<string, { secret: string; casinoBet?: Round['casinoBet'] }>();
  const view = (id: string): Round => {
    const round = rounds.get(id)!,
      seed = seedOf(id);
    return {
      id,
      developer: '0x' + 'a'.repeat(40),
      asset: 'test',
      status: round.casinoBet ? 'revealed' : 'open',
      ...(round.casinoBet
        ? {
            seed,
            secret: round.secret,
            outcome: String(outcome([], seed, round.secret).value),
            casinoBet: round.casinoBet,
          }
        : {}),
    };
  };
  const open = new Map<string, PublicDeveloperBet>(),
    paid = new Map<string, bigint>(),
    calls: string[] = [],
    casinoBets: Record<string, unknown>[] = [],
    saves: WheelState[] = [],
    spins = new Map<string, Spin>(),
    wakes: number[] = [];
  const developer = {
    address: '0x' + 'a'.repeat(40),
    async openRound() {
      const id = keccak256(secret(++count));
      rounds.set(id, { secret: secret(count) });
      return view(id);
    },
    seedHash: async (id: string) => seedHash(seedOf(id)),
    async round(id: string) {
      // A round the casino never named, or lost with its row, is unknown to it.
      if (!rounds.has(id)) throw Object.assign(new Error('Unknown round'), { status: 404 });
      return view(id);
    },
    async bets() {
      calls.push('bets');
      return { bets: structuredClone([...open.values()]), cursor: '', more: false };
    },
    async casinoBet({ round: id, meta }: { round: string; meta: Record<string, unknown> }) {
      calls.push('casinoBet');
      if (failing) throw failing;
      const round = rounds.get(id)!;
      if (!round.casinoBet) {
        casinoBets.push(meta);
        round.casinoBet = { game: '0x', stake: '0', prizes: [], meta, signature: '0x', accepted: !decline };
      }
      // The casino took it, and the reply never came back.
      if (lose) throw new Error('reply lost');
      return view(id);
    },
    async settle(settlements: { bet: string; player: bigint }[]) {
      for (const { bet, player } of settlements) {
        paid.set(bet, player);
        open.delete(bet);
      }
      return [];
    },
  } as unknown as Developer;
  const deps = {
    developer,
    asset: 'test' as const,
    now: () => now,
    save: (s: WheelState) => void saves.push(structuredClone(s)),
    keep: (spin: Spin) => void spins.set(spin.round, structuredClone(spin)),
    kept: (round: string) => spins.get(round) ?? null,
    wake: (at: number) => void wakes.push(at),
  };
  return {
    deps,
    calls,
    casinoBets,
    paid,
    saves,
    spins,
    wakes,
    wheel: new Wheel(deps),
    /** A player's wallet places a developer bet in the group of the round its page named, in its asset, with the
     * table's seed hash and its chips in its meta: the casino records when. */
    bet({
      uname = 'p',
      chips = { red: 100n },
      asset = 'test',
      round = [...rounds.keys()].at(-1)!,
      stake = String(Object.values(chips).reduce((sum, amount) => sum + amount, 0n)),
      meta = { seedHash: seedHash(seedOf(round)), chips: wireChips(chips) },
    }: {
      uname?: string;
      chips?: Chips;
      asset?: 'eth' | 'test';
      round?: string;
      stake?: string;
      meta?: Record<string, unknown>;
    } = {}) {
      const hash = '0x' + String(open.size + paid.size + 1).padStart(64, '0');
      open.set(hash, {
        bet: hash,
        uname,
        stake,
        meta,
        asset,
        group: groupOf(asset === 'test' ? round : keccak256('0x01')),
        status: 'open',
        placedAt: now,
      } as PublicDeveloperBet);
      return hash;
    },
    /** What chips on a round win once that round is revealed. */
    owed(id: string, chips: Chips = { red: 100n }) {
      const round = view(id);
      return payouts(chips).get(pocket(outcome([], round.seed!, round.secret!).value)) ?? 0n;
    },
    advance: (ms: number) => (now += ms),
    fail: (error: any) => (failing = error),
    loseReplies: (value: boolean) => (lose = value),
    declining: (value: boolean) => (decline = value),
  };
}

test('an empty table waits; the first bet starts the clock; the spin covers every layout with one casino bet', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.deepEqual([first.closesAt, first.players], [null, 0]);
  assert.match(first.round!, /^0x[0-9a-f]{64}$/, 'the table names the round to bet on');
  assert.equal(first.seedHash, await t.deps.developer.seedHash(first.round!), 'and the hash of its seed');
  assert.equal(t.saves.at(-1)!.round, first.round, 'saved before anybody is told of it');
  t.advance(60_000);
  assert.equal((await t.wheel.view()).closesAt, null, 'nobody is in, so nothing spins');
  assert.ok(!t.calls.includes('casinoBet'));
  // A page says its wallet placed a bet; the wheel believes the casino, not the page.
  const placedAt = t.deps.now();
  const a = t.bet({ uname: 'a', chips: { red: 250n } }),
    b = t.bet({ uname: 'a', chips: { '17': 50n } });
  t.bet({ uname: 'b', asset: 'eth' });
  const placed = await t.wheel.placed();
  assert.deepEqual([placed.players, placed.staked], [1, '300'], 'only the bets on its own round, in its own asset');
  assert.equal(placed.closesAt, placedAt + BETTING_MS, 'twenty seconds after the first bet, by the casino');
  assert.equal(t.wakes.at(-1), placed.closesAt, 'and on time whether or not anybody asks');
  t.advance(BETTING_MS - 1);
  await t.wheel.view();
  assert.ok(!t.calls.includes('casinoBet'), 'not a moment early');
  t.advance(1);
  await t.wheel.alarm();
  assert.deepEqual(t.casinoBets, [{ covered: coveredHash([a, b]) }], 'one casino bet for the whole table');
  assert.deepEqual(
    [t.paid.get(a), t.paid.get(b)],
    [t.owed(first.round!, { red: 250n }), t.owed(first.round!, { '17': 50n })],
    'each is paid what its chips win where the ball landed',
  );
  const after = await t.wheel.view();
  assert.deepEqual([after.closesAt, after.players], [null, 0], 'and the table is empty again');
  assert.notEqual(after.round, first.round, 'with a new round to bet on');
  // Anyone can check the spin: the bets it covered hash to its casino bet's meta, on the seed published before them.
  const kept = (await t.wheel.kept(first.round!))!;
  assert.deepEqual([kept.round, kept.covered, kept.accepted], [first.round, [a, b], true]);
  assert.equal(kept.number, pocket(outcome([], kept.seed, kept.secret).value));
  assert.equal(coveredHash(kept.covered), t.casinoBets[0]!.covered);
  assert.equal(seedHash(kept.seed), first.seedHash);
});

test("a bet that is not a roulette layout on the table's seed is not covered, and gets its stake back", async () => {
  const t = table();
  const { round } = await t.wheel.view();
  const fair = t.bet(),
    // Chips that pay more than its stake could: the wheel does not cover a table a player signed themselves.
    greedy = t.bet({ stake: '1' }),
    unknown = t.bet({ meta: { seedHash: (await t.wheel.view()).seedHash, chips: { '37': '100' } } }),
    elsewhere = t.bet({ meta: { seedHash: seedHash(keccak256('0x02')), chips: { red: '100' } } });
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  assert.deepEqual(t.casinoBets, [{ covered: coveredHash([fair]) }]);
  assert.deepEqual(
    [t.paid.get(fair), t.paid.get(greedy), t.paid.get(unknown), t.paid.get(elsewhere)],
    [t.owed(round!), 1n, 100n, 100n],
  );
});

test('a bet that comes after its spin, or on a spin the bankroll declines, gets its stake back', async () => {
  const t = table();
  const { round } = await t.wheel.view();
  t.bet();
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  // Signed while the round was open, it reached the casino after the spin.
  const late = t.bet({ round: round! });
  t.advance(1000);
  await t.wheel.view();
  assert.equal(t.paid.get(late), 100n);
  // The bankroll will not take the table's casino bet: the round is revealed, and every stake comes back.
  t.declining(true);
  const declined = t.bet();
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  assert.equal(t.paid.get(declined), 100n);
});

test('the casino is asked about bets at most once a second, however many pages are watching', async () => {
  const t = table();
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 1);
  t.advance(1000);
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 2);
});

test('a failed spin is tried again, and places the same casino bet', async () => {
  const t = table();
  const { round } = await t.wheel.view();
  const bets = ['a', 'b', 'c', 'd'].map(uname => t.bet({ uname }));
  await t.wheel.placed();
  t.advance(BETTING_MS);
  t.fail(new Error('casino unavailable'));
  await assert.rejects(t.wheel.alarm(), /casino unavailable/);
  assert.ok(t.wakes.at(-1)! > t.deps.now(), 'it asks to be woken again');
  t.fail(null);
  await t.wheel.alarm();
  assert.deepEqual(t.casinoBets, [{ covered: coveredHash(bets) }], 'every bet on the round rode the one spin');
  assert.deepEqual((await t.wheel.kept(round!))!.covered, bets);
});

test('a spin tried again places the casino bet with the bets it saved, and a bet that came meanwhile is not covered', async () => {
  const t = table();
  const { round } = await t.wheel.view();
  const a = t.bet({ uname: 'a' });
  await t.wheel.placed();
  t.advance(BETTING_MS);
  t.fail(new Error('casino unavailable'));
  await assert.rejects(t.wheel.alarm(), /casino unavailable/);
  assert.deepEqual(t.saves.at(-1)!.covered, [a], 'the bets it covers are saved before the casino bet is placed');
  const late = t.bet({ uname: 'late' });
  t.fail(null);
  await t.wheel.alarm();
  assert.deepEqual(t.casinoBets, [{ covered: coveredHash([a]) }], 'the same casino bet');
  assert.deepEqual((await t.wheel.kept(round!))!.covered, [a]);
  assert.deepEqual([t.paid.get(a), t.paid.get(late)], [t.owed(round!), 100n]);
});

test('a wheel woken on a saved round with no bets covered yet works out its seed hash and takes bets on it', async () => {
  const t = table();
  const { round } = await t.wheel.view();
  const woken = new Wheel(t.deps, { round: round!, covered: null });
  const view = await woken.view();
  assert.deepEqual([view.round, view.seedHash], [round, await t.deps.developer.seedHash(round!)]);
  const a = t.bet();
  await woken.placed();
  t.advance(BETTING_MS);
  await woken.alarm();
  assert.deepEqual(t.casinoBets, [{ covered: coveredHash([a]) }]);
});

test('a casino bet whose reply was lost is found on the round the wheel saved, even after a restart', async () => {
  const t = table();
  const opened = await t.wheel.view();
  const a = t.bet({ uname: 'a' });
  await t.wheel.placed();
  t.advance(BETTING_MS);
  t.loseReplies(true);
  await assert.rejects(t.wheel.alarm(), /reply lost/);
  t.loseReplies(false);
  // The Durable Object is evicted: a new wheel starts from what the old one saved. The round it saved is revealed,
  // so it keeps the spin with the bets it saved, pays the bet on it and moves on.
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  const view = await woken.view();
  assert.notEqual(view.round, opened.round);
  assert.equal(t.paid.get(a), t.owed(opened.round!));
  assert.deepEqual((await woken.kept(opened.round!))!.covered, [a]);
  assert.equal(t.casinoBets.length, 1, 'placed once');
});

test('a wheel whose saved round the casino does not know moves on to a new round', async () => {
  const t = table();
  const lost = '0x' + 'e'.repeat(64),
    woken = new Wheel(t.deps, { round: lost, covered: null });
  const view = await woken.view();
  assert.notEqual(view.round, lost);
  assert.equal(await woken.kept(lost), null, 'a round the casino lost has no spin to keep');
  assert.equal(t.saves.at(-1)!.round, view.round, 'and the new round is saved');
});
