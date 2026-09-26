# HookedIn Roulette

European roulette with one wheel for the whole table: every player's chips ride the same spin. A reference game for [HookedIn](https://play.hookedin.com), and the example of a game played **against the house by many players at once**: every player's own wallet places a developer bet, and the game's wheel backs the whole table with a short walk of casino bets of its own.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Roulette. It is hosted at `roulette-game.hookedin.com`.

This repository is also a GitHub template: the starting point for a game with a server of its own. Page and server are one Cloudflare Worker, and every push tests them and a push to `main` deploys them. How a game works, the bridge, the SDK and the casino are documented at **[hookedin.com/docs](https://hookedin.com/docs/)**.

## How to play

1. Choose a chip and click the layout: a number, red or black, odd or even, low or high, a dozen or a column. Right-click takes a chip off.
2. Press **Place bets**. The first time, your wallet asks how much the game may play with. A bet is final once it is in.
3. The wheel spins twenty seconds after the first chip at the table is down.
4. The ball lands for everyone at once. A number returns 36 for 1, a dozen or a column 3 for 1, and the even-money bets 2 for 1. Zero is the house's: that is the whole 2.7% edge.

The wheel plays with ETH. A wallet that practices with test coins watches the table, and bets once it has a funded channel: a developer bet is settled by the wheel at the casino, and practice never reaches the casino.

## How it works

Every spin is a walk down a binary tree of the 37 pockets, one round of the wheel's per level. The pieces are:

- **The table** ([src/table.ts](src/table.ts)): the pockets are the tree's leaves, in `ORDER`, and a player's whole layout is **one developer bet** whose meta names its chips. The wallet signs it whole, so the player's wallet, not this page, establishes what was offered.
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to place them in the group of the table's spin, and works out the landed number itself from the casino's record of each of the spin's rounds, read through the wallet and checked against the spin its bet named.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the game's developer, with the key of the account the game is published from. For each spin it opens six rounds, named by the casino, and works out the hashes of the seeds its casino bets on them will bring; the spin's ID is the hash of both lists, and it names the spin to the pages before anybody bets. Twenty seconds after the first chip on it is down, it walks the tree: what it owes on each pocket, priced backward against half the casino's bankroll with the SDK's [binary steps](https://hookedin.com/docs/sdk/steps/), one casino bet from its bank per level, which reveals that level's round. It keeps the spin, and pays every bet what it is owed. It is built on `createDeveloper` from the SDK's [developer kit](https://hookedin.com/docs/sdk/developer/), and never touches a bet.
- **The casino**: names each round by the hash of a secret, puts each player's stake in the wheel's bank as the bet is placed, records each bet's group and meta, and admits each of the wheel's casino bets against the bankroll like any other, before it reads the round's secret. It reads none of the scheme.
- **Each player's wallet**: signs the developer bet, sends it to the casino itself, collects what the wheel's signed settlement pays before it sends the page the receipt, and reads the casino's record of a round for the page.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, one Durable Object, on the same origin.

### The flow

1. The page polls `GET /api/table`: `{spin, closesAt, now, players, staked}`, the spin to bet on, when the wheel spins, and who is at the table. The page counts down to `closesAt` against `now`, the wheel's clock, not its own.
2. The page calls `HookedIn.developerBet({id, stake, group: spin, meta: {chips}})`, the chips being each spot's amount, having saved `id`, the chips and the spin first. The wallet signs a debit whose details carry both and sends it to the casino, which puts the stake in the wheel's bank: it leaves the game's balance at once, and the bet is final.
3. The page tells the wheel somebody bet (`POST /api/table/placed`). The wheel believes the casino, not the page: it reads the open developer bets in its spin's group, and spins twenty seconds after the first was placed, by the casino's clock.
4. At the time, the wheel covers every open bet in the spin's group whose chips are a roulette layout: known spots, whole amounts, adding up to its stake. It works out what it owes on each pocket to all of them together, and saves that with the list of covered bets and the bankroll it prices against before its first step. Then it walks: at each level it places `stepBet` on that level's round, in the spin's group, with `{side}` in its meta, the half of the pockets that needs more cash, which the walk goes to when the round's outcome is below the bet's chance; the first step's meta also holds `{covered}`, the `keccak256` of the covered bets' hashes, one after another in the order they were placed. Whichever way a round goes, the bank then holds what the rest of the walk needs, and at the pocket exactly what the wheel owes there. A level whose halves need the same cash, or whose stake the bank cannot pay, only reveals its round, and the walk goes left below the left half's share; a level the bankroll declines is revealed all the same. Either way the walk goes on, and the bank carries that level itself. The wheel keeps the spin, `{id, rounds, seedHashes, covered, number}`, at `GET /api/spins/:spin`, pays each covered bet what its chips pay on the number, and gives every other bet its stake back: one that is not a layout, and one that came too late for the walk. The wheel's next look opens the next spin. A wheel whose step's reply was lost finds the round revealed, and walks on from there.
5. Once the table has moved on from its spin, the page asks its wallet about the bet (`HookedIn.receipt(id)`), so the wallet looks at once: it collects what the wheel paid and sends the settled receipt, which the page hears with `HookedIn.onReceipt`. The page reads the spin from `GET /api/spins/:spin` and checks it: the rounds and seed hashes hash to the spin its bet named, and for each level `HookedIn.round` gives the casino's record of the round, whose secret hashes to it, whose seed hashes to the level's seed hash, whose casino bet is in the spin's group, and whose first step commits to the covered bets. It walks the steps with `stepOutcome`, each the way its casino bet signed, to the number, and spins to it. A bet the spin did not cover got its stake back, and its chips stay on the layout for the next spin.

After a reload the page finds its saved bet's receipt with `HookedIn.receipt(id)`.

### Files

| Path                                                               | What                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, a layout as one bet's chips, what the wheel owes, a spin's ID. Shared by the page and the wheel        |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                                          |
| [server/wheel.ts](server/wheel.ts)                                 | The developer: the spin, its bets, the clock, the walk it keeps. Everything outside is handed in, so it runs in a test |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds the wheel                                                                 |
| [test/](test/)                                                     | The table's arithmetic, its walk against the casino's own admission rule, and the wheel against a stub casino          |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                                             |
| [wrangler.jsonc](wrangler.jsonc)                                   | The Worker: its name and route, the Durable Object, the vars, and the build it runs before every deploy                |
| [.github/workflows/](.github/workflows/)                           | Deploy on push to `main`; take play's newest `main` every six hours                                                    |
| [package.json](package.json)                                       | `build`, `dev`, `typecheck`, `test`, `format`; `@hookedin/play` from play's `main`, whose commit the lockfile records  |

## Fairness and trust

The casino knows nothing of this scheme: it records each bet's group and meta when it takes the bet, and each of the wheel's casino bets and its meta when it reveals that bet's round. With the spin the wheel keeps, that is enough for anyone to check every spin.

- **The page never holds keys or money.** The wallet signs the layout whole, and the casino records it as the player signed it.
- **The spin is fixed before anybody bets.** The casino names each of the spin's rounds by the hash of a secret, and the wheel works out the hash of the seed its casino bet on each will bring before the table opens. The spin's ID is the hash of the rounds and then the seed hashes, and every bet names it as its group, which the casino records when it takes the bet. A round's outcome is `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`, low 64 bits.
- **Nobody can choose the number, and neither knows it alone.** The wheel never sees a secret before its casino bet reveals it, and the casino never sees a seed. The side each step backs is signed in its casino bet before its round is revealed, and whichever side a step names, each half of the pockets is reached as often as its share: a pocket is off its 1 in 37 by less than one outcome in 2^64 per level. A step the bankroll declines, or the bank cannot pay, moves money between the bankroll and the wheel's bank, and each half of the pockets is reached as often as its share all the same. Together the casino and the wheel could know the number in advance, but not change it: a round or a seed other than the ones the spin named shows at once. Knowing it, they could leave winning layouts off the list of bets the walk covers, which a check of the spin shows, and so does the page of every bet left off.
- **The bets a spin covers are fixed before the ball lands.** The first step's meta commits to the list of bets the walk covers, and that step is placed before any of the spin's rounds is revealed.
- **Anyone can check a spin**, with nothing but the casino's public API and the spin the wheel keeps:
  1. `GET /api/spins/:spin` at the wheel gives the spin's rounds, their seed hashes, the bets it covered and its number. The rounds and then the seed hashes, `keccak256` one after another, are the spin's ID.
  2. `GET /api/rounds/:round` at the casino gives, for each round down to the pocket, the seed, the secret, the outcome and the wheel's casino bet with its group and meta, which the developer signed over the seed's hash and the meta's hash. The secret hashes to the round and the seed to its seed hash; the first step's `meta.covered` is the `keccak256` of the covered bets' hashes; `stepOutcome` from `@hookedin/play/sdk/steps` walks the steps, each to the side its casino bet names, or the left for a round only revealed, to the pocket, and `ORDER` names its number. The page does exactly this, through the player's wallet.
  3. `GET /api/developer-bets?game=<key>&status=settled&group=<spin>` at the casino lists the settled bets on the spin, whatever the wheel says, a page at a time (pass `cursor` as `after` while `more` is true), and `status=open` any it has yet to pay. Each settlement pays a covered bet its chips on the number, and every other its stake. A layout on the spin left off the list shows here. `GET /api/games/:key?group=<spin>` lists the players' bets and the wheel's casino bets on the spin together.
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
- A different shared game is a different [src/table.ts](src/table.ts): its equally likely outcomes, in `ORDER`, and what a player's choices are owed on each. A wheel of fortune is one outcome per segment, and the wheel's server stays as it is; so is a crash game whose players all set their cash-out before the round, with outcomes as fine as its crash points need. A game whose players decide while the round runs cannot be walked in advance. A crash game with cash-out by hand is such a game, even for the cash-outs set before the round: to know when to crash, its server would have to reveal its rounds at take-off, and a revealed round is public, so every page would know the crash point. Its server keeps the crash point itself and settles every [developer bet](https://hookedin.com/docs/games/developer-bets/) on its word.
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

You earn half of the commission on the wheel's casino bets. It accrues to the account you publish the game from; the casino keeps the other half. See [pricing and commission](https://hookedin.com/docs/reference/economics/).

## Deploy

1. Under **Settings → Secrets and variables → Actions**, add the secret `CLOUDFLARE_API_TOKEN` (from Cloudflare's **Edit Cloudflare Workers** template) and the variable `CLOUDFLARE_ACCOUNT_ID`.
2. Once, give the Worker the key of the account the game is published from: `npx wrangler secret put DEVELOPER_KEY`. The Worker then holds everything that account holds: its games, their commission and its bank. When the casino's bankroll is large beside the table, the bank needs no money of its own: the stakes of the bets the wheel covers pay for the walk, and what its steps pay pays the winners. Against a small bankroll a walk costs more than the stakes, and a step the bank cannot pay is carried by the bank itself.
3. Push to `main`: [Deploy](.github/workflows/deploy.yml) type-checks, tests, builds and publishes the Worker, which keeps its `DEVELOPER_KEY` from one deploy to the next. Every six hours [Update play](.github/workflows/update-play.yml) takes play's newest `main`, which carries the SDK and the casino's protocol, and when the tests pass commits the lockfile and deploys.

`npx wrangler deploy` publishes it by hand; `wrangler.jsonc` builds the page first.

The build writes `dist/_headers`, which Cloudflare applies by itself. The header that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that too.

## Get listed

Publish it yourself: in the wallet of the account the manifest's `developer` names, open **My games** and give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](https://github.com/hookedin/play/blob/main/catalog.json) in play; open an issue or a pull request there to be in it.

## Tests

```sh
npm test
```

This type-checks the page, the tests and the server, the server against Cloudflare's Workers types, then runs [test/](test/) and [server/worker.test.ts](server/worker.test.ts) with `node --import tsx --test`, because `@hookedin/play` ships TypeScript and Node does not strip types inside `node_modules`. They check the table's arithmetic and its walk against the casino's own admission rule, and test the wheel, the spins it keeps and its Durable Object against a stub casino. Developer bets and the wallet's handling of them are tested in [play](https://github.com/hookedin/play) and the casino service; see [testing](https://hookedin.com/docs/games/testing/).

## License

[MIT](LICENSE)
