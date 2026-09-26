import test from 'node:test';
import assert from 'node:assert/strict';
import { admits } from '@hookedin/play/sdk/admits';
import { bet, covers, layout, payouts, pocket, returns, together, wireChips, RED, WHEEL } from '../src/table.ts';
import type { Chips } from '../src/table.ts';
import { betReturn } from '@hookedin/play/sdk/admits';

const SPACE = 1n << 64n,
  SPOTS = [
    ...Array.from({ length: 37 }, (_, n) => String(n)),
    ...['red', 'black', 'odd', 'even', 'low', 'high'],
    ...[1, 2, 3].flatMap(k => [`dozen:${k}`, `column:${k}`]),
  ];
/** What a wire bet pays for an outcome: every prize whose range holds it. */
const pays = (wire: ReturnType<typeof bet>, outcome: bigint) =>
  wire.prizes.reduce(
    (sum, p) => (outcome >= BigInt(p.rangeStart) && outcome < BigInt(p.rangeEnd) ? sum + BigInt(p.payout) : sum),
    0n,
  );
/** One outcome in the middle of each number's stretch, found by asking where every outcome lands. */
const sample = new Map<number, bigint>();
for (let i = 0n; i < 37n; i++) sample.set(pocket((SPACE / 37n) * i + 5n), (SPACE / 37n) * i + 5n);

test('every outcome is a pocket, and the wheel holds each number once', () => {
  assert.equal(sample.size, 37);
  assert.deepEqual(
    [...WHEEL].sort((a, b) => a - b),
    Array.from({ length: 37 }, (_, n) => n),
  );
  assert.equal(RED.size, 18);
  // Zero takes the few outcomes that 37 does not divide, so nothing falls outside the wheel.
  assert.equal(pocket(SPACE - 1n), 0);
  assert.equal(pocket(0n), 1);
});

test('each spot covers what the felt says and returns 36 for the numbers it covers', () => {
  for (const spot of SPOTS) assert.equal(returns(spot) * BigInt(covers(spot).length), 36n, spot);
  assert.deepEqual(covers('dozen:2'), [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.deepEqual(covers('column:3'), [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);
  assert.ok(covers('red').every(n => RED.has(n)) && !covers('black').some(n => RED.has(n)));
  assert.ok(
    !['red', 'black', 'odd', 'even', 'low', 'high'].some(spot => covers(spot).includes(0)),
    'zero is the house',
  );
  assert.throws(() => covers('37'), /Unknown spot/);
  assert.throws(() => covers('dozen:4'), /Unknown spot/);
});

test('a layout is one bet that pays, for every number, exactly what its chips say', () => {
  const chips = { '17': 5n, red: 100n, odd: 40n, 'dozen:2': 30n, 'column:2': 30n, '0': 2n, high: 10n },
    wire = bet(chips),
    expected = payouts(chips);
  assert.equal(wire.stake, '217');
  assert.ok(wire.prizes.length <= 37, 'neighbouring numbers that pay the same share a prize');
  for (const [number, outcome] of sample) assert.equal(pays(wire, outcome), expected.get(number) ?? 0n, String(number));
  // 17 is black, odd, in the second dozen and the second column: every chip on it pays together, and red does not.
  assert.equal(pays(wire, sample.get(17)!), 5n * 36n + 40n * 2n + 30n * 3n + 30n * 3n);
  assert.equal(pays(wire, sample.get(0)!), 72n);
  // Low and high together are one prize over all 36 numbers.
  assert.equal(bet({ low: 1n, high: 1n }).prizes.length, 1);
  assert.equal(bet({}).prizes.length, 0);
});

test("every spot has the wheel's 1 in 37 edge and is a bet the casino's own rule admits", () => {
  const stake = 10n ** 15n,
    bankroll = 1000n * 10n ** 18n;
  for (const spot of SPOTS) {
    const wire = bet({ [spot]: stake }),
      expected = wire.prizes.reduce(
        (sum, p) => sum + BigInt(p.payout) * (BigInt(p.rangeEnd) - BigInt(p.rangeStart)),
        0n,
      );
    // Expected return is 36/37 of the stake, but for the handful of outcomes 37 does not divide.
    const exact = (stake * 36n * SPACE) / 37n,
      slack = stake * 36n * 37n;
    assert.ok(expected <= exact + slack && expected >= exact - slack, spot);
    assert.ok(
      admits(bankroll, {
        stake,
        prizes: wire.prizes.map(p => ({
          rangeStart: BigInt(p.rangeStart),
          rangeEnd: BigInt(p.rangeEnd),
          payout: BigInt(p.payout),
        })),
      }),
      spot,
    );
  }
});

/** The least any one bet of this game pays back, in millionths of its stake. The game publishes no
 * such figure — a promise nobody can verify is worth nothing, because no game bounds how often it
 * wagers what it holds — but its own table is held to it here, and every player sees the measured
 * return of each bet they actually signed. */
const FLOOR = 972900n;

test('every chip and every layout pays back at least the floor this game is built to', () => {
  const terms = (wire: ReturnType<typeof bet>) => ({
    stake: BigInt(wire.stake),
    prizes: wire.prizes.map(prize => ({
      rangeStart: BigInt(prize.rangeStart),
      rangeEnd: BigInt(prize.rangeEnd),
      payout: BigInt(prize.payout),
    })),
  });
  for (const stake of [1000n, 10n ** 6n, 10n ** 9n, 12345678901n, 10n ** 12n, 10n ** 15n, 10n ** 18n]) {
    for (const spot of SPOTS)
      assert.ok(
        betReturn(terms(bet({ [spot]: stake }))) >= FLOOR,
        `${spot} for ${stake} wei pays back less than this game's floor`,
      );
    // A layout of several chips is one bet, and it meets the same statement.
    assert.ok(betReturn(terms(bet({ '17': stake, red: stake, 'dozen:2': stake, '0': stake }))) >= FLOOR);
  }
});

test('the wheel covers only layouts, and a table of them is one bet paying each number what they all pay there', () => {
  const layouts: Chips[] = [{ red: 100n, '17': 10n }, { black: 50n, 'dozen:2': 20n }, { '0': 5n }];
  for (const chips of layouts) assert.deepEqual(layout(wireChips(chips), bet(chips).stake), chips);
  const table = together(layouts);
  assert.equal(table.stake, '185');
  for (const [n, outcome] of sample)
    assert.equal(
      pays(table, outcome),
      layouts.reduce((sum, chips) => sum + pays(bet(chips), outcome), 0n),
      `number ${n}`,
    );
  // Chips that are not on the felt, are not whole, or do not add up to the bet's stake are no layout: the wheel does
  // not cover a table a player signed themselves.
  assert.equal(layout({ '37': '100' }, '100'), null);
  assert.equal(layout({ red: '1.5' }, '1'), null);
  assert.equal(layout({ red: '0' }, '0'), null);
  assert.equal(layout({ red: '100' }, '1'), null);
  assert.equal(layout(['100'], '100'), null);
});
