/**
 * The wheel everyone at the table shares, run by the game's developer. Each spin is a walk down a binary tree of the 37
 * pockets, one round per level, and its rounds are opened before anybody bets: the casino names each by the hash of a
 * secret it keeps, and the wheel publishes the hashes of the seeds its casino bets on them will bring. The spin's ID is
 * the hash of both lists, so where the ball lands is fixed before anybody bets, and neither the casino nor the wheel
 * knows it until both are out. Pages bet on the spin the table shows: each wallet places a developer bet in the spin's
 * group, whose meta names the chips, and whose stake goes to the developer's bank.
 *
 * The wheel turns every `BETTING_MS`, whether or not anybody bets. At the turn it works out what it owes on each pocket
 * to every bet that is a roulette layout, prices the walk backward from that against the casino's virtual bankroll, and
 * walks it. Each level is one casino bet from its bank, in the spin's group, on the half of the pockets that needs more
 * cash, which the walk goes to when the round's outcome is below the bet's chance: whichever way the round goes, the
 * bank then holds what the rest of the walk needs, and at the pocket what the wheel owes there. A level whose halves
 * need the same cash, or whose stake the bank cannot pay, only reveals its round; so does one the bankroll declines.
 * Either way the walk goes on to its pocket, and the bank carries that level itself. The first step's meta commits to
 * the bets the walk covers. The wheel pays each covered bet what its chips pay on the pocket and every other its stake
 * back, and keeps the spin for anyone to check. A turn nobody laid a layout on has nothing riding on it: the ball lands
 * on a pocket drawn at random, nothing is walked, and the spin's rounds, still unrevealed, take the next turn's bets.
 * So an empty table costs the casino nothing, and wakes nobody: whoever looks next finds the turn the clock has come
 * to. While a page watches, the wheel follows the casino's bets as they are placed, and shows every watching page the
 * table as it changes. Everything that touches the outside world is handed in, so the same wheel runs in a Worker or a
 * test.
 */
import type { Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { levels, next, priceSteps, stepBet } from '@hookedin/play/sdk/steps';
import type { StepNode } from '@hookedin/play/sdk/steps';
import { ORDER, coveredHash, layout, owedOn, payouts, spinId, stepOf } from '../src/table.ts';

/** A spin the table takes bets on: its rounds, one for each level of the walk, and the hashes of the seeds the wheel's
 * casino bets on them bring. Its ID, `spinId` of the two, is the group of every bet on it. */
interface OpenSpin {
  id: string;
  rounds: string[];
  seedHashes: string[];
}
/** A spin the wheel walked, as it keeps it for anyone to check: the bets it covered, in the order the hash in its first
 * step's meta was taken over them, and the number the walk reached. */
export interface Spin extends OpenSpin {
  covered: string[];
  number: number;
}
/** Where the ball landed on a turn: on the number `spin`'s walk reached, or with `spin` null on a turn nobody bet on,
 * where the wheel drew it. */
export interface Landing {
  at: number;
  number: number;
  spin: string | null;
}
export interface WheelState {
  /** The spin the table takes bets on, saved before anybody is told of it. */
  spin: OpenSpin | null;
  /** Once betting has closed: the bets the walk covers, what the wheel owes on each pocket, and the bankroll the walk
   * is priced against, saved before its first step, so a walk that stopped halfway is finished the same way. */
  walk: { covered: string[]; owed: string[]; bankroll: string } | null;
  /** When the spin's next turn closes its betting and the wheel turns, by the wheel's clock. */
  closesAt: number | null;
  /** The last turns' landings, newest first. */
  landed: Landing[];
}
/** What a page shows: the spin to bet on, when the wheel turns, by the wheel's clock, who is at the table, and where it
 * last landed. */
export interface TableView {
  spin: string | null;
  closesAt: number | null;
  now: number;
  players: number;
  staked: string;
  landed: Landing[];
}
interface Deps {
  developer: Developer;
  now(): number;
  save(state: WheelState): void | Promise<void>;
  /** Keep a spin for anyone to check, and read one back by its ID. */
  keep(spin: Spin): void | Promise<void>;
  kept(id: string): Spin | null | undefined | Promise<Spin | null | undefined>;
  /** Ask for `tick()` at this time. */
  wake(at: number): void;
  /** Shows every watching page the table as it stands. */
  show(view: TableView): void;
  /** Whether any page is watching. */
  watched(): boolean;
}
/** How long each turn takes bets. */
export const BETTING_MS = 20_000;
/** How soon a walk, a read or an alarm that failed is tried again. */
export const RETRY_MS = 5_000;
/** How often a watched table shows itself when nothing changes, so that its pages know they still hear it. */
export const HEARTBEAT_MS = 3_000;
/** How long the casino holds a read of new bets until one is placed, in seconds. */
const WAIT_S = 25;
/** What a bet on a spin is owed: what its chips pay on the number if the walk covered it, and its stake back
 * otherwise, as for a bet on a spin the wheel never walked. */
function owed(bet: PublicDeveloperBet, spin: Spin | null | undefined) {
  const chips = spin?.covered.includes(bet.bet) ? layout(bet.meta?.chips, bet.stake) : null;
  return chips ? (payouts(chips).get(spin!.number) ?? 0n) : BigInt(bet.stake);
}

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  /** The open bets on the table's spin, by hash, as the wheel has read them from the casino. */
  private table = new Map<string, PublicDeveloperBet>();
  /** Where the wheel has read the casino's bets up to. A wheel starts from the oldest open bet. */
  private cursor = '';
  /** Whether the casino knows the table's spin: asked once a start, and again once a walk finds a round of it unknown. */
  private checked = false;
  private following = false;
  /** The table as the pages last saw it, but for its clock, and when. */
  private shown = '';
  private shownAt = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps, saved?: WheelState) {
    this.deps = deps;
    this.state = {
      spin: saved?.spin ?? null,
      walk: saved?.walk ?? null,
      closesAt: saved?.closesAt ?? null,
      landed: saved?.landed ?? [],
    };
  }
  /** One thing at a time: a Durable Object's handlers interleave across awaits. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  /** The table as a page shows it. */
  private tableView(): TableView {
    const open = [...this.table.values()];
    return {
      spin: this.state.spin?.id ?? null,
      closesAt: this.state.closesAt,
      now: this.deps.now(),
      players: new Set(open.map(bet => bet.uname)).size,
      staked: String(open.reduce((sum, bet) => sum + BigInt(bet.stake), 0n)),
      landed: this.state.landed,
    };
  }
  /** Shows every watching page the table if it changed since they last saw it, or with `always`, either way. Then the
   * wheel asks to be woken for the turn, if somebody is at the table, and while a page watches, a heartbeat after the
   * table was last shown. */
  private publish(always = false) {
    const view = this.tableView(),
      shown = JSON.stringify({ ...view, now: 0 });
    if (shown !== this.shown || always) {
      this.shown = shown;
      this.shownAt = view.now;
      this.deps.show(view);
    }
    const watched = this.deps.watched(),
      turn = this.state.closesAt!;
    if (this.table.size || watched)
      this.deps.wake(watched ? Math.min(turn, Math.max(this.shownAt + HEARTBEAT_MS, view.now)) : turn);
  }
  /** What a page shows, once the wheel has come up to its clock. */
  view() {
    return this.serialized(async () => {
      await this.turn();
      this.publish();
      return this.tableView();
    });
  }
  /** The wheel's alarm: the turn is taken once it is due, and every watching page is shown the table. A wheel nobody
   * watches reads its bets first, since after a restart only the casino knows who is at the table. */
  async tick() {
    if (!this.following) await this.read();
    await this.serialized(async () => {
      await this.turn();
      this.publish(true);
    });
  }
  /** A spin the wheel kept, for anyone to check. */
  kept(id: string) {
    return this.deps.kept(id.toLowerCase());
  }
  /** While a page watches, the wheel follows the casino's bets: the casino holds each read until a bet on the game is
   * placed, so each joins the table as it comes. */
  async follow() {
    if (this.following) return;
    this.following = true;
    try {
      while (this.deps.watched()) {
        const asked = Date.now();
        try {
          // An empty page long before the wait is up means another server took the game's wait: both back off,
          // rather than answer each other's waits as fast as the network goes.
          if ((await this.read(WAIT_S)) || Date.now() - asked > (WAIT_S * 1000) / 2) continue;
        } catch (error: any) {
          console.error('Wheel bets:', error.message);
          // Again from the oldest open bet: the casino may have been away, or restored its records.
          this.cursor = '';
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
    } finally {
      this.following = false;
    }
  }
  /** The bets placed since the wheel last read, a page of them, waiting up to `wait` seconds for one. A bet on the
   * table's spin joins the table. Any other is what a walk left behind, or came too late for it, or is no bet on this
   * wheel at all: it is settled now, from its spin if the wheel kept one, and with its stake back if not. The cursor
   * moves on once they are taken, so a bet that could not be settled is read again. Resolves with how many it read. */
  async read(wait = 0) {
    const from = this.cursor,
      page = await this.deps.developer.bets({ after: from, wait });
    await this.serialized(async () => {
      await this.turn();
      const id = this.state.spin!.id;
      for (const bet of page.bets) if (bet.group === id) this.table.set(bet.bet, bet);
      for (const other of new Set(page.bets.map(bet => bet.group ?? '').filter(group => group !== id)))
        await this.settle(
          await this.deps.kept(other),
          page.bets.filter(bet => (bet.group ?? '') === other),
        );
      this.publish();
    });
    // Unless the wheel moved to a new spin meanwhile, and starts again from the oldest open bet.
    if (this.cursor === from) this.cursor = page.cursor;
    return page.bets.length;
  }
  /** The turn is taken once it is due, and the next one opens at once. A table somebody is at wakes the wheel on time
   * whether or not anybody is watching (`publish` asks for it). */
  private async turn() {
    const now = this.deps.now();
    await this.open(now);
    if (now >= this.state.closesAt!) {
      await this.spin();
      await this.open(now);
    }
  }
  /** Every open developer bet of the game, a page at a time, in the order they were placed. */
  private async openDeveloperBets() {
    const bets: PublicDeveloperBet[] = [];
    for (let after = ''; ;) {
      const page = await this.deps.developer.bets({ status: 'open', after });
      bets.push(...page.bets);
      if (!page.more) return bets;
      after = page.cursor;
    }
  }
  /** The table's spin. A spin whose first round the casino does not know, lost with its row or another deployment's,
   * makes way for a new one; a spin with no turn to come gets the next. */
  private async open(now: number) {
    const { developer } = this.deps;
    if (this.state.spin && !this.checked) {
      const known = await developer.round(this.state.spin.rounds[0]!).catch((error: any) => {
        if (error.status === 404) return null;
        throw error;
      });
      // The bets on it are read again, and given their stakes back.
      if (!known) {
        this.state = { ...this.state, spin: null, walk: null };
        this.cursor = '';
      }
    }
    this.checked = true;
    if (this.state.spin && this.state.closesAt !== null) return;
    if (!this.state.spin) {
      const rounds: string[] = [];
      for (let level = 0; level < levels(ORDER.length); level++) rounds.push((await developer.openRound()).id);
      // The seeds are derived from the developer's key and the rounds, so their hashes are worked out, never stored.
      const seedHashes = await Promise.all(rounds.map(round => developer.seedHash(round)));
      this.state = { ...this.state, spin: { id: spinId(rounds, seedHashes), rounds, seedHashes }, walk: null };
      this.table.clear();
    }
    this.state = { ...this.state, closesAt: now + BETTING_MS };
    await this.deps.save(this.state);
  }
  /** The walk. What the wheel owes on each pocket, the bets it covers and the bankroll it is priced against are saved
   * before its first step, and each step is placed on the spin's round for its level, so a walk tried again places
   * the same casino bets: one whose reply was lost finds its round revealed, and the walk goes on from there. */
  private async spin() {
    try {
      const { developer } = this.deps,
        spin = this.state.spin!;
      const bets = (await this.openDeveloperBets()).filter(bet => bet.group === spin.id);
      if (!this.state.walk) {
        const covered = bets.flatMap(bet => {
          const chips = layout(bet.meta?.chips, bet.stake);
          return chips ? [{ bet: bet.bet, chips }] : [];
        });
        // Nobody laid a layout, so nothing rides on the turn: the ball lands on a pocket drawn at random, and the
        // spin's rounds take the next turn's bets. Whatever else is in its group is given back.
        if (!covered.length) {
          await this.settle(null, bets);
          return await this.land(Math.floor(Math.random() * ORDER.length), null);
        }
        this.state = {
          ...this.state,
          walk: {
            covered: covered.map(({ bet }) => bet),
            owed: owedOn(covered.map(({ chips }) => chips)).map(String),
            bankroll: String(await developer.virtualBankroll()),
          },
        };
        await this.deps.save(this.state);
      }
      const walk = this.state.walk!,
        plan = priceSteps(walk.owed.map(BigInt), BigInt(walk.bankroll));
      let node: StepNode = { lo: 0, hi: ORDER.length };
      for (const [level, round] of spin.rounds.entries()) {
        if (node.hi - node.lo === 1) break;
        const step = await this.step(round, stepBet(plan, node), level ? {} : { covered: coveredHash(walk.covered) });
        node = next(node, step.side ?? 'left', BigInt(step.outcome));
      }
      const kept: Spin = { ...spin, covered: walk.covered, number: ORDER[node.lo]! };
      await this.deps.keep(kept);
      await this.settle(kept, bets);
      await this.land(kept.number, kept.id);
    } catch (error: any) {
      // Tried again shortly; the same spin, rounds and bets make it the same walk. A round the casino does not know,
      // as after a restore of its records, sends the wheel to ask about its spin again.
      if (error.status === 404) this.checked = false;
      this.deps.wake(this.deps.now() + RETRY_MS);
      throw error;
    }
  }
  /** The ball lands on `number`, which the strip of recent landings keeps. A spin the wheel walked has spent its
   * rounds; one nobody bet on keeps them for the next turn. */
  private async land(number: number, walked: string | null) {
    this.state = {
      spin: walked ? null : this.state.spin,
      walk: null,
      closesAt: null,
      landed: [{ at: this.deps.now(), number, spin: walked }, ...this.state.landed].slice(0, 12),
    };
    await this.deps.save(this.state);
    // Every bet on the spin the wheel had read is settled.
    this.table.clear();
  }
  /** One level of the walk on its round: its casino bet, in the spin's group with its side in its meta, or a reveal of
   * the round when it bets nothing or its bank cannot pay the stake. A round revealed already is the step as it was
   * placed. */
  private async step(round: string, bet: ReturnType<typeof stepBet>, meta: Record<string, unknown>) {
    const { developer } = this.deps,
      group = this.state.spin!.id;
    let revealed: Round = await developer.round(round);
    if (revealed.status !== 'revealed') {
      const reveal = () => developer.reveal({ round, group, meta });
      revealed = bet
        ? await developer
            .casinoBet({
              round,
              stake: bet.stake,
              chance: bet.chance,
              prize: bet.prize,
              group,
              meta: { ...meta, side: bet.side },
            })
            .catch(error => {
              if (error.code === 'bank-short') return reveal();
              throw error;
            })
        : await reveal();
    }
    return stepOf(revealed);
  }
  /** Pay the open bets on a spin what they are owed. The casino's part is nothing: its commission is on the wheel's
   * casino bets. */
  private async settle(spin: Spin | null | undefined, bets: PublicDeveloperBet[]) {
    if (bets.length)
      await this.deps.developer.settle(bets.map(bet => ({ bet: bet.bet, player: owed(bet, spin), casino: 0n })));
  }
}
