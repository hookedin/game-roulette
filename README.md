# HookedIn Roulette

European roulette with one wheel for the whole table: every player's chips ride the same spin. A reference game for [HookedIn](https://play.hookedin.com), and the example of a game played **against the house by many players at once**: every player's own wallet places a developer bet, and the game's wheel backs the whole table with a short walk of casino bets of its own.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Roulette. It is hosted at `roulette-game.hookedin.com`.

This repository is also a GitHub template: the starting point for a game with a server of its own. Page and server are one Cloudflare Worker, and every push tests them and a push to `main` deploys them. How a game works, the bridge, the SDK and the casino are documented at **[hookedin.com/docs](https://hookedin.com/docs/)**.

## How to play

1. Pick a chip and tap the board: a number, red or black, odd or even, 1–18 or 19–36, a dozen or a column (2:1). **Undo** takes back the last chip, **Clear** empties the board, and right-click or Shift-click takes a chip off.
2. Press **Place bets**, or Space. The first time, your wallet asks how much the game may play with. A bet is final once it is in.
3. The wheel spins every 20 seconds, for everyone at once, whether or not anybody bets, and takes no bets in the last 3 seconds of each turn.
4. A number returns 36 for 1, a dozen or a column 3 for 1, and the even-money bets 2 for 1. Zero is the house's: that is the whole 2.7% edge. Your chips stay on the board: **Bet again** places them on the next spin.

On a phone the board stands up, and the wheel comes over it while it spins.

## How it works

Every spin is a walk down a binary tree of the 37 pockets, one round of the wheel's per level. The pieces are:

- **The table** ([src/table.ts](src/table.ts)): the pockets are the tree's leaves, in `ORDER`, and a player's whole layout is **one developer bet** whose meta names its chips. The wallet signs it whole, so the player's wallet, not this page, establishes what was offered.
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to place them in the group of the table's spin, and works out the landed number itself from the casino's record of each of the spin's rounds, read through the wallet and checked against the spin its bet named.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the game's developer, with the key of the account the game is published from. For each spin it opens six rounds, named by the casino, and works out the hashes of the seeds its casino bets on them will bring; the spin's ID is the hash of both lists, and it names the spin to the pages before anybody bets. Every 20 seconds, when the turn comes, it walks the tree: what it owes on each pocket, priced backward against the casino's virtual bankroll, half its bankroll, with the SDK's [binary steps](https://hookedin.com/docs/sdk/steps/), one casino bet from its bank per level, which reveals that level's round. It keeps the spin, and pays every bet what it is owed. It is built on `createDeveloper` from the SDK's [developer kit](https://hookedin.com/docs/sdk/developer/), and never touches a bet.
- **The casino**: names each round by the hash of a secret, puts each player's stake in the wheel's bank as the bet is placed, records each bet's group and meta, and admits each of the wheel's casino bets against its virtual bankroll, before it reads the round's secret. It reads none of the scheme.
- **Each player's wallet**: signs the developer bet, sends it to the casino itself, collects what the wheel's signed settlement pays before it sends the page the receipt, and reads the casino's record of a round for the page.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, one Durable Object, on the same origin.

### The flow

The Worker answers two routes. `GET /api/live` is a stream of server-sent events: the table as it stands, then each change as it happens, and the table every 3 seconds while nothing changes; the table is the spin to bet on, when the wheel turns (by the wheel's clock), who is at the table and where the last turns landed. While a page watches, the wheel follows the game's bets from the casino, not the page: the casino holds each read until a bet is placed, so a bet joins the table as soon as the wallet has placed it. `GET /api/spins/:spin` gives a spin the wheel kept. A player's layout is one developer bet in the spin's group. At the turn the wheel covers every layout in the group, walks the tree one casino bet per level, pays each covered bet what its chips pay on the number and gives every other bet its stake back; a turn with no layout on it lands at random and reveals nothing, so it costs the casino nothing. The page then checks the spin as below, through the player's wallet. [Developer bets](https://hookedin.com/docs/games/developer-bets/) goes through it step by step, and [server/wheel.ts](server/wheel.ts) is the code.

### Files

| Path                                                               | What                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, a layout as one bet's chips, what the wheel owes, a spin's ID. Shared by the page and the wheel        |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                                          |
| [src/icon.svg](src/icon.svg)                                       | The icon the wallet shows the game by: a square SVG of one symbol                                                      |
| [server/wheel.ts](server/wheel.ts)                                 | The developer: the spin, its bets, the clock, the walk it keeps. Everything outside is handed in, so it runs in a test |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds the wheel                                                                 |
| [test/](test/)                                                     | The table's arithmetic, its walk against the casino's own admission rule, and the wheel against a stub casino          |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                                             |
| [wrangler.jsonc](wrangler.jsonc)                                   | The Worker: its name and route, the Durable Object, the vars, and the build it runs before every deploy                |
| [.github/workflows/](.github/workflows/)                           | Test and build on every push; deploy on push to `main`                                                                 |
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
  3. `GET /api/developer-bets?game=<key>&status=settled&group=<spin>` at the casino lists the settled bets on the spin, whatever the wheel says, a page at a time (pass `cursor` as `after` while `more` is true), and `status=open` any it has yet to pay. Each settlement pays a covered bet its chips on the number, and every other its stake. A layout on the spin left off the list shows here.
- **A roulette bet is a developer bet: it trusts the wheel's developer to pay.** Its stake is in the game's bank from the moment it is placed, and it is paid what the wheel settles. The page shows what that falls short of what the wheel's own list says the bet is owed, and what its chips would have won if the list leaves it off; a check of the spin shows the same for every bet. What it is paid is the casino's promise until the wallet collects it: until then it is outside the principal the contract protects, as the [trust model](https://hookedin.com/docs/overview/trust-model/) says.

Read [developer bets](https://hookedin.com/docs/games/developer-bets/) before you build on this.

## Run it

You need Node 26 or later.

```sh
npm install
npm run dev
```

`npm run dev` is `wrangler dev`: it builds the page into `dist/` as it starts, and again whenever `src/` changes, and serves page and wheel together at `http://127.0.0.1:8790/`. Publish the game with `http://127.0.0.1:8790/` from your wallet's **Developer** page. The wheel names the game by its ID, which that page shows beside it, and signs with the game's server key: a key you make for the wheel and name on the same page, or your account's own until you name one. Put `GAME=0199…` and `SERVER_KEY=0x…` in a `.dev.vars` file, which git ignores, or pass them with `npm run dev -- --var GAME:0199… --var SERVER_KEY:0x…`, and open the game.

The casino the wheel talks to must be the one the players' wallets use. It is the `CASINO_URL` in [wrangler.jsonc](wrangler.jsonc), the public deployment's casino; for another, add `--var CASINO_URL:` and its casino (the `casino` value in the wallet's `config.js`).

## Make it your game

Create your repository with **Use this template**, then change first:

- [wrangler.jsonc](wrangler.jsonc): `name`, `routes` (a domain on your Cloudflare account; without them the game is served at `<name>.<your-subdomain>.workers.dev`) and `GAME`, your game's ID, which the wallet's **Developer** page shows once you publish it.
- `package.json`: the package `name` and `repository`.
- [src/icon.svg](src/icon.svg): the icon the wallet shows your game by, a square SVG of one symbol that fills the square, with no rounded background of its own: the wallet rounds its corners ([the icon](https://hookedin.com/docs/games/publishing/#the-icon)).
- A different shared game is a different [src/table.ts](src/table.ts): its equally likely outcomes, in `ORDER`, and what a player's choices are owed on each. A wheel of fortune is one outcome per segment, and the wheel's server stays as it is; so is a crash game whose players all set their cash-out before the round, with outcomes as fine as its crash points need. A game whose players decide while the round runs, such as a crash game with cash-out by hand, cannot be walked in advance: its server keeps the outcome itself and settles every [developer bet](https://hookedin.com/docs/games/developer-bets/) on its word.
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

Half of the commission on the wheel's casino bets goes into the game's bank, with the stakes of its players' bets; the casino keeps the other half. You take money out of the bank into your balance on the **Developer** page. See [pricing and commission](https://hookedin.com/docs/reference/economics/).

## Deploy

1. Under **Settings → Secrets and variables → Actions**, add the secret `CLOUDFLARE_API_TOKEN` (from Cloudflare's **Edit Cloudflare Workers** template) and the variable `CLOUDFLARE_ACCOUNT_ID`.
2. Once, make a key for the Worker, name its address as the game's server key on the wallet's **Developer** page, and give the Worker the key: `npx wrangler secret put SERVER_KEY`. The key spends the game's bank on the wheel's casino bets and settlements and nothing else: it cannot move the game, take money out of the bank or touch your balance. When the casino's bankroll is large beside the table, the bank needs no money of its own: the stakes of the bets the wheel covers pay for the walk, and what its steps pay pays the winners. Against a small bankroll a walk costs more than the stakes, and a step the bank cannot pay is carried by the bank itself.
3. Push to `main`: [Deploy](.github/workflows/deploy.yml) type-checks, tests, builds and publishes the Worker, which keeps its `SERVER_KEY` from one deploy to the next. `@hookedin/play`, which carries the SDK and the casino's protocol, is play's newest `main` at every build; a build on `main` commits the lockfile it tested, and play's release runs this workflow whenever its `main` moves.

`npx wrangler deploy` publishes it by hand; `wrangler.jsonc` builds the page first.

The build writes `dist/_headers`, which Cloudflare applies by itself: the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that.

## Get listed

Publish it yourself: in your wallet, open **Developer** and give the game its name and its URL. It is then at the address its name makes for anyone with a wallet: `Super Roulette` is at `@<your name>/super-roulette`. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](https://github.com/hookedin/play/blob/main/catalog.json) in play; open an issue or a pull request there to be in it.

## Tests

```sh
npm test
```

This type-checks the page, the tests and the server, the server against Cloudflare's Workers types, then runs [test/](test/) and [server/worker.test.ts](server/worker.test.ts) with `node --import tsx --test`, because `@hookedin/play` ships TypeScript and Node does not strip types inside `node_modules`. They check the table's arithmetic and its walk against the casino's own admission rule, and test the wheel, the spins it keeps and its Durable Object against a stub casino. Developer bets and the wallet's handling of them are tested in [play](https://github.com/hookedin/play) and the casino service; see [testing](https://hookedin.com/docs/games/testing/).

## License

[MIT](LICENSE)
