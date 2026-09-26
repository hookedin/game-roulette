/**
 * The wheel everyone at the table shares, run by the game's developer. It keeps a round of its own open, which the
 * casino names by the hash of a secret it keeps, and publishes the hash of the seed its casino bet on the round will
 * bring, so where the ball lands is fixed before anybody bets, and neither the casino nor the wheel knows it until both
 * are out. Pages bet on the round the table shows: each wallet places a developer bet in the round's group, whose meta
 * names that seed hash and the chips, and whose stake goes to the developer's bank. Twenty seconds after the first
 * chip is down the wheel spins: it covers every bet that is a roulette layout with one casino bet of the table's
 * layouts together against the casino's bankroll, whose meta is the hash of the list of bets it covers, and which
 * reveals where the ball lands. It pays each covered bet what its chips pay there and every other its stake back, and
 * keeps the spin for anyone to check. Everything that touches the outside world is handed in, so the same wheel runs in
 * a Worker or a test.
 */
import { concat, keccak256 } from 'ethers';
import type { AssetId, Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { groupOf, layout, payouts, pocket, together } from '../src/table.ts';
import type { Chips } from '../src/table.ts';

/** Where the ball landed, as the wheel keeps it for anyone to check. */
export interface Spin {
  round: string;
  seed: string;
  secret: string;
  number: number;
  /** Whether the bankroll took the wheel's casino bet: a spin it turned down pays every bet its stake back. */
  accepted: boolean;
  /** The bets its casino bet covered, in the order the hash in its meta was taken over them. */
  covered: string[];
}
export interface WheelState {
  /** The round the table takes bets on, saved before anybody is told of it, so a spin that stopped halfway is
   * finished on that round. */
  round: string | null;
  /** The bets the wheel's casino bet on the round covers, saved before it is first placed, so the spin is placed again
   * and finished with the same ones. */
  covered: string[] | null;
}
export interface Deps {
  developer: Developer;
  /** What this wheel's table is played with. Every asset has a wheel of its own. */
  asset: AssetId;
  now(): number;
  save(state: WheelState): void | Promise<void>;
  /** Keep a spin for anyone to check, and read one back by its round. */
  keep(spin: Spin): void | Promise<void>;
  kept(round: string): Spin | null | undefined | Promise<Spin | null | undefined>;
  /** Ask for `alarm()` at this time. */
  wake(at: number): void;
}
/** How long players have once the first chip is down. */
export const BETTING_MS = 20_000;
const RETRY_MS = 5_000,
  LOOK_MS = 1_000;
/** The hash a casino bet's meta commits to: the covered bets' hashes, one after another. */
export const coveredHash = (covered: readonly string[]) => keccak256(concat(covered));
/** What a bet on a spin is owed: what its chips pay on the number if the spin's accepted casino bet covered it, and
 * its stake back otherwise, as for a bet on a round the wheel never spun. */
export function owed(bet: PublicDeveloperBet, spin: Spin | null | undefined) {
  const chips = spin?.accepted && spin.covered.includes(bet.bet) ? layout(bet.meta?.chips, bet.stake) : null;
  return chips ? (payouts(chips).get(spin!.number) ?? 0n) : BigInt(bet.stake);
}

export class Wheel {
  readonly deps: Deps;
  state: WheelState;
  /** The table's round, the hash of the seed the wheel's casino bet on it brings, and its open bets, as the casino had
   * them when the wheel last looked. */
  private table: { at: number; round: Round | null; seedHash: string | null; open: PublicDeveloperBet[] } = {
    at: 0,
    round: null,
    seedHash: null,
    open: [],
  };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Deps, saved?: WheelState) {
    this.deps = deps;
    this.state = { round: saved?.round ?? null, covered: saved?.covered ?? null };
  }
  /** One thing at a time: a Durable Object's handlers interleave across awaits. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  /** What a page shows: the round to bet on and its seed hash, who is at the table, and when the wheel spins. */
  view() {
    return this.serialized(async () => {
      await this.turn();
      const { open, round } = this.table;
      return {
        round: round?.id ?? null,
        seedHash: this.table.seedHash,
        closesAt: this.closesAt(),
        now: this.deps.now(),
        players: new Set(open.map(bet => bet.uname)).size,
        staked: String(open.reduce((sum, bet) => sum + BigInt(bet.stake), 0n)),
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
  kept(round: string) {
    return this.deps.kept(round.toLowerCase());
  }
  /** The wheel spins `BETTING_MS` after the first open bet on its round was placed, by the casino's clock. */
  private closesAt() {
    const first = this.table.open[0];
    return first && this.table.round ? first.placedAt + BETTING_MS : null;
  }
  private async turn() {
    const now = this.deps.now(),
      closesAt = this.closesAt();
    await this.look(now, closesAt !== null && now >= closesAt);
    const due = this.closesAt();
    if (due !== null && now >= due) await this.spin();
    const next = this.closesAt();
    if (next !== null) this.deps.wake(next);
  }
  /** Every open developer bet of the game in this wheel's asset, a page at a time, in the order they were placed. */
  private async openDeveloperBets() {
    const bets: PublicDeveloperBet[] = [];
    for (let after = ''; ;) {
      const page = await this.deps.developer.bets({ status: 'open', after });
      bets.push(...page.bets.filter(bet => bet.asset === this.deps.asset));
      if (!page.more) break;
      after = page.cursor;
    }
    return bets.sort((a, b) => a.placedAt - b.placedAt);
  }
  /** The table's round and its open bets, as the casino has them: asked at most once a second, and always before a
   * spin. A saved round the casino does not know, lost with its row or another deployment's, makes way for a new one,
   * and so does one already revealed, once its spin is kept. An open bet in any other group is what a spin left
   * behind, or came too late for it, or is no bet on this wheel at all: it is settled now, from its spin if the wheel
   * kept one, and with its stake back if not. */
  private async look(now: number, always: boolean) {
    if (now - this.table.at < LOOK_MS && !always) return;
    let round =
      this.state.round &&
      (await this.deps.developer.round(this.state.round).catch((error: any) => {
        if (error.status === 404) return null;
        throw error;
      }));
    if (!round || round.status === 'revealed') {
      // A spin that stopped halfway, its casino bet placed and its reply lost, is finished first.
      if (round) await this.finish(round, []);
      round = await this.deps.developer.openRound(this.deps.asset);
      this.state = { ...this.state, round: round.id, covered: null };
      await this.deps.save(this.state);
    }
    const bets = await this.openDeveloperBets(),
      group = groupOf(round.id),
      // The seed is derived from the developer's key and the round, so its hash is worked out, never stored.
      seedHash = this.table.round?.id === round.id ? this.table.seedHash : await this.deps.developer.seedHash(round.id);
    for (const other of new Set(bets.map(bet => bet.group ?? '').filter(g => g !== group)))
      await this.settle(
        /^[0-9a-f]{64}$/.test(other) ? await this.deps.kept('0x' + other) : null,
        bets.filter(bet => (bet.group ?? '') === other),
      );
    this.table = { at: now, round, seedHash, open: bets.filter(bet => bet.group === group) };
  }
  /** The spin: the wheel covers the table's layouts with one casino bet of them all together, which reveals the round,
   * and settles every bet on it. The bets it covers are saved before the casino bet is first placed, and a spin tried
   * again places it with the same ones, so it is the same casino bet: one whose reply was lost is answered as it
   * stands, and one the casino took meanwhile finds the round revealed and is finished with them. */
  private async spin() {
    try {
      const developer = this.deps.developer;
      let round = await developer.round(this.state.round!);
      const bets = (await this.openDeveloperBets()).filter(bet => bet.group === groupOf(round.id));
      if (round.status !== 'revealed') {
        const seedHash = await developer.seedHash(round.id),
          saved = this.state.covered,
          covered = bets
            .filter(bet => (saved ? saved.includes(bet.bet) : bet.meta?.seedHash === seedHash))
            .map(bet => ({ bet: bet.bet, chips: layout(bet.meta?.chips, bet.stake) }))
            .filter((layout): layout is { bet: string; chips: Chips } => layout.chips !== null)
            .sort((a, b) => (saved ? saved.indexOf(a.bet) - saved.indexOf(b.bet) : 0));
        if (covered.length) {
          if (!saved) {
            this.state = { ...this.state, covered: covered.map(({ bet }) => bet) };
            await this.deps.save(this.state);
          }
          round = await developer.casinoBet({
            round: round.id,
            ...together(covered.map(({ chips }) => chips)),
            meta: { covered: coveredHash(this.state.covered!) },
          });
        }
      }
      await this.finish(round, bets);
      this.state = { ...this.state, round: null, covered: null };
      await this.deps.save(this.state);
      this.table = { at: 0, round: null, seedHash: null, open: [] };
    } catch (error) {
      // Tried again shortly; the same round, seed and bets make it the same casino bet.
      this.deps.wake(this.deps.now() + RETRY_MS);
      throw error;
    }
  }
  /** Keep a revealed round's spin with the bets the wheel's casino bet covered, and pay the open bets on it what they
   * are owed. A round never revealed keeps no spin, and its bets get their stakes back. */
  private async finish(round: Round, bets: PublicDeveloperBet[]) {
    let spin: Spin | null = null;
    const { seed, secret, outcome, casinoBet } = round;
    if (round.status === 'revealed' && seed !== undefined && secret !== undefined && outcome !== undefined) {
      spin = {
        round: round.id.toLowerCase(),
        seed,
        secret,
        number: pocket(BigInt(outcome)),
        accepted: casinoBet?.accepted === true,
        covered: this.state.round === round.id ? (this.state.covered ?? []) : [],
      };
      await this.deps.keep(spin);
    }
    await this.settle(spin, bets);
  }
  /** Pay the open bets on a spin what they are owed. The casino's part is nothing: its commission is on the wheel's
   * casino bet. */
  private async settle(spin: Spin | null | undefined, bets: PublicDeveloperBet[]) {
    if (bets.length)
      await this.deps.developer.settle(bets.map(bet => ({ bet: bet.bet, player: owed(bet, spin), casino: 0n })));
  }
}
