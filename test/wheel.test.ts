import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { betPayout, outcome, seedHash } from '@hookedin/play/sdk/outcome';
import { priceSteps, stepOutcome, stepsCash } from '@hookedin/play/sdk/steps';
import type { Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { BETTING_MS, HEARTBEAT_MS, RETRY_MS, Wheel } from '../server/wheel.ts';
import type { Spin, TableView, WheelState } from '../server/wheel.ts';
import { ORDER, coveredHash, owedOn, payouts, spinId, stepOf, wireChips } from '../src/table.ts';
import type { Chips } from '../src/table.ts';

const VIRTUAL_BANKROLL = 10n ** 9n;

/** A casino that does what the developer kit asks, with the developer's bank and a clock the test turns. Its rounds'
 * secrets are numbered from `first`. */
function table(first = 0) {
  let now = 1_000_000,
    count = first,
    failing: any = null,
    lose = false,
    decline = false,
    failRead = false,
    watching = false,
    looks = 0,
    bank = 0n,
    bankroll = VIRTUAL_BANKROLL,
    placed = () => {};
  // The developer's rounds, each the hash of a secret, and the seed of its casino bet on it.
  const secret = (n: number) => keccak256('0x' + n.toString(16).padStart(64, '0')),
    seedOf = (id: string) => keccak256(id),
    rounds = new Map<string, { secret: string; createdAt: number; casinoBet?: Round['casinoBet'] }>();
  const view = (id: string): Round => {
    const round = rounds.get(id)!,
      seed = seedOf(id);
    return structuredClone({
      id,
      developer: '0x' + 'a'.repeat(40),
      createdAt: round.createdAt,
      status: round.casinoBet ? 'revealed' : 'open',
      ...(round.casinoBet
        ? { seed, secret: round.secret, outcome: String(outcome(seed, round.secret).value), casinoBet: round.casinoBet }
        : {}),
    });
  };
  const open = new Map<string, PublicDeveloperBet>(),
    // Where each bet is in the order the casino took them.
    order = new Map<string, number>(),
    paid = new Map<string, bigint>(),
    calls: string[] = [],
    saves: WheelState[] = [],
    spins = new Map<string, Spin>(),
    wakes: number[] = [],
    shown: TableView[] = [];
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
    async openRound() {
      const id = keccak256(secret(++count));
      rounds.set(id, { secret: secret(count), createdAt: Date.now() });
      return view(id);
    },
    seedHash: async (id: string) => seedHash(seedOf(id)),
    virtualBankroll: async () => bankroll,
    async round(id: string) {
      looks++;
      // A round the casino never named, or lost with its row, is unknown to it.
      if (!rounds.has(id)) throw Object.assign(new Error('Unknown round'), { status: 404 });
      return view(id);
    },
    // Open bets in the order they were placed, after the cursor; with `wait`, a read with none waits for the next.
    async bets({ after = '', wait = 0 }: { after?: string; wait?: number } = {}) {
      calls.push(`bets after ${after || "''"}${wait ? ' waiting' : ''}`);
      if (failRead) {
        failRead = false;
        throw new Error('Casino unavailable');
      }
      const page = () => {
        const bets = [...open.values()].filter(bet => order.get(bet.bet)! > Number(after || '0'));
        return {
          bets: structuredClone(bets),
          cursor: String(bets.length ? order.get(bets.at(-1)!.bet) : after || '0'),
          more: false,
        };
      };
      if (wait && !page().bets.length) await new Promise<void>(resolve => (placed = resolve));
      return page();
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
    show: (view: TableView) => void shown.push(view),
    watched: () => watching,
  };
  const wheel = new Wheel(deps);
  const x = {
    deps,
    calls,
    paid,
    saves,
    rounds,
    wakes,
    shown,
    wheel,
    /** How often the wheel asked the casino about a round. */
    looks: () => looks,
    /** Whether a page watches the table. One that stops watching ends a read the wheel is waiting on. */
    watch: (value: boolean) => {
      watching = value;
      if (!value) placed();
    },
    /** The casino answers the read the wheel is waiting on, with no bet: another wait on the game began. */
    answer: () => placed(),
    /** The casino fails the wheel's next read. */
    failNextRead: () => void (failRead = true),
    /** The casino reads bets: how often. */
    reads: () => calls.filter(call => call.startsWith('bets')),
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
      order.set(hash, order.size + 1);
      bank += BigInt(stake);
      placed();
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
    /** The casino reports this virtual bankroll. */
    bankroll: (value: bigint) => (bankroll = value),
    /** Spin: the wheel reads the bets, then waits out the betting time and lets the alarm fire. */
    async spin() {
      await wheel.read();
      now += BETTING_MS;
      await wheel.tick();
    },
  };
  return x;
}

test('the wheel turns on its clock: an empty turn lands at random on the same spin, a turn with layouts walks and pays', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.deepEqual([first.closesAt, first.players, first.landed], [t.deps.now() + BETTING_MS, 0, []]);
  const opened = t.saves.at(-1)!.spin!;
  assert.equal(opened.id, first.spin, 'the spin is saved before anybody is told of it');
  assert.equal(opened.rounds.length, 6, 'a round for each level of a tree of 37 pockets');
  assert.deepEqual(opened.seedHashes, await Promise.all(opened.rounds.map(t.deps.developer.seedHash)));
  assert.equal(first.spin, spinId(opened.rounds, opened.seedHashes), 'and its ID commits to its rounds and seeds');
  // Nobody bets, and the turn comes: nothing rides on it, so the ball lands on a pocket drawn at random.
  t.advance(BETTING_MS);
  const empty = await t.wheel.view();
  assert.deepEqual([empty.landed.length, empty.landed[0]!.at, empty.landed[0]!.spin], [1, t.deps.now(), null]);
  assert.ok(ORDER.includes(empty.landed[0]!.number));
  assert.deepEqual(
    [empty.spin, empty.closesAt],
    [first.spin, t.deps.now() + BETTING_MS],
    'its spin takes the next turn',
  );
  assert.ok(!t.calls.includes('casinoBet') && !t.calls.includes('reveal'), 'no round is revealed');
  assert.equal(await t.wheel.kept(first.spin!), null, 'and nothing is kept');
  assert.deepEqual(t.wakes, [], 'nor is the wheel woken: nobody is in');
  // The wheel reads the bets the casino took.
  const layouts: Chips[] = [{ red: 250n }, { '17': 50n }],
    a = t.bet({ uname: 'a', chips: layouts[0] }),
    b = t.bet({ uname: 'a', chips: layouts[1] });
  t.bet({ uname: 'b', spin: 'f'.repeat(64) });
  await t.wheel.read();
  const placed = await t.wheel.view();
  assert.deepEqual([placed.players, placed.staked], [1, '300'], 'only the bets on its own spin');
  assert.equal(placed.closesAt, empty.closesAt, 'bets do not move the turn');
  assert.equal(t.wakes.at(-1), placed.closesAt, 'which comes on time whether or not anybody asks');
  t.advance(BETTING_MS - 1);
  await t.wheel.view();
  assert.ok(!t.calls.includes('casinoBet'), 'not a moment early');
  t.advance(1);
  await t.wheel.tick();
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
  assert.equal(t.bank(), 300n - stepsCash(priceSteps(owedOn(layouts), VIRTUAL_BANKROLL)));
  assert.ok(t.bank() >= 0n, 'and the stakes paid for it');
  const after = await t.wheel.view();
  assert.deepEqual([after.closesAt, after.players], [t.deps.now() + BETTING_MS, 0], 'the table is empty again');
  assert.notEqual(after.spin, first.spin, 'with a new spin to bet on');
  assert.deepEqual(after.landed[0], { at: t.deps.now(), number, spin: first.spin }, 'and the landing in the strip');
});

test('a bet that reaches the casino after a turn nobody bet on rides the next turn of the same spin', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  t.advance(BETTING_MS);
  await t.wheel.view();
  // Signed while the turn took bets, it reached the casino after the ball landed.
  const late = t.bet({ spin: spin! });
  await t.wheel.read();
  const placed = await t.wheel.view();
  assert.deepEqual([placed.spin, placed.players], [spin, 1]);
  t.advance(BETTING_MS);
  await t.wheel.tick();
  const kept = (await t.wheel.kept(spin!))!;
  assert.deepEqual(kept.covered, [late]);
  assert.equal(t.paid.get(late), payouts({ red: 100n }).get(kept.number) ?? 0n);
});

test('a wheel nobody watched lands the turn it missed when somebody looks, and opens the next', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  t.advance(3_600_000);
  const later = await t.wheel.view();
  assert.deepEqual([later.spin, later.closesAt, later.landed.length], [spin, t.deps.now() + BETTING_MS, 1]);
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
    assert.equal(t.bank(), 145n - stepsCash(priceSteps(owedOn(layouts), VIRTUAL_BANKROLL)));
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

test('a turn of no layouts lands at random, and gives back what else is in its group', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  const unknown = t.bet({ meta: { chips: { '37': '100' } } });
  await t.spin();
  assert.equal(t.paid.get(unknown), 100n);
  assert.deepEqual([t.calls.includes('casinoBet'), t.calls.includes('reveal')], [false, false], 'no step taken');
  const view = await t.wheel.view();
  assert.deepEqual([view.spin, view.landed[0]!.spin], [spin, null], 'the same spin takes the next bets');
});

test('a bet that comes after its spin gets its stake back', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  t.bet();
  await t.spin();
  // Signed while the spin was open, it reached the casino after it.
  const late = t.bet({ spin: spin! });
  t.advance(1000);
  await t.wheel.read();
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

test('a walk priced while the casino has no bankroll goes on to its pocket, and pays', async () => {
  const t = table();
  await t.wheel.view();
  const a = t.bet({ chips: { '17': 100n } });
  t.bankroll(0n);
  // The casino declines whatever the developer's bank can pay.
  t.declining(true);
  await t.spin();
  const kept = [...t.saves].reverse().find(s => s.walk)!,
    spin = (await t.wheel.kept(kept.spin!.id))!;
  assert.equal(spin.number, t.walked(spin).number);
  assert.equal(t.paid.get(a), payouts({ '17': 100n }).get(spin.number) ?? 0n);
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

test('however often pages look, the wheel asks the casino nothing: it checks its spin once a start', async () => {
  const t = table();
  await t.wheel.view();
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  for (let i = 0; i < 20; i++) await woken.view();
  assert.deepEqual([t.reads().length, t.looks()], [0, 1]);
});

test('a watching page is shown each change and a heartbeat, and the wheel follows the bets placed while it waits', async () => {
  const t = table();
  t.watch(true);
  await t.wheel.view();
  assert.equal(t.wakes.at(-1), t.deps.now() + HEARTBEAT_MS, 'a watched wheel wakes for its heartbeat');
  const shown = t.shown.length;
  await t.wheel.view();
  assert.equal(t.shown.length, shown, 'a look changes nothing, so nothing is shown');
  await t.wheel.tick();
  assert.equal(t.shown.length, shown + 1, 'the heartbeat shows the table either way');
  const following = t.wheel.follow();
  await new Promise(resolve => setTimeout(resolve, 10));
  t.bet({ uname: 'a' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([t.shown.at(-1)!.players, t.shown.at(-1)!.staked], [1, '100'], 'the bet is shown as it comes');
  t.watch(false);
  await following;
});

test('a watched table’s heartbeat comes a heartbeat after it was last shown, whatever else asks it meanwhile', async () => {
  const t = table();
  t.watch(true);
  await t.wheel.tick();
  const shown = t.deps.now();
  t.advance(2_000);
  await t.wheel.view();
  assert.equal(t.wakes.at(-1), shown + HEARTBEAT_MS, 'looks that show nothing do not put it off');
});

test('a wheel woken with nobody watching reads its bets, so a restarted one takes the turn somebody bet on on time', async () => {
  const t = table();
  const { closesAt } = await t.wheel.view();
  t.bet();
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  await woken.tick();
  assert.equal(t.wakes.at(-1), closesAt, 'it knows the table only the casino told it of');
});

test('a wheel whose spin the casino lost, as after a restore of its records, moves on and gives the bets on it back', async () => {
  const t = table();
  const { spin } = await t.wheel.view();
  const a = t.bet();
  await t.wheel.read();
  for (const round of t.saves.at(-1)!.spin!.rounds) t.rounds.delete(round);
  t.advance(BETTING_MS);
  await assert.rejects(t.wheel.tick(), /Unknown round/);
  t.advance(RETRY_MS);
  await t.wheel.tick();
  assert.notEqual((await t.wheel.view()).spin, spin);
  await t.wheel.read();
  assert.equal(t.paid.get(a), 100n);
});

test('a follower whose wait comes back empty early backs off, and after a failed read starts from the oldest open bet', async t => {
  t.mock.method(console, 'error', () => {});
  const x = table(),
    pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  x.watch(true);
  await x.wheel.view();
  x.bet();
  const following = x.wheel.follow();
  await pause(20);
  assert.equal(x.reads().at(-1), 'bets after 1 waiting', 'it waits on from the bet it read');
  const reads = x.reads().length;
  x.answer();
  await pause(100);
  assert.equal(x.reads().length, reads, 'another server took the wait: it backs off before asking again');
  x.failNextRead();
  await pause(2 * RETRY_MS + 200);
  assert.deepEqual(x.reads().slice(reads), ['bets after 1 waiting', "bets after '' waiting", 'bets after 1 waiting']);
  x.watch(false);
  await following;
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
  await t.wheel.tick();
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
  await woken.tick();
  const kept = (await woken.kept(spin!))!;
  assert.equal(t.paid.get(a), payouts({ '17': 100n }).get(kept.number) ?? 0n);
  assert.equal(t.walked(kept).number, kept.number);
  assert.equal(
    t.calls.filter(call => !call.startsWith('bets')).length,
    t.walked(kept).steps.length,
    'each step placed once',
  );
});

test('a wheel whose saved spin the casino does not know moves on to a new one', async () => {
  const t = table();
  const lost = { id: 'e'.repeat(64), rounds: ['0x' + 'e'.repeat(64)], seedHashes: ['0x' + 'e'.repeat(64)] },
    woken = new Wheel(t.deps, { spin: lost, walk: null, closesAt: null, landed: [] });
  const view = await woken.view();
  assert.notEqual(view.spin, lost.id);
  assert.equal(t.saves.at(-1)!.spin!.id, view.spin, 'and the new spin is saved');
});
