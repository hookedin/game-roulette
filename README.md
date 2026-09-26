# HookedIn Roulette

European roulette with one wheel for the whole table: every player's chips ride the same spin. A reference game for [HookedIn](https://play.hookedin.com), and the example of a game played **against the house by many players at once**: every player's own wallet places a developer bet, and the game's wheel backs the whole table with one casino bet of its own.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Roulette. It is hosted at `roulette-game.hookedin.com`.

This repository is also a GitHub template: the starting point for a game with a server of its own. Page and server are one Cloudflare Worker, and every push tests them and a push to `main` deploys them. How a game works, the bridge, the SDK and the casino are documented at **[hookedin.com/docs](https://hookedin.com/docs/)**.

## How to play

1. Choose a chip and click the layout: a number, red or black, odd or even, low or high, a dozen or a column. Right-click takes a chip off.
2. Press **Place bets**. The first time, your wallet asks how much the game may play with. A bet is final once it is in.
3. The wheel spins twenty seconds after the first chip at the table is down.
4. The ball lands for everyone at once. A number returns 36 for 1, a dozen or a column 3 for 1, and the even-money bets 2 for 1. Zero is the house's: that is the whole 2.7% edge.

There is a wheel for each asset: you join the one for what your wallet plays with, ETH or test coins.

## How it works

Every spin is one round of the wheel's. The pieces are:

- **The table** ([src/table.ts](src/table.ts)): the wheel's 37 pockets are 37 stretches of the spin's 64-bit outcome, and a player's whole layout is **one developer bet** whose meta names its chips. The wallet signs it whole, so the player's wallet, not this page, establishes what was offered.
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to place them in the group of the table's round with the round's seed hash in their meta, and works out the landed number itself from the spin the wheel kept, checked against the hashes its bet named.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the game's developer, with the key of the account the game is published from. It opens the table's round, named by the casino, saves it with the hash of the seed its casino bet on it will bring, and names both to the pages before anybody bets. Twenty seconds after the first chip on it is down, it spins: it places one casino bet on the round, from its bank, of every layout on the table together, whose meta is the hash of the list of bets it covers, which reveals the round; it keeps the spin with that list, and pays every bet what it is owed. It is built on `createDeveloper` from the SDK's [developer kit](https://hookedin.com/docs/sdk/developer/), and never touches a bet.
- **The casino**: names the table's round by the hash of a secret, puts each player's stake in the wheel's bank as the bet is placed, records each bet's group and meta, and admits the wheel's casino bet against the bankroll like any other, before it reads the round's secret. It reads none of the scheme.
- **Each player's wallet**: signs the developer bet, sends it to the casino itself, and collects what the wheel's signed settlement pays before it sends the page the receipt.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, a Durable Object per asset, on the same origin. The page names its asset with `?asset=`.

### The flow

1. The page polls `GET /api/table`: `{round, seedHash, closesAt, now, players, staked}`, the round to bet on and the hash of the seed the wheel's casino bet on it will bring, when the wheel spins, and who is at the table. The page counts down to `closesAt` against `now`, the wheel's clock, not its own.
2. The page calls `HookedIn.developerBet({id, stake, group, meta: {seedHash, chips}})`, the group being the round's 64 hex digits and the chips each spot's amount, having saved `id`, the chips, the round and the seed hash first. The wallet signs a debit whose details carry both and sends it to the casino, which puts the stake in the wheel's bank: it leaves the game's balance at once, and the bet is final.
3. The page tells the wheel somebody bet (`POST /api/table/placed`). The wheel believes the casino, not the page: it reads the open developer bets in its round's group, and spins twenty seconds after the first was placed, by the casino's clock.
4. At the time, the wheel places its casino bet on the round it saved, covering every open bet in its group that names the round's seed hash and whose chips are a roulette layout: known spots, whole amounts, adding up to its stake. Its stake is theirs together and its prizes are theirs added up, at most one per pocket: red and black hedge each other, and ten players on one number stack. Its meta is `{covered}`, the `keccak256` of the covered bets' hashes, one after another in the order they were placed; the wheel saves the list before it places the bet. The casino admits it against the bankroll and reveals the round; the number is `pocket(outcome)`, the same for every player. The wheel keeps the spin, `{round, seed, secret, number, accepted, covered}`, at `GET /api/spins/:round`, pays each covered bet what its chips pay there, and gives every other bet its stake back: one that is not a layout on the table's seed, one that came too late for the spin, and every bet on a spin the bankroll declines. The wheel's next look opens the next round. A wheel whose casino bet reply was lost places it again on the round it saved, with the bets it saved, and gets the same answer.
5. Once the table has moved on from its round, the page asks its wallet about the bet (`HookedIn.receipt(id)`), so the wallet looks at once: it collects what the wheel paid and sends the settled receipt, which the page hears with `HookedIn.onReceipt`. The page reads the spin from `GET /api/spins/:round`, checks the secret against the round and the seed against the seed hash its bet named, works out the number from them, and spins to it. A bet the spin did not cover got its stake back, and its chips stay on the layout for the next spin.

After a reload the page finds its saved bet's receipt with `HookedIn.receipt(id)`.

### Files

| Path                                                               | What                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, a layout as one bet's chips, and the table's layouts together. Shared by the page and the wheel         |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                                           |
| [server/wheel.ts](server/wheel.ts)                                 | The developer: the round, its bets, the clock, the spin it keeps. Everything outside is handed in, so it runs in a test |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds an asset's wheel                                                           |
| [test/](test/)                                                     | The table's arithmetic against the casino's own admission rule, and the wheel against a stub casino                     |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                                              |
| [wrangler.jsonc](wrangler.jsonc)                                   | The Worker: its name and route, the Durable Object, the vars, and the build it runs before every deploy                 |
| [.github/workflows/](.github/workflows/)                           | Deploy on push to `main`; take play's newest `main` every six hours                                                     |
| [package.json](package.json)                                       | `build`, `dev`, `typecheck`, `test`, `format`; `@hookedin/play` from play's `main`, whose commit the lockfile records   |

## Fairness and trust

The casino knows nothing of this scheme: it records each bet's group and meta when it takes the bet, and the wheel's casino bet and its meta when it reveals the round. With the list of bets the wheel keeps for each spin, that is enough for anyone to check every spin.

- **The page never holds keys or money.** The wallet signs the layout whole, and the casino records it as the player signed it.
- **The spin is fixed before anybody bets.** The casino names the table's round by the hash of a secret, and the wheel publishes the hash of its seed before the table opens; every bet names the round by its group and the seed hash in its meta, and the casino records both when it takes the bet. The outcome is `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`, low 64 bits.
- **Nobody can choose the number, and neither knows it alone.** The wheel never sees the secret before its casino bet reveals it, and the casino never sees the seed. Together they could know it in advance, but not change it: a seed other than the one every bet named shows at once. Knowing it, they could leave winning layouts off the list of bets the spin covers, which a check of the spin shows, and so does the page of every bet left off.
- **The bets a spin covers are fixed before the ball lands.** The wheel's casino bet commits in its meta to the list of bets it covers, and it is that bet that reveals the round.
- **Anyone can check a spin**, with nothing but the casino's public API and the spin the wheel keeps:
  1. `GET /api/rounds/:round` at the casino gives the seed, the secret, the outcome and the wheel's casino bet with its meta, which the developer signed over the seed's hash and the meta's hash. The secret hashes to the round, the seed to the seed hash, and the number is `pocket(outcome)`.
  2. `GET /api/spins/:round?asset=eth` (or `test`) at the wheel gives the list of bets it covered; its `keccak256`, the hashes one after another, is `meta.covered`.
  3. `GET /api/developer-bets?game=<key>&status=settled&group=<round's 64 hex digits>` at the casino lists the settled bets on the spin, whatever the wheel says, a page at a time (pass `cursor` as `after` while `more` is true), and `status=open` any it has yet to pay. Every covered bet names the seed hash, and each settlement pays its chips on the number, or its stake if the list leaves it off or the spin was declined. A layout on the table's seed left off the list shows here.
- **A roulette bet is a developer bet: it trusts the wheel's developer to pay.** Its stake is in the developer's bank from the moment it is placed, and it is paid what the wheel settles. The page shows what that falls short of what the wheel's own list says the bet is owed, and what its chips would have won if the list leaves it off; a check of the spin shows the same for every bet. What it is paid is the casino's promise until the wallet collects it: until then it is outside the principal the contract protects, as the [trust model](https://hookedin.com/docs/overview/trust-model/) says.

Read [developer bets](https://hookedin.com/docs/games/developer-bets/) before you build on this.

## Run it

You need Node 24.4 or later.

```sh
npm install
npm run dev
```

`npm run dev` is `wrangler dev`: it builds the page into `dist/` as it starts, and again whenever `src/` changes, and serves page and wheel together at `http://127.0.0.1:8790`. The wheel signs with the key of the account you publish the game from: put `DEVELOPER_KEY=0x…` in a `.dev.vars` file, which git ignores, or run `npm run dev -- --var DEVELOPER_KEY:0x…`. `GAME_NAME` in [wrangler.jsonc](wrangler.jsonc) is the name you publish the game under: the two make its key.

The casino the wheel talks to must be the one the players' wallets use. It is the `CASINO_URL` in [wrangler.jsonc](wrangler.jsonc), the public deployment's casino; for another, add `--var CASINO_URL:` and its casino (the `casino` value in the wallet's `config.js`). Then set `developer` in [src/manifest.json](src/manifest.json) to that account's address, publish the game under `GAME_NAME` with `http://127.0.0.1:8790/manifest.json` from that account's wallet, and open it.

## Make it your game

Create your repository with **Use this template**, then change first:

- [src/manifest.json](src/manifest.json): `name`, `description` and `developer`, the address of the account you publish the game from.
- [wrangler.jsonc](wrangler.jsonc): `name`, `routes` (a domain on your Cloudflare account; without them the game is served at `<name>.<your-subdomain>.workers.dev`) and `GAME_NAME`, the name you publish the game under.
- `package.json`: the package `name` and `repository`.
- A different shared game is a different [src/table.ts](src/table.ts): what the outcome means and how a player's choices become prizes. A wheel of fortune is one range per segment, and the wheel's server stays as it is; so is a crash game whose players all set their cash-out before the round, each cash-out one prize. A game whose players decide while the round runs cannot be one round. A crash game with cash-out by hand is such a game, even for the cash-outs set before the round: to know when to crash, its server would have to reveal the round at take-off, and a revealed round is public, so every page would know the crash point. Its server keeps the crash point itself and settles every [developer bet](https://hookedin.com/docs/games/developer-bets/) on its word.
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

You earn half of the commission on the wheel's casino bets. It accrues to the account you publish the game from; the casino keeps the other half. See [pricing and commission](https://hookedin.com/docs/reference/economics/).

## Deploy

1. Under **Settings → Secrets and variables → Actions**, add the secret `CLOUDFLARE_API_TOKEN` (from Cloudflare's **Edit Cloudflare Workers** template) and the variable `CLOUDFLARE_ACCOUNT_ID`.
2. Once, give the Worker the key of the account the game is published from: `npx wrangler secret put DEVELOPER_KEY`. The Worker then holds everything that account holds: its games, their commission and its bank. The bank needs no money of its own: the stakes of the bets the wheel covers pay its casino bet, and what that bet pays pays the winners.
3. Push to `main`: [Deploy](.github/workflows/deploy.yml) type-checks, tests, builds and publishes the Worker, which keeps its `DEVELOPER_KEY` from one deploy to the next. Every six hours [Update play](.github/workflows/update-play.yml) takes play's newest `main`, which carries the SDK and the casino's protocol, and when the tests pass commits the lockfile and deploys.

`npx wrangler deploy` publishes it by hand; `wrangler.jsonc` builds the page first.

The build writes `dist/_headers`, which Cloudflare applies by itself. The header that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that too.

## Get listed

Publish it yourself: in the wallet of the account the manifest's `developer` names, open **My games** and give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](https://github.com/hookedin/play/blob/main/catalog.json) in play; open an issue or a pull request there to be in it.

## Tests

```sh
npm test
```

This type-checks the page, the tests and the server, the server against Cloudflare's Workers types, then runs [test/](test/) and [server/worker.test.ts](server/worker.test.ts) with `node --import tsx --test`, because `@hookedin/play` ships TypeScript and Node does not strip types inside `node_modules`. They check the table's arithmetic against the casino's own admission rule, and test the wheel, the spins it keeps and its Durable Object against a stub casino. Developer bets and the wallet's handling of them are tested in [play](https://github.com/hookedin/play) and the casino service; see [testing](https://hookedin.com/docs/games/testing/).

## License

[MIT](LICENSE)
