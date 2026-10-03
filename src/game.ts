/**
 * The roulette page: it lays chips on the board, places the layout as one developer bet in the group of the table's
 * spin, and works out where the ball landed from the casino's record of each round, checked against the spin its bet
 * named. The scheme is explained in ../server/wheel.ts.
 */
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { outcome, roundId, seedHash as hashOfSeed } from '@hookedin/play/sdk/outcome';
import { next, stepOutcome } from '@hookedin/play/sdk/steps';
import type { GameReceipt } from '@hookedin/play/sdk/sdk';
import { ORDER, colour, covers, coveredHash, layout, payouts, spinId, stepOf, wireChips } from './table.ts';
import type { Chips } from './table.ts';
import type { Spin, TableView } from '../server/wheel.ts';
import { mountWheel } from './wheel-view.ts';

/** A bet the wallet was asked to sign, saved first so that a reload finds its result under the same name. */
interface Saved {
  id: string;
  stake: string;
  /** The spin the player put their chips on: its rounds and seeds, fixed before the bet, fix where the ball lands. */
  spin: string;
  chips: Record<string, string>;
  /** The wallet signed it and its stake is with the developer: it rides its spin, and cannot be taken back. */
  placed?: boolean;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** The wheel shows the table every few seconds when nothing changes: a page that hears nothing for longer has lost
 * it. */
const STALE_MS = 7_000;
/** Too late for this spin: the wheel is about to spin, and a bet now would come too late for it and come back. */
const LAST_CALL_MS = 3000;
/** The rack's chips, each so many of the wallet's recommended stake. */
const RACK = [1, 10, 100, 1000];
/** How long a phone shows where the ball landed before the board comes back. */
const LINGER_MS = 2500;
/** A roll that no number comes for stops. */
const ROLL_MS = 60_000;
const EVEN_MONEY = { low: '1–18', even: 'Even', red: 'Red', black: 'Black', odd: 'Odd', high: '19–36' };

const wheel = mountWheel($<HTMLCanvasElement>('wheel'), matchMedia('(prefers-reduced-motion: reduce)').matches),
  board = $('board');
let scope = '',
  /** The wallet's recommended stake: what the rack's smallest chip is worth. */
  unit = 0n,
  /** The chip in hand, as a number of units. */
  hand = 1,
  ready = false,
  working = false,
  /** The wheel cannot be reached, so there is no spin to bet on. */
  offline = false,
  /** The turn is due and the wheel rolls, until its number is known here: since when. */
  rolling: number | null = null,
  spinning = false,
  /** A settled bet is being landed: read its spin, then spin the wheel to it. */
  landing = false,
  chips: Chips = {},
  /** The board before each change, for Undo. */
  past: Chips[] = [],
  /** The chips of the last bet placed: the board holds them again, to bet again. */
  last = '',
  saved: Saved | null = null,
  table: TableView | null = null,
  /** When the page last heard from the wheel, and asked the wallet about its bet. */
  heard = -Infinity,
  askedAt = -Infinity,
  /** The wheel's events, and when the page last connected to them. */
  source: EventSource | null = null,
  connectedAt = -Infinity,
  /** When the newest landing the table showed was, or null before the first look. */
  seen: number | null = null,
  /** The server's clock minus this page's. */
  skew = 0,
  /** Where the ball last landed, and whether the chips on the board rode that spin. */
  landed: number | null = null,
  rode = false,
  linger: ReturnType<typeof setTimeout> | undefined;

const message = (text: string, error = false) => {
  $('status').textContent = text;
  $('status').dataset.error = String(error);
};
const persist = () => (saved ? localStorage.setItem(scope, JSON.stringify(saved)) : localStorage.removeItem(scope));
const total = () => Object.values(chips).reduce((sum, amount) => sum + amount, 0n);
const remaining = () => (table?.closesAt ? table.closesAt - (Date.now() + skew) : Infinity);
const eth = (amount: bigint | string) => `${HookedIn.formatAmount(amount)} µETH`;
/** A layout as one string, whatever order its chips went down in. */
const same = (board: Chips) => JSON.stringify(Object.entries(wireChips(board)).sort());
/** So many units, as a chip reads: 5, 250, 1.5K, 20K. */
const short = (units: number) =>
  units >= 1e6
    ? `${+(units / 1e6).toFixed(1)}M`
    : units >= 1e3
      ? `${+(units / 1e3).toFixed(1)}K`
      : `${+units.toFixed(2)}`;
/** The chips cannot move before the wallet answers, while a request is in flight, or while a bet is on the spin or
 * the wheel turns. */
const locked = () => !ready || working || Boolean(rolling) || spinning || Boolean(saved);
const idle = () => `Pick a chip and tap the board. Chip 1 is ${eth(unit)}.`;

// --- The board ----------------------------------------------------------------------------

/** A spot at `row` and `col` of the board laid out lengthwise, `rows` high and `cols` wide: zero at the left, three
 * rows of twelve numbers with their 2:1 column bets at the right, the dozens and the even-money bets below. A phone
 * shows the board turned a quarter clockwise, standing up. */
function spot(id: string, label: string, name: string, row: number, col: number, rows = 1, cols = 1) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'spot';
  button.dataset.spot = id;
  button.dataset.name = name;
  if (/^\d+$/.test(id)) button.dataset.colour = colour(Number(id));
  else if (id === 'red' || id === 'black') button.dataset.colour = id;
  button.style.setProperty('--across', `${row} / ${col} / span ${rows} / span ${cols}`);
  button.style.setProperty('--down', `${col} / ${7 - row - rows} / span ${cols} / span ${rows}`);
  button.append(label);
  return button;
}
/** The board, and the rack of chips beside it. */
function build() {
  const spots = [spot('0', '0', '0', 1, 1, 3)];
  for (let n = 1; n <= 36; n++)
    spots.push(spot(String(n), String(n), String(n), 3 - ((n - 1) % 3), Math.ceil(n / 3) + 1));
  for (const k of [1, 2, 3]) {
    const [from, to] = [12 * k - 11, 12 * k];
    spots.push(spot(`column:${k}`, '2:1', `Column ${k}, pays 3 for 1`, 4 - k, 14));
    spots.push(spot(`dozen:${k}`, `${from}–${to}`, `${from} to ${to}`, 4, 4 * k - 2, 1, 4));
  }
  Object.entries(EVEN_MONEY).forEach(([id, label], i) =>
    spots.push(spot(id, label, label.replace('–', ' to '), 5, 2 * i + 2, 1, 2)),
  );
  board.replaceChildren(...spots);
  $('chips').replaceChildren(
    ...RACK.map(size => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip-pick';
      button.dataset.size = String(size);
      button.textContent = short(size);
      return button;
    }),
  );
}
/** Put down, or with `-1` take up, one chip of the size in hand. */
function chip(id: string, direction: 1 | -1) {
  if (locked() || (direction < 0 && !chips[id])) return;
  const amount = (chips[id] ?? 0n) + BigInt(direction * hand) * unit;
  past.push({ ...chips });
  if (amount > 0n) chips[id] = amount;
  else delete chips[id];
  rode = false;
  render();
}
/** Light the numbers a spot covers. */
function cover(id: string | undefined) {
  const numbers = id ? covers(id) : [];
  for (const button of board.querySelectorAll<HTMLElement>('.spot'))
    button.toggleAttribute('data-covered', numbers.includes(Number(button.dataset.spot)));
}

// --- What the player sees ----------------------------------------------------------------

function render() {
  const left = remaining(),
    late = left < LAST_CALL_MS,
    turning = Boolean(rolling) || spinning;
  for (const button of board.querySelectorAll<HTMLElement>('.spot')) {
    const id = button.dataset.spot!,
      amount = chips[id],
      hit = landed !== null && covers(id).includes(landed);
    button.querySelector('.chip')?.remove();
    if (amount)
      button.append(
        Object.assign(document.createElement('span'), {
          className: 'chip',
          textContent: short(Number(amount) / Number(unit || 1n)),
        }),
      );
    button.toggleAttribute('data-landed', id === String(landed));
    button.dataset.won = String(rode && Boolean(amount) && hit);
    button.dataset.lost = String(rode && Boolean(amount) && !hit);
    button.setAttribute('aria-label', amount ? `${button.dataset.name}: ${eth(amount)}` : button.dataset.name!);
  }
  board.dataset.locked = String(locked());
  for (const button of $('chips').querySelectorAll<HTMLButtonElement>('button')) {
    const size = Number(button.dataset.size);
    button.setAttribute('aria-pressed', String(size === hand));
    button.setAttribute('aria-label', unit ? `Chip of ${eth(BigInt(size) * unit)}` : `Chip ${short(size)}`);
    button.disabled = !ready;
  }
  $('chip-label').textContent = unit ? `Chip · ${eth(BigInt(hand) * unit)}` : 'Chip';
  $('total').textContent = HookedIn.formatAmount(total());
  $('phase').textContent = offline
    ? 'Table closed'
    : turning || (late && table?.closesAt)
      ? 'No more bets'
      : saved
        ? 'Your bet is in'
        : 'Place your bets';
  $('clock').textContent = offline
    ? 'Wheel offline'
    : turning
      ? 'Spinning'
      : !table
        ? 'Connecting…'
        : !table.spin
          ? 'Next spin opening'
          : `Spins in ${Math.max(0, Math.ceil(left / 1000))}s`;
  $('players').textContent = offline
    ? 'The wheel is offline.'
    : !table
      ? 'Connecting to the wheel…'
      : table.players
        ? `${table.players} ${table.players === 1 ? 'player' : 'players'} on this spin · ${eth(table.staked)}`
        : 'No bets on this spin yet';
  const place = $<HTMLButtonElement>('place');
  place.disabled = locked() || offline || !table?.spin || !total() || late;
  place.textContent = !ready
    ? 'Connecting wallet…'
    : offline
      ? 'Table closed'
      : working
        ? 'Placing…'
        : turning
          ? 'Spinning…'
          : saved
            ? 'Bet placed'
            : late && table?.closesAt
              ? 'No more bets'
              : total() && same(chips) === last
                ? 'Bet again ↗'
                : 'Place bets ↗';
  $<HTMLButtonElement>('undo').disabled = locked() || !past.length;
  $<HTMLButtonElement>('clear').disabled = locked() || !total();
}
/** Show the wheel over a phone's board, or let the board come back. */
function spotlight(on: boolean) {
  clearTimeout(linger);
  $('table').toggleAttribute('data-show', on);
}
function remember(number: number) {
  const mark = Object.assign(document.createElement('li'), { textContent: String(number) });
  mark.dataset.colour = colour(number);
  $('history').prepend(mark);
  while ($('history').children.length > 12) $('history').lastElementChild!.remove();
}
/** Four times a second: the clock, and the wheel once the turn is due. */
function tick() {
  if (table?.closesAt && remaining() <= 0 && !rolling && !spinning) {
    rolling = Date.now();
    wheel.roll();
    spotlight(true);
  }
  // No number came for the turn.
  if (rolling && Date.now() - rolling > ROLL_MS) stop();
  render();
}
function stop() {
  rolling = null;
  wheel.stop();
  spotlight(false);
}

// --- The bet -----------------------------------------------------------------------------

/** The spin the wheel kept, or null if it kept none: a spin it never walked. */
async function keptSpin(id: string): Promise<Spin | null> {
  const response = await fetch(`./api/spins/${id}`);
  if (response.status === 404) return null;
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'The wheel is offline.');
  return value;
}
/** The number a spin's walk reached, worked out here from the casino's record of each of its rounds, read through the
 * player's wallet: each round is the one the spin named for its level, before the bet, by its hash and the hash of
 * its seed, each step goes the way its casino bet signed before the round was revealed, and the first commits to the
 * bets the walk covers. So no wheel can show a number its rounds did not draw. Null for a spin that does not add up. */
async function walked(bet: Saved, spin: Spin) {
  if (spinId(spin.rounds, spin.seedHashes) !== bet.spin) return null;
  const steps = [];
  for (let level = 0, node = { lo: 0, hi: ORDER.length }; node.hi - node.lo > 1; level++) {
    const id = spin.rounds[level],
      round = id && (await HookedIn.round(id));
    if (
      !round ||
      round.status !== 'revealed' ||
      round.casinoBet?.group !== bet.spin ||
      roundId(round.secret!) !== id.toLowerCase() ||
      hashOfSeed(round.seed!) !== spin.seedHashes[level]!.toLowerCase() ||
      (level === 0 && round.casinoBet.meta.covered !== coveredHash(spin.covered))
    )
      return null;
    const step = stepOf(round, String(outcome(round.seed!, round.secret!).value));
    steps.push(step);
    node = next(node, step.side ?? 'left', BigInt(step.outcome));
  }
  try {
    return ORDER[stepOutcome(ORDER.length, steps)]!;
  } catch {
    return null;
  }
}
/** The ball lands, then the money shows: what the bet was paid stays out of the allowance the wallet shows until its
 * spin's group ends here. A bet the walk did not cover is owed its stake back. Whatever happens, the bet is landed
 * once: the wallet's pushed receipt and the page asking for it can both arrive. */
async function land(receipt: GameReceipt) {
  if (landing || spinning || !saved || saved.id !== receipt.id) return;
  landing = true;
  try {
    const bet = saved,
      spin = await keptSpin(bet.spin),
      payout = BigInt(receipt.payout!),
      number = spin && (await walked(bet, spin)),
      pays = number === null ? null : (payouts(layout(bet.chips, bet.stake) ?? {}).get(number) ?? 0n),
      covered = Boolean(spin?.covered.includes(receipt.bet!));
    saved = null;
    persist();
    const shown = () => void HookedIn.end(bet.spin).catch(() => {});
    if (covered && pays === null) {
      stop();
      shown();
      message(`The wheel's spin does not match the casino's records. It paid ${eth(payout)}.`, true);
      return render();
    }
    const owed = covered ? pays! : BigInt(bet.stake),
      short = payout < owed ? ` The wheel paid ${eth(payout)} of the ${eth(owed)} it owes this bet.` : '';
    if (!covered) {
      shown();
      message(
        `Your bet came too late for its spin, so its stake is back${
          pays === null ? '' : `: its chips would have won ${eth(pays)} on ${number}`
        }.${short}`,
        true,
      );
      if (number === null) return stop();
      return show(number);
    }
    await show(number!, { stake: bet.stake, payout, short });
    shown();
  } finally {
    landing = false;
  }
}
/** The ball lands on `number`: the wheel slows to it, the board marks it and the strip keeps it. `paid` is the
 * player's own bet on the spin: its stake, what it paid, and what it was paid short. */
async function show(number: number, paid?: { stake: string; payout: bigint; short: string }) {
  spinning = true;
  rolling = null;
  spotlight(true);
  $('result').textContent = '';
  render();
  await wheel.spin(number);
  spinning = false;
  landed = number;
  rode = Boolean(paid);
  $('landed').textContent = String(number);
  $('landed').dataset.colour = colour(number);
  remember(number);
  // A win is more back than the chips cost; less is only some of them back.
  const won = Boolean(paid && paid.payout > BigInt(paid.stake));
  $('result').dataset.win = String(won);
  $('result').textContent = !paid
    ? ''
    : won
      ? `You win ${eth(paid.payout)}`
      : paid.payout
        ? `${eth(paid.payout)} back`
        : 'No win';
  if (paid)
    message(
      `${number} ${colour(number)}: ${
        won
          ? `you win ${eth(paid.payout)} on ${eth(paid.stake)} of chips`
          : paid.payout
            ? `${eth(paid.payout)} back on ${eth(paid.stake)} of chips`
            : 'no win this time'
      }.${paid.short} Your chips stay on the board.`,
      Boolean(paid.short),
    );
  linger = setTimeout(() => spotlight(false), LINGER_MS);
  render();
}
/** A turn the player had no bet on lands where the table says. */
async function watched(number: number) {
  if (spinning || landing) return;
  await show(number);
}
/** A bet the casino did not take: the chips are the player's again. */
function returned(why: string) {
  saved = null;
  persist();
  message(`${why ? why + ' ' : ''}Your chips are back.`, true);
  render();
}
async function settle(receipt: GameReceipt) {
  if (receipt.status === 'rejected') return returned(receipt.reason ? `${receipt.reason}.` : '');
  // A settled bet whose spin cannot be read yet is asked about again on the next look.
  if (receipt.status === 'settled') return land(receipt).catch(error => message(error.message, true));
  if (saved!.placed) return;
  saved!.placed = true;
  persist();
  last = same(chips);
  past = [];
  message('Your bet is in. It rides this spin.');
  render();
}
async function place() {
  const stake = total();
  if (!table?.spin) throw new Error('The wheel is not ready. Try again in a moment.');
  // Every bet here is a developer bet, which the player allows apart from the casino's.
  const current = await HookedIn.allowance(),
    short = stake - BigInt(current.allowance);
  if (short > 0n || !current.developerBets) {
    const answer = await HookedIn.requestAllowance({ amount: short > 0n ? short : undefined, developerBets: true });
    if (BigInt(answer.allowance) < stake || !answer.developerBets)
      throw new Error('Allow this game to bet these chips with its developer, or deposit if your balance is empty.');
  }
  saved = {
    id: crypto.randomUUID(),
    stake: String(stake),
    spin: table.spin,
    chips: wireChips(chips),
  };
  persist();
  await ask();
}
/** Ask the wallet to place the saved bet in its spin's group: open until its spin is settled and the wallet has
 * collected what it was paid, when the wallet sends the settled receipt. */
async function ask() {
  const { id, stake, spin, chips } = saved!;
  try {
    await settle(await HookedIn.developerBet({ id, stake, group: spin, meta: { chips } }));
  } catch (error) {
    // A bet the wallet signed but has no answer for yet is asked about again; one it never signed is off.
    if (!saved!.placed && !(await HookedIn.allowance()).pending) {
      saved = null;
      persist();
    }
    throw error;
  }
}
async function act(work: () => Promise<void>) {
  if (working) return;
  working = true;
  render();
  try {
    await work();
  } catch (error: any) {
    message(error.message, true);
  } finally {
    working = false;
    render();
  }
}

// --- The table ---------------------------------------------------------------------------

/** The table as the wheel shows it: each change, and every few seconds. */
async function hear(next: TableView) {
  table = next;
  heard = performance.now();
  skew = table.now - Date.now();
  if (offline && !saved && ready) message(idle());
  offline = false;
  // A new landing: the wheel turns to it, unless the player's own bet rode it, which lands below. The first look
  // fills the strip with the landings the table has seen.
  const newest = table.landed[0];
  if (seen === null) for (const { number } of table.landed.toReversed()) remember(number);
  else if (newest && newest.at > seen && !(saved?.placed && newest.spin === saved.spin)) void watched(newest.number);
  seen = newest?.at ?? 0;
  // The wallet has yet to answer for the bet: ask again. Once the table has moved on from its spin, ask the wallet
  // about it, so it collects the bet at once; the settled receipt arrives by itself, and is here already if it was
  // collected.
  try {
    if (saved && !saved.placed && !working && !spinning) await act(ask);
    else if (
      saved?.placed &&
      table.spin !== saved.spin &&
      !spinning &&
      !landing &&
      performance.now() - askedAt > 3_000
    ) {
      askedAt = performance.now();
      const receipt = await HookedIn.receipt(saved.id);
      if (receipt?.status === 'settled') void settle(receipt);
    }
  } catch (error: any) {
    if (!saved) message(error.message, true);
  }
  render();
}
/** The wheel's events, from this page's own server. A page that hears nothing for a while connects again. */
function connect() {
  source?.close();
  connectedAt = performance.now();
  source = new EventSource('./api/live');
  source.onmessage = event => void hear(JSON.parse(event.data));
}
setInterval(() => {
  if (performance.now() - Math.max(heard, connectedAt) < STALE_MS) return;
  if (!offline && !saved) message('The wheel is offline. The table opens when it is back.', true);
  offline = true;
  render();
  connect();
}, 1_000);
async function start() {
  try {
    const info = await HookedIn.info(),
      state = await HookedIn.allowance();
    unit = BigInt(info.recommendedStake);
    scope = HookedIn.storageScope(info);
    saved = JSON.parse(localStorage.getItem(scope) ?? 'null');
    ready = true;
    // A developer bet's settled receipt arrives by itself once the wallet has collected it.
    HookedIn.onReceipt(receipt => {
      if (saved && receipt.id === saved.id) void settle(receipt);
    });
    if (saved) {
      chips = Object.fromEntries(Object.entries(saved.chips).map(([id, amount]) => [id, BigInt(amount)]));
      const receipt = await HookedIn.receipt(saved.id);
      // Paid while away, still waiting for its spin, or never signed at all.
      if (receipt) await settle(receipt);
      else if (state.pending) await act(ask);
      else {
        saved = null;
        persist();
      }
    }
    if (!saved && !offline) message(idle());
  } catch (error: any) {
    message(error.message, true);
  }
  render();
}

build();
board.addEventListener('click', event => {
  const spot = (event.target as HTMLElement).closest<HTMLElement>('.spot');
  if (!spot) return;
  chip(spot.dataset.spot!, event.shiftKey ? -1 : 1);
  // A spot clicked with a pointer lets go of the focus, so that Space places the bets; the keyboard keeps it.
  if (event.detail) spot.blur();
});
board.addEventListener('contextmenu', event => {
  const id = (event.target as HTMLElement).closest<HTMLElement>('.spot')?.dataset.spot;
  if (!id) return;
  event.preventDefault();
  chip(id, -1);
});
board.addEventListener('pointerover', event =>
  cover((event.target as HTMLElement).closest<HTMLElement>('.spot')?.dataset.spot),
);
board.addEventListener('pointerleave', () => cover(undefined));
$('chips').addEventListener('click', event => {
  const size = (event.target as HTMLElement).closest<HTMLElement>('.chip-pick')?.dataset.size;
  if (!size) return;
  hand = Number(size);
  render();
});
$('undo').addEventListener('click', () => {
  if (locked() || !past.length) return;
  chips = past.pop()!;
  rode = false;
  render();
});
$('clear').addEventListener('click', () => {
  if (locked() || !total()) return;
  past.push(chips);
  chips = {};
  rode = false;
  render();
});
$('place').addEventListener('click', () => act(place));
// Space places the bets, unless a control has the focus and takes the key itself.
addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.target !== document.body) return;
  event.preventDefault();
  if (!event.repeat && !$<HTMLButtonElement>('place').disabled) void act(place);
});
$('wheel-box').addEventListener('click', () => spotlight(false));
render();
setInterval(tick, 250);
connect();
void start();
