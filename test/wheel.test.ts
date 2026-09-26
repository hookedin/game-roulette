import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { betPayout, outcome, seedHash } from '@hookedin/play/sdk/outcome';
import { priceSteps, stepOutcome, stepsCash } from '@hookedin/play/sdk/steps';
import type { Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { BETTING_MS, Wheel } from '../server/wheel.ts';
import type { Spin, WheelState } from '../server/wheel.ts';
import { ORDER, coveredHash, owedOn, payouts, spinId, stepOf, wireChips } from '../src/table.ts';
import type { Chips } from '../src/table.ts';

const BANKROLL = 10n ** 9n;

/** A casino that does what the developer kit asks, with the developer's bank and a clock the test turns. Its rounds'
 * secrets are numbered from `first`. */
function table(first = 0) {
  let now = 1_000_000,
    count = first,
    failing: any = null,
    lose = false,
    decline = false,
    bank = 0n;
  // The developer's rounds, each the hash of a secret, and the seed of its casino bet on it.
  const secret = (n: number) => keccak256('0x' + n.toString(16).padStart(64, '0')),
    seedOf = (id: string) => keccak256(id),
    rounds = new Map<string, { secret: string; casinoBet?: Round['casinoBet'] }>();
  const view = (id: string): Round => {
    const round = rounds.get(id)!,
      seed = seedOf(id);
    return structuredClone({
      id,
      developer: '0x' + 'a'.repeat(40),
      status: round.casinoBet ? 'revealed' : 'open',
      ...(round.casinoBet
        ? { seed, secret: round.secret, outcome: String(outcome(seed, round.secret).value), casinoBet: round.casinoBet }
        : {}),
    });
  };
  const open = new Map<string, PublicDeveloperBet>(),
    paid = new Map<string, bigint>(),
    calls: string[] = [],
    saves: WheelState[] = [],
    spins = new Map<string, Spin>(),
    wakes: number[] = [];
  /** The developer's casino bet on its round, or a reveal: taken from its bank when the bankroll takes it. */
  const place = async ({ round: id, stake, chance, prize, group, meta }: any) => {
    calls.push(stake === '0' ? 'reveal' : 'casinoBet');
    if (failing) throw failing;
    const round = rounds.get(id)!;
    if (!round.casinoBet) {
      if (BigInt(stake) > bank) throw Object.assign(new Error('The bank cannot pay the stake'), { code: 'bank-short' });
      const accepted = stake !== '0' && !decline,
        pays = accepted ? betPayout({ chance, prize }, outcome(seedOf(id), round.secret).value) : 0n;
      if (accepted) bank += pays - BigInt(stake);
      round.casinoBet = {
        game: '0x',
        stake,
        chance,
        prize,
        group,
        meta,
        signature: '0x',
        accepted,
        ...(accepted ? { payout: String(pays) } : {}),
      };
    }
    // The casino took it, and the reply never came back.
    if (lose) throw new Error('reply lost');
    return view(id);
  };
  const developer = {
    address: '0x' + 'a'.repeat(40),
    async openRound() {
      const id = keccak256(secret(++count));
      rounds.set(id, { secret: secret(count) });
      return view(id);
    },
    seedHash: async (id: string) => seedHash(seedOf(id)),
    bankroll: async () => BANKROLL,
    async round(id: string) {
      // A round the casino never named, or lost with its row, is unknown to it.
      if (!rounds.has(id)) throw Object.assign(new Error('Unknown round'), { status: 404 });
      return view(id);
    },
    async bets() {
      calls.push('bets');
      return { bets: structuredClone([...open.values()]), cursor: '', more: false };
    },
    casinoBet: (bet: any) =>
      place({ ...bet, stake: String(bet.stake), chance: String(bet.chance), prize: String(bet.prize) }),
    reveal: (bet: any) => place({ ...bet, stake: '0', chance: '0', prize: '0' }),
    async settle(settlements: { bet: string; player: bigint }[]) {
      for (const { bet, player } of settlements) {
        paid.set(bet, player);
        bank -= player;
        open.delete(bet);
      }
      return [];
    },
  } as unknown as Developer;
  const deps = {
    developer,
    now: () => now,
    save: (s: WheelState) => void saves.push(structuredClone(s)),
    keep: (spin: Spin) => void spins.set(spin.id, structuredClone(spin)),
    kept: (id: string) => spins.get(id) ?? null,
    wake: (at: number) => void wakes.push(at),
  };
  const wheel = new Wheel(deps);
  const x = {
    deps,
    calls,
    paid,
    saves,
    rounds,
    wakes,
    wheel,
    bank: () => bank,
    /** The developer takes everything out of its bank. */
    empty: () => void (bank = 0n),
    /** A player's wallet places a developer bet in the group of the spin its page named, with its chips in its meta:
     * its stake goes to the developer's bank, and the casino records when. */
    bet({
      uname = 'p',
      chips = { red: 100n },
      spin = wheel.state.spin!.id,
      stake = String(Object.values(chips).reduce((sum, amount) => sum + amount, 0n)),
      meta = { chips: wireChips(chips) },
    }: {
      uname?: string;
      chips?: Chips;
      spin?: string;
      stake?: string;
      meta?: Record<string, unknown>;
    } = {}) {
      const hash = '0x' + String(open.size + paid.size + 1).padStart(64, '0');
      open.set(hash, { bet: hash, uname, stake, meta, group: spin, status: 'open', placedAt: now } as any);
      bank += BigInt(stake);
      return hash;
    },
    /** The steps of a kept spin as the casino shows them, and the number they walk to, as a page checks them. */
    walked(spin: Spin) {
      const steps = spin.rounds.filter(id => rounds.get(id)?.casinoBet).map(id => view(id));
      for (const round of steps) assert.equal(round.casinoBet!.group, spin.id, "every step is in the spin's group");
      return {
        steps,
        number:
          ORDER[
            stepOutcome(
              ORDER.length,
              steps.map(round => stepOf(round)),
            )
          ]!,
      };
    },
    advance: (ms: number) => (now += ms),
    fail: (error: any) => (failing = error),
    loseReplies: (value: boolean) => (lose = value),
    declining: (value: boolean) => (decline = value),
    /** Spin: wait out the betting time and let the alarm fire. */
    async spin() {
      await wheel.placed();
      now += BETTING_MS;
      await wheel.alarm();
    },
  };
  return x;
}

test('an empty table waits; the first bet starts the clock; the walk pays every layout what it wins on its pocket', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.deepEqual([first.closesAt, first.players], [null, 0]);
  const opened = t.saves.at(-1)!.spin!;
  assert.equal(opened.id, first.spin, 'the spin is saved before anybody is told of it');
  assert.equal(opened.rounds.length, 6, 'a round for each level of a tree of 37 pockets');
  assert.deepEqual(opened.seedHashes, await Promise.all(opened.rounds.map(t.deps.developer.seedHash)));
  assert.equal(first.spin, spinId(opened.rounds, opened.seedHashes), 'and its ID commits to its rounds and seeds');
  t.advance(60_000);
  assert.equal((await t.wheel.view()).closesAt, null, 'nobody is in, so nothing spins');
  assert.ok(!t.calls.includes('casinoBet'));
  // A page says its wallet placed a bet; the wheel believes the casino, not the page.
  const placedAt = t.deps.now();
  const layouts: Chips[] = [{ red: 250n }, { '17': 50n }],
    a = t.bet({ uname: 'a', chips: layouts[0] }),
    b = t.bet({ uname: 'a', chips: layouts[1] });
  t.bet({ uname: 'b', spin: 'f'.repeat(64) });
  const placed = await t.wheel.placed();
  assert.deepEqual([placed.players, placed.staked], [1, '300'], 'only the bets on its own spin');
  assert.equal(placed.closesAt, placedAt + BETTING_MS, 'twenty seconds after the first bet, by the casino');
  assert.equal(t.wakes.at(-1), placed.closesAt, 'and on time whether or not anybody asks');
  t.advance(BETTING_MS - 1);
  await t.wheel.view();
  assert.ok(!t.calls.includes('casinoBet'), 'not a moment early');
  t.advance(1);
  await t.wheel.alarm();
  // Anyone can check the spin: its steps at the casino walk to its number, the first commits to the bets it covered,
  // and each is the round the spin named for its level, on the seed it named.
  const kept = (await t.wheel.kept(first.spin!))!,
    { steps, number } = t.walked(kept);
  assert.deepEqual([kept.id, kept.rounds, kept.covered, kept.number], [first.spin, opened.rounds, [a, b], number]);
  assert.ok(steps.length === 5 || steps.length === 6);
  assert.equal(steps[0]!.casinoBet!.meta.covered, coveredHash([a, b]));
  for (const [level, round] of steps.entries()) assert.equal(seedHash(round.seed!), opened.seedHashes[level]);
  assert.deepEqual(
    [t.paid.get(a), t.paid.get(b)],
    layouts.map(chips => payouts(chips).get(number) ?? 0n),
    'each is paid what its chips win where the ball landed',
  );
  // The walk hedged exactly: the bank keeps the stakes less the cash the walk needed, whichever pocket it reached.
  assert.equal(t.bank(), 300n - stepsCash(priceSteps(owedOn(layouts), BANKROLL / 2n)));
  assert.ok(t.bank() >= 0n, 'and the stakes paid for it');
  const after = await t.wheel.view();
  assert.deepEqual([after.closesAt, after.players], [null, 0], 'the table is empty again');
  assert.notEqual(after.spin, first.spin, 'with a new spin to bet on');
});

test('every pocket is reached, and the bank holds exactly what the table is owed on each', async () => {
  const layouts: Chips[] = [
      { red: 100n, '17': 10n },
      { 'dozen:2': 30n, '0': 5n },
    ],
    seen = new Set<number>();
  for (let spin = 0; spin < 120 && seen.size < 37; spin++) {
    const t = table(spin * 6);
    await t.wheel.view();
    const bets = layouts.map(chips => t.bet({ chips }));
    await t.spin();
    const kept = (await t.wheel.kept(t.saves.find(s => s.walk)!.spin!.id))!;
    seen.add(kept.number);
    assert.deepEqual(
      bets.map(bet => t.paid.get(bet)),
      layouts.map(chips => payouts(chips).get(kept.number) ?? 0n),
    );
    assert.equal(t.bank(), 145n - stepsCash(priceSteps(owedOn(layouts), BANKROLL / 2n)));
  }
  assert.ok(seen.size > 30, `${seen.size} pockets reached`);
});

test('a bet that is not a roulette layout on the spin is not covered, and gets its stake back', async () => {
  const t = table();
  await t.wheel.view();
  const fair = t.bet(),
    // Chips that pay more than its stake could: the wheel does not cover a table a player signed themselves.
    greedy = t.bet({ stake: '1' }),
    unknown = t.bet({ meta: { chips: { '37': '100' } } });
  await t.spin();
  const kept = [...t.saves].reverse().find(s => s.walk)!,
    spin = (await t.wheel.kept(kept.spin!.id))!;
  assert.deepEqual(spin.covered, [fair]);
  assert.deepEqual(
    [t.paid.get(fair), t.paid.get(greedy), t.paid.get(unknown)],
    [payouts({ red: 100n }).get(spin.number) ?? 0n, 1n, 100n],
  );
});

test('a table of no layouts waits for one, and gives back what else is in its group', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  const unknown = t.bet({ meta: { chips: { '37': '100' } } });
  await t.spin();
  assert.equal(t.paid.get(unknown), 100n);
  assert.deepEqual([t.calls.includes('casinoBet'), t.calls.includes('reveal')], [false, false], 'no step taken');
  assert.equal((await t.wheel.view()).spin, spin, 'the same spin takes the next bets');
});

test('a bet that comes after its spin gets its stake back', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  t.bet();
  await t.spin();
  // Signed while the spin was open, it reached the casino after it.
  const late = t.bet({ spin: spin! });
  t.advance(1000);
  await t.wheel.view();
  assert.equal(t.paid.get(late), 100n);
});

test('a step the bankroll declines still reveals its round, and the walk goes on to its pocket', async () => {
  const t = table();
  await t.wheel.view();
  const a = t.bet({ chips: { '17': 100n } });
  t.declining(true);
  await t.spin();
  const kept = [...t.saves].reverse().find(s => s.walk)!,
    spin = (await t.wheel.kept(kept.spin!.id))!,
    { steps, number } = t.walked(spin);
  assert.ok(
    steps.some(round => round.casinoBet!.stake !== '0' && !round.casinoBet!.accepted),
    'a step was declined',
  );
  assert.equal(spin.number, number, 'the walk went the way each signed step named');
  assert.equal(t.paid.get(a), payouts({ '17': 100n }).get(number) ?? 0n, 'and the bet is paid on its pocket');
});

test("a step whose stake the developer's bank cannot pay only reveals its round, and the walk goes on", async () => {
  const t = table();
  await t.wheel.view();
  // The developer takes the stake out of its bank, so the table's steps find it short.
  const a = t.bet({ chips: { '17': 100n } });
  t.empty();
  await t.spin();
  const kept = [...t.saves].reverse().find(s => s.walk)!,
    spin = (await t.wheel.kept(kept.spin!.id))!,
    { steps, number } = t.walked(spin);
  assert.ok(
    steps.every(round => round.casinoBet!.stake === '0'),
    'every step only revealed its round',
  );
  assert.equal(spin.number, number, 'each naming the left');
  assert.equal(t.paid.get(a), payouts({ '17': 100n }).get(number) ?? 0n);
});

test('the casino is asked about bets at most once a second, however many pages are watching', async () => {
  const t = table();
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 1);
  t.advance(1000);
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 2);
});

test('a failed walk is tried again with the bets it saved, and takes each step once', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  const bets = ['a', 'b', 'c', 'd'].map(uname => t.bet({ uname }));
  t.fail(new Error('casino unavailable'));
  await assert.rejects(t.spin(), /casino unavailable/);
  assert.ok(t.wakes.at(-1)! > t.deps.now(), 'it asks to be woken again');
  assert.deepEqual(t.saves.at(-1)!.walk!.covered, bets, 'the bets it covers are saved before its first step');
  const late = t.bet({ uname: 'late' });
  t.fail(null);
  await t.wheel.alarm();
  const kept = (await t.wheel.kept(spin!))!;
  assert.deepEqual(kept.covered, bets, 'a bet that came meanwhile is not covered');
  assert.equal(t.paid.get(late), 100n);
  assert.equal(t.walked(kept).number, kept.number);
});

test('a step whose reply was lost is found on its round, even after a restart', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  const a = t.bet({ uname: 'a', chips: { '17': 100n } });
  t.loseReplies(true);
  await assert.rejects(t.spin(), /reply lost/);
  t.loseReplies(false);
  // The Durable Object is evicted: a new wheel starts from what the old one saved, finds the step it placed on its
  // round, and walks on from there.
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  t.advance(1000);
  await woken.alarm();
  const kept = (await woken.kept(spin!))!;
  assert.equal(t.paid.get(a), payouts({ '17': 100n }).get(kept.number) ?? 0n);
  assert.equal(t.walked(kept).number, kept.number);
  assert.equal(t.calls.filter(call => call !== 'bets').length, t.walked(kept).steps.length, 'each step placed once');
});

test('a wheel whose saved spin the casino does not know moves on to a new one', async () => {
  const t = table();
  const lost = { id: 'e'.repeat(64), rounds: ['0x' + 'e'.repeat(64)], seedHashes: ['0x' + 'e'.repeat(64)] },
    woken = new Wheel(t.deps, { spin: lost, walk: null });
  const view = await woken.view();
  assert.notEqual(view.spin, lost.id);
  assert.equal(t.saves.at(-1)!.spin!.id, view.spin, 'and the new spin is saved');
});
