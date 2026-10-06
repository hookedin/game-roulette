/**
 * The whole game in one Worker: the page and its files are static assets, and everything under
 * /api/ is the wheel, one Durable Object. The page talks to nobody but this origin, and the Worker
 * to nobody but the casino's public API.
 */
import { createDeveloper } from '@hookedin/play/sdk/developer';
import { RETRY_MS, Wheel } from './wheel.ts';
import type { Spin, TableView, WheelState } from './wheel.ts';

interface Env {
  ASSETS: Fetcher;
  WHEEL: DurableObjectNamespace;
  /** The casino's public API. */
  CASINO_URL: string;
  /** The game's ID, which the wallet's Developer page shows beside the game. */
  GAME: string;
  /** The private key of the game's server, which its developer names on the Developer page: it runs the wheel, places
   * the game's casino bets from its bank and settles its developer bets, and nothing else. A secret. */
  SERVER_KEY: string;
}
const encoder = new TextEncoder();
/** How many events a page may fall behind by before it is dropped; it connects again. */
const MAX_BEHIND = 16;

export class RouletteWheel implements DurableObject {
  private wheel: Promise<Wheel> | null = null;
  /** Every page watching: the stream of server-sent events it reads. */
  private readonly pages = new Set<WritableStreamDefaultWriter<Uint8Array>>();
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
            key: this.env.SERVER_KEY,
            game: this.env.GAME,
          }),
          now: () => Date.now(),
          save: state => this.ctx.storage.put('state', state),
          keep: spin => this.ctx.storage.put(`spin:${spin.id}`, spin),
          kept: id => this.ctx.storage.get<Spin>(`spin:${id}`),
          wake: at => void this.ctx.storage.setAlarm(at),
          show: view => this.send(view, this.pages),
          watched: () => this.pages.size > 0,
        },
        await this.ctx.storage.get<WheelState>('state'),
      ))().catch(error => {
      this.wheel = null;
      throw error;
    }));
  }
  /** The table as an event to `pages`. A page that has fallen too far behind, or gone, is dropped. */
  private send(view: TableView, pages: Iterable<WritableStreamDefaultWriter<Uint8Array>>) {
    const event = encoder.encode(`data: ${JSON.stringify(view)}\n\n`);
    for (const page of pages) {
      if (page.desiredSize === null || page.desiredSize < -MAX_BEHIND) {
        this.pages.delete(page);
        page.abort().catch(() => {});
      } else page.write(event).catch(() => this.pages.delete(page));
    }
  }
  /** A page watches the table: the table as it stands, then every change, and the wheel follows the casino's bets. */
  private async watch(wheel: Wheel) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(),
      page = writable.getWriter();
    page.closed.catch(() => {}).finally(() => this.pages.delete(page));
    void page.write(encoder.encode('retry: 1000\n\n')).catch(() => {});
    this.pages.add(page);
    try {
      this.send(await wheel.view(), [page]);
    } catch (error) {
      this.pages.delete(page);
      throw error;
    }
    void wheel.follow();
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    try {
      const wheel = await this.open();
      if (url.pathname === '/api/live' && request.method === 'GET') return await this.watch(wheel);
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
  /** A turn somebody bet on is taken on time whether or not anybody is watching, and a watched table shows itself.
   * An alarm that fails, opening the wheel or reading the casino, tries again shortly: nothing else wakes a table
   * nobody is watching. */
  async alarm() {
    try {
      const wheel = await this.open();
      if (this.pages.size) void wheel.follow();
      await wheel.tick();
    } catch (error: any) {
      console.error('Wheel alarm:', error.message);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // Every player shares the one wheel.
    return env.WHEEL.get(env.WHEEL.idFromName('wheel')).fetch(request);
  },
};
