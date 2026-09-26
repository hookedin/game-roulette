/**
 * The roulette table as one bet. A round's outcome is a uniform integer below 2^64; the wheel's 37 pockets are 37
 * stretches of it. A player's whole layout is one developer bet whose meta names its chips, and the wheel adds up
 * every layout on a spin into one casino bet, whose prizes pay each stretch what the chips on its number pay. Shared
 * by the page and the wheel's server.
 */
const SPACE = 1n << 64n,
  WIDTH = SPACE / 37n;
/** The numbers in the order they sit on a European wheel. */
export const WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7,
  28, 12, 35, 3, 26,
];
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const colour = (n: number) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

/** The stretches of the outcome space in order: the numbers 1 to 36, equally wide, then zero, which
 * also takes the few outcomes 37 does not divide. Every outcome is a pocket. */
const ORDER = [...Array.from({ length: 36 }, (_, i) => i + 1), 0];
/** The pocket the ball lands in. */
export const pocket = (outcome: bigint) => ORDER[Number(outcome / WIDTH > 36n ? 36n : outcome / WIDTH)]!;

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
export interface WireBet {
  stake: string;
  prizes: { rangeStart: string; rangeEnd: string; payout: string }[];
}
/** What each number pays a layout in total. */
export function payouts(chips: Chips) {
  const pays = new Map<number, bigint>();
  for (const [spot, amount] of Object.entries(chips))
    for (const n of covers(spot)) pays.set(n, (pays.get(n) ?? 0n) + amount * returns(spot));
  return pays;
}
/** What each stretch of the outcome space pays, in its order, as prizes: neighbouring stretches that pay the same
 * are one prize. */
function prizesOf(pays: readonly bigint[]): WireBet['prizes'] {
  const prizes: { rangeStart: bigint; rangeEnd: bigint; payout: bigint }[] = [];
  pays.forEach((payout, i) => {
    const rangeStart = BigInt(i) * WIDTH,
      rangeEnd = i === 36 ? SPACE : rangeStart + WIDTH,
      last = prizes.at(-1);
    if (!payout) return;
    if (last && last.rangeEnd === rangeStart && last.payout === payout) last.rangeEnd = rangeEnd;
    else prizes.push({ rangeStart, rangeEnd, payout });
  });
  return prizes.map(prize => ({
    rangeStart: String(prize.rangeStart),
    rangeEnd: String(prize.rangeEnd),
    payout: String(prize.payout),
  }));
}
/** A layout as one bet: the stake is every chip, and each pocket pays what the chips on it pay. */
export function bet(chips: Chips): WireBet {
  const pays = payouts(chips);
  return {
    stake: String(Object.values(chips).reduce((sum, amount) => sum + amount, 0n)),
    prizes: prizesOf(ORDER.map(n => pays.get(n) ?? 0n)),
  };
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
/** Layouts on one spin as one bet: their chips together, so each pocket pays what they all pay on it. */
export function together(layouts: readonly Chips[]): WireBet {
  const all: Chips = {};
  for (const chips of layouts)
    for (const [spot, amount] of Object.entries(chips)) all[spot] = (all[spot] ?? 0n) + amount;
  return bet(all);
}
/** The group every bet on a spin carries: its round's 64 hex digits, so the casino lists a spin's bets together. */
export const groupOf = (round: string) => round.slice(2).toLowerCase();
