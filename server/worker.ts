/**
 * The whole game in one Worker: the page and its files are static assets, and everything under
 * /api/ is the wheel, one Durable Object. The page talks to nobody but this origin, and the Worker
 * to nobody but the casino's public API.
 */
import { createDeveloper } from '@hookedin/play/sdk/developer';
import { Wheel } from './wheel.ts';
import type { Spin, WheelState } from './wheel.ts';

interface Env {
  ASSETS: Fetcher;
  WHEEL: DurableObjectNamespace;
  /** The casino's public API. */
  CASINO_URL: string;
  /** The name the game is published under, which with its developer's address makes its key. */
  GAME_NAME: string;
  /** The private key of the game's developer, the account it is published from: it runs the wheel, places its
   * casino bets and settles the game's developer bets. A secret. */
  DEVELOPER_KEY: string;
}

export class RouletteWheel implements DurableObject {
  private wheel: Promise<Wheel> | null = null;
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  /** One wheel, opened once and shared by every request that arrives meanwhile. A start that failed
   * is not kept: the casino it needs may be there by the next request. */
  private open() {
    return (this.wheel ??= (async () =>
      new Wheel(
        {
          developer: await createDeveloper({
            casinoURL: this.env.CASINO_URL,
            key: this.env.DEVELOPER_KEY,
            name: this.env.GAME_NAME,
          }),
          now: () => Date.now(),
          save: state => this.ctx.storage.put('state', state),
          keep: spin => this.ctx.storage.put(`spin:${spin.id}`, spin),
          kept: id => this.ctx.storage.get<Spin>(`spin:${id}`),
          wake: at => void this.ctx.storage.setAlarm(at),
        },
        await this.ctx.storage.get<WheelState>('state'),
      ))().catch(error => {
      this.wheel = null;
      throw error;
    }));
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    try {
      const wheel = await this.open();
      if (url.pathname === '/api/table' && request.method === 'GET') return Response.json(await wheel.view());
      if (url.pathname === '/api/table/placed' && request.method === 'POST') return Response.json(await wheel.placed());
      // Every spin the wheel kept, with its rounds and the bets its walk covered, for anyone to check.
      const spin = /^\/api\/spins\/([0-9a-fA-F]{64})$/.exec(url.pathname);
      if (spin && request.method === 'GET') {
        const kept = await wheel.kept(spin[1]!);
        if (kept) return Response.json(kept);
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'The wheel is unavailable' }, { status: 503 });
    }
  }
  /** The wheel spins on time whether or not anybody is asking. */
  async alarm() {
    await (await this.open()).alarm().catch(() => {});
  }
}

export default {
  fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // Every player shares the one wheel.
    return env.WHEEL.get(env.WHEEL.idFromName('wheel')).fetch(request);
  },
};
