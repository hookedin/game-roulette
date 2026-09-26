import test from 'node:test';
import assert from 'node:assert/strict';
import { admits } from '@hookedin/play/sdk/admits';
import { children, priceSteps, stepBet, stepsCash } from '@hookedin/play/sdk/steps';
import type { StepNode } from '@hookedin/play/sdk/steps';
import type { Round } from '@hookedin/play/sdk/developer';
import {
  ORDER,
  RED,
  WHEEL,
  coveredHash,
  covers,
  layout,
  owedOn,
  payouts,
  returns,
  spinId,
  stepOf,
  wireChips,
} from '../src/table.ts';
import type { Chips } from '../src/table.ts';

const SPOTS = [
  ...Array.from({ length: 37 }, (_, n) => String(n)),
  ...['red', 'black', 'odd', 'even', 'low', 'high'],
  ...[1, 2, 3].flatMap(k => [`dozen:${k}`, `column:${k}`]),
];
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');

test('the wheel and the walk each hold every number once', () => {
  for (const order of [WHEEL, ORDER])
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      Array.from({ length: 37 }, (_, n) => n),
    );
  assert.equal(RED.size, 18);
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

test("every spot has the wheel's 1 in 37 edge: its chips are owed 36 times the stake over the 37 pockets", () => {
  for (const spot of SPOTS)
    assert.equal(
      owedOn([{ [spot]: 7n }]).reduce((sum, owed) => sum + owed, 0n),
      36n * 7n,
      spot,
    );
});

test('the wheel owes on each pocket what every layout it covers pays there, and nothing else', () => {
  const layouts: Chips[] = [
    { '17': 5n, red: 100n, odd: 40n, 'dozen:2': 30n, 'column:2': 30n, '0': 2n, high: 10n },
    { black: 50n, 'dozen:2': 20n },
  ];
  const owed = owedOn(layouts);
  for (const [i, n] of ORDER.entries())
    assert.equal(
      owed[i],
      layouts.reduce((sum, chips) => sum + (payouts(chips).get(n) ?? 0n), 0n),
      `number ${n}`,
    );
  // 17 is black, odd, in the second dozen and the second column: every chip on it pays together, and red does not.
  assert.equal(owed[ORDER.indexOf(17)], 5n * 36n + 40n * 2n + 30n * 3n + 30n * 3n + 50n * 2n + 20n * 3n);
  assert.equal(owed[ORDER.indexOf(0)], 72n);
  assert.deepEqual(
    owedOn([]),
    ORDER.map(() => 0n),
  );
});

test("a walk over any table is one the casino takes, and a large enough bankroll leaves the table's stakes enough", () => {
  const stake = 10n ** 15n;
  for (const layouts of [
    [{ red: stake }],
    [{ '17': stake }],
    [{ '17': stake, red: stake, 'dozen:2': stake, '0': stake }],
    SPOTS.map(spot => ({ [spot]: stake })),
  ] as Chips[][]) {
    const bankroll = 10n ** 6n * stake,
      plan = priceSteps(owedOn(layouts), bankroll),
      staked = layouts.reduce((sum, chips) => sum + Object.values(chips).reduce((a, b) => a + b, 0n), 0n);
    assert.ok(stepsCash(plan) <= staked, 'the bank needs no money of its own');
    const visit = (node: StepNode) => {
      if (node.hi - node.lo < 2) return;
      const bet = stepBet(plan, node);
      if (bet) assert.ok(admits(bankroll, bet));
      children(node).forEach(visit);
    };
    visit({ lo: 0, hi: ORDER.length });
  }
});

test('a spin commits to its rounds and seeds, and its steps read from the casino as a verifier takes them', () => {
  const rounds = [1, 2, 3].map(hash),
    seeds = [4, 5, 6].map(hash),
    id = spinId(rounds, seeds);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(spinId([...rounds.slice(0, 2), hash(9)], seeds), id, 'another round is another spin');
  assert.notEqual(spinId(rounds, [...seeds.slice(0, 2), hash(9)]), id, 'and another seed');
  assert.notEqual(coveredHash([hash(1), hash(2)]), coveredHash([hash(2), hash(1)]), 'the covered bets in order');
  const revealed = (stake: string, meta: Record<string, unknown>) =>
    ({
      outcome: '42',
      casinoBet: { stake, chance: '9', prize: '10', group: id, meta, accepted: true },
    }) as unknown as Round;
  assert.deepEqual(stepOf(revealed('3', { side: 'right' })), { side: 'right', chance: '9', outcome: '42' });
  assert.deepEqual(stepOf(revealed('0', { side: 'right' })), { outcome: '42' }, 'a reveal names no side');
  assert.deepEqual(stepOf(revealed('3', { side: 'left' }), '7'), { side: 'left', chance: '9', outcome: '7' });
});

test('the wheel covers only layouts: known spots, whole chips, adding up to the stake', () => {
  const layouts: Chips[] = [{ red: 100n, '17': 10n }, { black: 50n, 'dozen:2': 20n }, { '0': 5n }];
  for (const chips of layouts)
    assert.deepEqual(layout(wireChips(chips), String(Object.values(chips).reduce((a, b) => a + b, 0n))), chips);
  // Chips that are not on the felt, are not whole, or do not add up to the bet's stake are no layout: the wheel does
  // not cover a table a player signed themselves.
  assert.equal(layout({ '37': '100' }, '100'), null);
  assert.equal(layout({ red: '1.5' }, '1'), null);
  assert.equal(layout({ red: '0' }, '0'), null);
  assert.equal(layout({ red: '100' }, '1'), null);
  assert.equal(layout(['100'], '100'), null);
});
