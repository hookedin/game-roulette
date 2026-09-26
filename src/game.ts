/**
 * Roulette where everyone at the table shares one spin. The page lays chips on the layout and asks the wallet to place
 * the whole layout as one developer bet in the group of the spin the table shows, its meta naming the chips: its stake
 * goes to the game's developer, who runs the wheel. The spin's ID is the hash of its rounds and of the seeds the
 * wheel's casino bets on them bring, all fixed before anybody bets. At the spin the wheel walks down a tree of the
 * pockets, one casino bet of its own per round, and pays each layout what it wins on the pocket the walk reaches. Once
 * the wallet has collected that, it sends the page the settled receipt, and the page works out the number itself from
 * the casino's record of each round, read through the wallet and checked against the spin its bet named. The wheel
 * plays with ETH: a wallet that practices with test coins watches the table, and bets nothing.
 */
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { outcome, roundId, seedHash as hashOfSeed } from '@hookedin/play/sdk/outcome';
import { next, stepOutcome } from '@hookedin/play/sdk/steps';
import type { GameReceipt } from '@hookedin/play/sdk/sdk';
import { mountBank } from '@hookedin/play/sdk/bank';
import { ORDER, colour, covers, coveredHash, layout, payouts, spinId, stepOf, wireChips } from './table.ts';
import type { Chips } from './table.ts';
import type { Spin } from '../server/wheel.ts';
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
interface Table {
  /** The spin the table takes bets on. */
  spin: string | null;
  closesAt: number | null;
  now: number;
  players: number;
  staked: string;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Too late for this spin: the wheel is about to spin, and a bet now would come too late for it and come back. */
const LAST_CALL_MS = 3000;

(() => {
  'use strict';
  const bank = mountBank($('bank')),
    wheel = mountWheel($<HTMLCanvasElement>('wheel'), matchMedia('(prefers-reduced-motion: reduce)').matches),
    stakeInput = $<HTMLInputElement>('stake');
  let scope = '',
    asset = 'ETH',
    /** The wallet practices, and a developer bet is placed with ETH: the table is watched, not bet on. */
    practice = false,
    ready = false,
    working = false,
    spinning = false,
    /** A settled bet is being landed: read its spin, then spin the wheel to it. */
    landing = false,
    chips: Chips = {},
    saved: Saved | null = null,
    table: Table | null = null,
    /** The server's clock minus this page's. */
    skew = 0,
    won: number | null = null;

  const message = (text: string, error = false) => {
    $('status').textContent = text;
    $('status').dataset.error = String(error);
  };
  const persist = () => (saved ? localStorage.setItem(scope, JSON.stringify(saved)) : localStorage.removeItem(scope));
  const total = () => Object.values(chips).reduce((sum, amount) => sum + amount, 0n);
  const remaining = () => (table?.closesAt ? table.closesAt - (Date.now() + skew) : Infinity);
  async function wheelAPI<T = Table>(path: string, post = false): Promise<T> {
    const response = await fetch(`./api${path}`, post ? { method: 'POST', body: '{}' } : {});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The wheel is unavailable.');
    return value;
  }

  // --- The layout ---------------------------------------------------------------------------

  function spot(id: string, label: string, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `spot ${className}`.trim();
    button.dataset.spot = id;
    if (/^\d+$/.test(id)) button.dataset.colour = colour(Number(id));
    else if (id === 'red' || id === 'black') button.dataset.colour = id;
    button.append(label);
    return button;
  }
  function buildLayout() {
    const cells: HTMLElement[] = [spot('0', '0', 'zero')];
    // Three rows of twelve, as on the felt: 3 6 9 … on top, 1 4 7 … at the bottom, a column bet at each row's end.
    for (const row of [3, 2, 1]) {
      for (let column = 0; column < 12; column++) cells.push(spot(String(column * 3 + row), String(column * 3 + row)));
      cells.push(spot(`column:${row}`, '2:1'));
    }
    const gap = () => Object.assign(document.createElement('span'), { className: 'gap' });
    cells.push(gap(), spot('dozen:1', '1 – 12', 'dozen'), spot('dozen:2', '13 – 24', 'dozen'));
    cells.push(spot('dozen:3', '25 – 36', 'dozen'), gap(), gap());
    for (const [id, label] of [
      ['low', '1 – 18'],
      ['even', 'Even'],
      ['red', 'Red'],
      ['black', 'Black'],
      ['odd', 'Odd'],
      ['high', '19 – 36'],
    ])
      cells.push(spot(id!, label!, 'outside'));
    $('layout').replaceChildren(...cells);
  }
  function chip(id: string, direction: 1 | -1) {
    if (locked()) return;
    let unit: bigint;
    try {
      unit = BigInt(HookedIn.parseAmount(stakeInput.value));
    } catch (error: any) {
      return message(error.message, true);
    }
    const amount = (chips[id] ?? 0n) + BigInt(direction) * unit;
    if (amount > 0n) chips[id] = amount;
    else delete chips[id];
    won = null;
    render();
  }
  /** The chips cannot move while a request is in flight, a bet is on the spin, the wheel is turning, or the wallet
   * practices. */
  const locked = () => working || spinning || Boolean(saved) || practice;

  // --- What the player sees ----------------------------------------------------------------

  function render() {
    for (const button of $('layout').querySelectorAll<HTMLElement>('.spot')) {
      const id = button.dataset.spot!,
        amount = chips[id];
      button.querySelector('.chip')?.remove();
      if (amount)
        button.append(
          Object.assign(document.createElement('span'), {
            className: 'chip',
            textContent: HookedIn.formatAmount(amount),
          }),
        );
      button.dataset.won = String(won !== null && Boolean(amount) && covers(id).includes(won));
    }
    $('layout').dataset.locked = String(locked());
    $('total').textContent = HookedIn.formatAmount(total(), 9);
    const left = remaining(),
      seconds = Math.max(0, Math.ceil(left / 1000));
    $('phase').textContent = spinning
      ? 'NO MORE BETS'
      : saved
        ? 'YOUR BET IS IN'
        : left < LAST_CALL_MS
          ? 'NO MORE BETS'
          : 'PLACE YOUR BETS';
    $('clock').textContent = Number.isFinite(left) ? `Spins in ${seconds}s` : 'Spins when the first chip is down';
    // What is down is ETH, which a practicing wallet would read as test coins: it sees who is at the table.
    $('players').textContent = table?.players
      ? `${table.players} at the table${practice ? '' : ` · ${HookedIn.formatAmount(table.staked)} ${asset} down`}`
      : 'The table is open.';
    const place = $<HTMLButtonElement>('place');
    place.disabled = !ready || locked() || !total() || left < LAST_CALL_MS;
    place.textContent = !ready
      ? 'Connecting wallet…'
      : practice
        ? 'Plays with ETH'
        : spinning
          ? 'Spinning…'
          : saved
            ? 'Bet placed'
            : 'Place bets ↗';
    $<HTMLButtonElement>('clear').disabled = locked() || !total();
    stakeInput.disabled =
      $<HTMLButtonElement>('bet-up').disabled =
      $<HTMLButtonElement>('bet-down').disabled =
        locked();
    bank.setBusy(working || spinning);
  }
  function remember(number: number) {
    const mark = Object.assign(document.createElement('span'), { textContent: String(number) });
    mark.dataset.colour = colour(number);
    $('history').prepend(mark);
    while ($('history').children.length > 10) $('history').lastElementChild!.remove();
  }

  // --- The bet -----------------------------------------------------------------------------

  /** The spin the wheel kept, or null if it kept none: a spin it never walked. */
  async function keptSpin(id: string): Promise<Spin | null> {
    const response = await fetch(`./api/spins/${id}`);
    if (response.status === 404) return null;
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The wheel is unavailable.');
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
  /** The ball lands, then the money shows. A bet the walk did not cover is owed its stake back, and its chips stay on
   * the layout. Whatever happens, the bet is landed once: the wallet's pushed receipt and the page asking for it can
   * both arrive. */
  async function land(receipt: GameReceipt) {
    if (landing || !saved || saved.id !== receipt.id) return;
    landing = true;
    try {
      const bet = saved,
        spin = await keptSpin(bet.spin),
        payout = BigInt(receipt.payout!),
        number = spin && (await walked(bet, spin)),
        pays = number === null ? null : (payouts(layout(bet.chips, bet.stake) ?? {}).get(number) ?? 0n),
        covered = Boolean(spin?.covered.includes(receipt.bet!));
      if (covered && pays === null) {
        saved = null;
        persist();
        bank.hold(false);
        message(
          `The wheel shows a spin its rounds at the casino do not bear out. It paid ${HookedIn.formatAmount(payout, 9)} ${asset}.`,
          true,
        );
        return render();
      }
      const owed = covered ? pays! : BigInt(bet.stake),
        short =
          payout < owed
            ? ` The wheel paid ${HookedIn.formatAmount(payout, 9)} ${asset} of the ${HookedIn.formatAmount(owed, 9)} ${asset} it owes this bet.`
            : '';
      if (!covered)
        return returned(
          `The wheel did not cover your bet on this spin${
            pays === null ? '' : `: its chips would have won ${HookedIn.formatAmount(pays, 9)} ${asset} on ${number}`
          }.${short}`,
        );
      await spinTo(bet, number!, payout, short);
    } finally {
      landing = false;
    }
  }
  async function spinTo(bet: Saved, number: number, payout: bigint, short: string) {
    saved = null;
    persist();
    spinning = true;
    bank.withhold(payout);
    render();
    await wheel.spin(number);
    bank.withhold(-payout);
    bank.hold(false);
    spinning = false;
    won = number;
    $('landed').textContent = String(number);
    $('landed').dataset.colour = colour(number);
    remember(number);
    message(
      (payout
        ? `${number} ${colour(number)}. ${HookedIn.formatAmount(payout, 9)} ${asset} back from ${HookedIn.formatAmount(bet.stake, 9)} ${asset} of chips.`
        : `${number} ${colour(number)}. Nothing on it this time.`) + short,
      Boolean(short),
    );
    render();
  }
  /** A bet the casino did not take, or one the wheel did not cover because it came too late for its spin: the chips
   * are the player's again. */
  function returned(why: string) {
    saved = null;
    persist();
    bank.hold(false);
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
    bank.hold(false);
    // Tell the wheel somebody bet, so that its clock starts now and not at its next look.
    table = await wheelAPI<Table>('/table/placed', true).catch(() => table);
    message('Your bet is in. It rides this spin.');
    render();
  }
  async function place() {
    const stake = total();
    if (!table?.spin) throw new Error('The wheel is not ready. Try again in a moment.');
    const limit = BigInt((await HookedIn.balance()).balance);
    if (stake > limit) {
      const funding = await HookedIn.requestFunds({ amount: stake - limit });
      bank.update(funding);
      if (BigInt(funding.balance) < stake) throw new Error('Add enough money to cover your chips.');
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
    bank.hold(true);
    try {
      await settle(await HookedIn.developerBet({ id, stake, group: spin, meta: { chips } }));
    } catch (error) {
      // A bet the wallet signed but has no answer for yet is asked about again; one it never signed is off.
      if (!saved!.placed && !(await HookedIn.balance()).pending) {
        saved = null;
        persist();
        bank.hold(false);
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

  async function watch() {
    try {
      table = await wheelAPI<Table>('/table');
      skew = table.now - Date.now();
      // The wallet has yet to answer for the bet: ask again. Once the table has moved on from its spin, ask the wallet
      // about it, so it collects the bet at once; the settled receipt arrives by itself, and is here already if it was
      // collected.
      if (saved && !saved.placed && !working && !spinning) await act(ask);
      else if (saved?.placed && table.spin !== saved.spin && !spinning && !landing) {
        const receipt = await HookedIn.receipt(saved.id);
        if (receipt?.status === 'settled') await settle(receipt);
      }
    } catch (error: any) {
      if (!saved) message(error.message, true);
    }
    render();
    setTimeout(watch, 1000);
  }
  async function start() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput,
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      asset = startup.asset;
      practice = startup.practice;
      scope = startup.scope;
      bank.update(startup.state);
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
        else if (startup.state.pending) await act(ask);
        else {
          saved = null;
          persist();
        }
      }
      if (!saved)
        message(
          practice
            ? 'The wheel plays with ETH. Watch the table here, and set up your wallet with ETH to bet.'
            : 'Put chips on the layout. Everyone shares the spin.',
        );
    } catch (error: any) {
      message(error.message, true);
    }
    render();
    void watch();
  }

  buildLayout();
  $('layout').addEventListener('click', event => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('.spot')?.dataset.spot;
    if (id) chip(id, event.shiftKey ? -1 : 1);
  });
  $('layout').addEventListener('contextmenu', event => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('.spot')?.dataset.spot;
    if (!id) return;
    event.preventDefault();
    chip(id, -1);
  });
  $('place').addEventListener('click', () => act(place));
  $('clear').addEventListener('click', () => {
    chips = {};
    won = null;
    render();
  });
  $('bet-up').addEventListener('click', () => HookedIn.stepStake(stakeInput, true));
  $('bet-down').addEventListener('click', () => HookedIn.stepStake(stakeInput, false));
  render();
  void start();
})();
