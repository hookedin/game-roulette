/**
 * The wheel everyone at the table shares, run by the game's developer. Each spin is a walk down a binary tree of the 37
 * pockets, one round per level, and its rounds are opened before anybody bets: the casino names each by the hash of a
 * secret it keeps, and the wheel publishes the hashes of the seeds its casino bets on them will bring. The spin's ID is
 * the hash of both lists, so where the ball lands is fixed before anybody bets, and neither the casino nor the wheel
 * knows it until both are out. Pages bet on the spin the table shows: each wallet places a developer bet in the spin's
 * group, whose meta names the chips, and whose stake goes to the developer's bank.
 *
 * The wheel turns every `BETTING_MS`, whether or not anybody bets. At the turn it works out what it owes on each pocket
 * to every bet that is a roulette layout, prices the walk backward from that against half the casino's bankroll, and
 * walks it. Each level is one casino bet from its bank, in the spin's group, on the half of the pockets that needs more
 * cash, which the walk goes to when the round's outcome is below the bet's chance: whichever way the round goes, the
 * bank then holds what the rest of the walk needs, and at the pocket what the wheel owes there. A level whose halves
 * need the same cash, or whose stake the bank cannot pay, only reveals its round; so does one the bankroll declines.
 * Either way the walk goes on to its pocket, and the bank carries that level itself. The first step's meta commits to
 * the bets the walk covers. The wheel pays each covered bet what its chips pay on the pocket and every other its stake
 * back, and keeps the spin for anyone to check. A turn nobody laid a layout on has nothing riding on it: the ball lands
 * on a pocket drawn at random, nothing is walked, and the spin's rounds, still unrevealed, take the next turn's bets.
 * So an empty table costs the casino nothing, and wakes nobody: whoever looks next finds the turn the clock has come
 * to. Everything that touches the outside world is handed in, so the same wheel runs in a Worker or a test.
 */
import type { Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { levels, next, priceSteps, stepBet } from '@hookedin/play/sdk/steps';
import type { StepNode } from '@hookedin/play/sdk/steps';
import { ORDER, coveredHash, layout, owedOn, payouts, spinId, stepOf } from '../src/table.ts';

/** A spin the table takes bets on: its rounds, one for each level of the walk, and the hashes of the seeds the wheel's
 * casino bets on them bring. Its ID, `spinId` of the two, is the group of every bet on it. */
export interface OpenSpin {
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
export interface Deps {
  developer: Developer;
  now(): number;
  save(state: WheelState): void | Promise<void>;
  /** Keep a spin for anyone to check, and read one back by its ID. */
  keep(spin: Spin): void | Promise<void>;
  kept(id: string): Spin | null | undefined | Promise<Spin | null | undefined>;
  /** Ask for `alarm()` at this time. */
  wake(at: number): void;
}
/** How long each turn takes bets. */
export const BETTING_MS = 20_000;
/** How soon a walk or an alarm that failed is tried again. */
export const RETRY_MS = 5_000;
const LOOK_MS = 1_000;
/** What a bet on a spin is owed: what its chips pay on the number if the walk covered it, and its stake back
 * otherwise, as for a bet on a spin the wheel never walked. */
export function owed(bet: PublicDeveloperBet, spin: Spin | null | undefined) {
  const chips = spin?.covered.includes(bet.bet) ? layout(bet.meta?.chips, bet.stake) : null;
  return chips ? (payouts(chips).get(spin!.number) ?? 0n) : BigInt(bet.stake);
}

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  /** The open bets on the table's spin, as the casino had them when the wheel last looked. */
  private table: { at: number; open: PublicDeveloperBet[] } = { at: 0, open: [] };
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
  /** What a page shows: the spin to bet on, who is at the table, when the wheel turns, and where it last landed. */
  view() {
    return this.serialized(async () => {
      await this.turn();
      const { open } = this.table;
      return {
        spin: this.state.spin?.id ?? null,
        closesAt: this.state.closesAt,
        now: this.deps.now(),
        players: new Set(open.map(bet => bet.uname)).size,
        staked: String(open.reduce((sum, bet) => sum + BigInt(bet.stake), 0n)),
        landed: this.state.landed,
      };
    });
  }
  /** A page says its wallet placed a bet; the casino is asked, since a page can say anything. */
  placed() {
    this.table.at = 0;
    return this.view();
  }
  alarm() {
    return this.serialized(() => this.turn());
  }
  /** A spin the wheel kept, for anyone to check. */
  kept(id: string) {
    return this.deps.kept(id.toLowerCase());
  }
  /** The turn is taken once it is due, and the next one opens at once. A table somebody is at wakes the wheel on time
   * whether or not anybody is watching. */
  private async turn() {
    const now = this.deps.now(),
      due = () => this.state.closesAt !== null && now >= this.state.closesAt;
    await this.look(now, due());
    if (due()) {
      await this.spin();
      await this.look(now, false);
    }
    if (this.table.open.length) this.deps.wake(this.state.closesAt!);
  }
  /** Every open developer bet of the game, a page at a time, in the order they were placed. */
  private async openDeveloperBets() {
    const bets: PublicDeveloperBet[] = [];
    for (let after = ''; ;) {
      const page = await this.deps.developer.bets({ status: 'open', after });
      bets.push(...page.bets);
      if (!page.more) break;
      after = page.cursor;
    }
    return bets.sort((a, b) => a.placedAt - b.placedAt);
  }
  /** The table's spin and its open bets, as the casino has them: asked at most once a second, and always before a
   * walk. A spin whose first round the casino does not know, lost with its row or another deployment's, makes way for
   * a new one, and a spin with no turn to come gets the next. An open bet in any other group is what a walk left
   * behind, or came too late for it, or is no bet on this wheel at all: it is settled now, from its spin if the wheel
   * kept one, and with its stake back if not. */
  private async look(now: number, always: boolean) {
    if (now - this.table.at < LOOK_MS && !always) return;
    const { developer } = this.deps;
    const known =
      this.state.spin &&
      (await developer.round(this.state.spin.rounds[0]!).catch((error: any) => {
        if (error.status === 404) return null;
        throw error;
      }));
    if (!known) {
      const rounds: string[] = [];
      for (let level = 0; level < levels(ORDER.length); level++) rounds.push((await developer.openRound()).id);
      // The seeds are derived from the developer's key and the rounds, so their hashes are worked out, never stored.
      const seedHashes = await Promise.all(rounds.map(round => developer.seedHash(round)));
      this.state = { ...this.state, spin: { id: spinId(rounds, seedHashes), rounds, seedHashes }, walk: null };
    }
    if (!known || this.state.closesAt === null) {
      this.state = { ...this.state, closesAt: now + BETTING_MS };
      await this.deps.save(this.state);
    }
    const bets = await this.openDeveloperBets(),
      id = this.state.spin!.id;
    for (const other of new Set(bets.map(bet => bet.group ?? '').filter(group => group !== id)))
      await this.settle(
        await this.deps.kept(other),
        bets.filter(bet => (bet.group ?? '') === other),
      );
    this.table = { at: now, open: bets.filter(bet => bet.group === id) };
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
            bankroll: String((await developer.bankroll()) / 2n),
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
    } catch (error) {
      // Tried again shortly; the same spin, rounds and bets make it the same walk.
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
    this.table = { at: 0, open: [] };
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
