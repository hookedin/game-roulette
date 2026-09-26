/**
 * The roulette table. A spin lands in one of 37 pockets, each as likely as the others: the wheel's server walks down a
 * binary tree of them to one, a casino bet per level (`@hookedin/play/sdk/steps`), and the pockets are the tree's
 * leaves in `ORDER`. A player's whole layout is one developer bet whose meta names its chips. Shared by the page and the
 * wheel's server.
 */
import { concat, keccak256 } from 'ethers';
import type { Side } from '@hookedin/play/sdk/steps';
import type { Round } from '@hookedin/play/sdk/developer';

/** The numbers in the order they sit on a European wheel. */
export const WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7,
  28, 12, 35, 3, 26,
];
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const colour = (n: number) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

/** The pockets as the leaves of a spin's walk, in order: the numbers 1 to 36, then zero. */
export const ORDER = [...Array.from({ length: 36 }, (_, i) => i + 1), 0];

const numbers = (keep: (n: number) => boolean) => ORDER.filter(n => n !== 0 && keep(n));
/** The numbers a spot on the layout covers: `17`, `red`, `odd`, `low`, `dozen:2`, `column:3`. */
export function covers(spot: string): number[] {
  const [kind, which] = spot.split(':'),
    k = Number(which);
  if (/^([0-9]|[12][0-9]|3[0-6])$/.test(spot)) return [Number(spot)];
  if (kind === 'red') return numbers(n => RED.has(n));
  if (kind === 'black') return numbers(n => !RED.has(n));
  if (kind === 'odd') return numbers(n => n % 2 === 1);
  if (kind === 'even') return numbers(n => n % 2 === 0);
  if (kind === 'low') return numbers(n => n <= 18);
  if (kind === 'high') return numbers(n => n >= 19);
  if (kind === 'dozen' && [1, 2, 3].includes(k)) return numbers(n => Math.ceil(n / 12) === k);
  if (kind === 'column' && [1, 2, 3].includes(k)) return numbers(n => (n - 1) % 3 === k - 1);
  throw new Error('Unknown spot: ' + spot);
}
/** What a winning chip returns for each unit on it, the chip included: 36 on a number, 3 on a dozen, 2 on red. */
export const returns = (spot: string) => 36n / BigInt(covers(spot).length);

export type Chips = Record<string, bigint>;
/** What each number pays a layout in total. */
export function payouts(chips: Chips) {
  const pays = new Map<number, bigint>();
  for (const [spot, amount] of Object.entries(chips))
    for (const n of covers(spot)) pays.set(n, (pays.get(n) ?? 0n) + amount * returns(spot));
  return pays;
}
/** What the wheel owes on each pocket, in `ORDER`, to the layouts a spin covers. */
export function owedOn(layouts: readonly Chips[]): bigint[] {
  const owed = ORDER.map(() => 0n);
  for (const chips of layouts) for (const [n, pays] of payouts(chips)) owed[ORDER.indexOf(n)]! += pays;
  return owed;
}
/** Chips as a bet's meta carries them: each spot's amount as a decimal string. */
export const wireChips = (chips: Chips) =>
  Object.fromEntries(Object.entries(chips).map(([spot, amount]) => [spot, String(amount)]));
/** The chips a bet's meta names, if they are a layout the wheel takes: known spots and whole amounts that add up to
 * the bet's stake. The wheel covers nothing else, so no player can sign themselves a better table. */
export function layout(wire: unknown, stake: string): Chips | null {
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const chips: Chips = {};
  for (const [spot, amount] of Object.entries(wire)) {
    try {
      covers(spot);
    } catch {
      return null;
    }
    if (typeof amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(amount)) return null;
    chips[spot] = BigInt(amount);
  }
  const total = Object.values(chips).reduce((sum, amount) => sum + amount, 0n);
  return total > 0n && total === BigInt(stake) ? chips : null;
}
/** A spin's ID, and the group of every bet on it: the hash of its rounds and then its seed hashes, one after another,
 * as 64 hex digits. It is published before anybody bets, so it fixes where the ball lands. */
export const spinId = (rounds: readonly string[], seedHashes: readonly string[]) =>
  keccak256(concat([...rounds, ...seedHashes])).slice(2);
/** The hash a spin's first step commits to in its meta: the covered bets' hashes, one after another. */
export const coveredHash = (covered: readonly string[]) => keccak256(concat(covered));
/** One step of a spin's walk, from the casino's record of its round, as `stepOutcome` takes it: the side the step's
 * casino bet signed and its chance, or neither for a round the step only revealed, and the round's outcome. */
export function stepOf(round: Round, outcome = round.outcome!) {
  const bet = round.casinoBet!;
  return bet.stake === '0' ? { outcome } : { side: bet.meta.side as Side, chance: bet.chance, outcome };
}
