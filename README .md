# Etsy Auto-Listing

Every day, this checks a Google Sheet for the next row waiting to be listed, pulls that item's pre-processed photos from its linked Drive folder, has Claude write an Etsy-SEO title/tags/description from the row's raw facts, and creates the listing on Etsy as a **draft** — photos uploaded, price/quantity/category all filled in. Nothing is ever auto-published live; you review and publish each one yourself in Etsy's Listings Manager.

One shop = one `shops/<name>.env` file + one Google Sheet + one scheduled run. With three stores, you'll set this up three times (see **Multiple shops** below) — the code doesn't change, just the config, and adding shop #4 later needs no code or `package.json` edits.

## Tech stack

- **Runtime:** Node.js ≥18, plain ES modules (no build step, no framework)
- **AI:** [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) (Claude) — writes title/tags/description from each row's raw facts and photos
- **Google:** [`googleapis`](https://www.npmjs.com/package/googleapis) — Sheets (reads/writes the `Listings` row) and Drive (downloads each item's photos), authorized once via OAuth as your own Google account
- **Etsy:** direct REST calls via [`undici`](https://www.npmjs.com/package/undici) (no official Etsy SDK), one OAuth app + refresh token per shop
- **Local OAuth flows:** `express` (temporary localhost server to catch the redirect) + `open` (launches the browser tab) — used only by `npm run auth` / `npm run auth-google`, not in the daily `publish` run
- **Config:** `dotenv`, layered — root `.env` for shared credentials (Google, Anthropic), `shops/<name>.env` (gitignored) for per-shop Etsy/proxy/sheet config
- **Structure:** `lib/` shared modules (`claude.js`, `sheets.js`, `drive.js`, `google-auth.js`, `proxy.js`, `env.js`), `scripts/` CLI entry points (`publish-listing.js`, `get-etsy-token.js`, `get-google-token.js`, `find-shop-ids.js`), `prompts/listing-templates/` for per-shop/category copy templates (one file per shop, plus `common.md`)
- No database — the Google Sheet row *is* the state/queue (`Status` column)

## The pipeline

```
You: pre-process photos, upload to a Drive folder for this item
You: add a row to the shop's "Listings" sheet — raw facts + a link to that folder
                                              |
                                   [daily] npm run publish -- --shop=<name>
                                              |
      agent finds the first row with a blank Status whose Scheduled Date
      (if any) is today or earlier
                                        --> downloads photos from the row's linked Drive folder
                                        --> Claude writes title + tags + description from the row's raw facts,
                                            following this shop+category's block in prompts/listing-templates/<shop>.md
                                        --> creates the Etsy listing as a DRAFT (never published live)
                                        --> sets variations if the row has any (Variation 1/2 name/values)
                                        --> writes Title/Description/Tags/Etsy Draft URL back into the row, Status = Drafted
                                              |
                                  You: review the draft in Etsy's Listings Manager, publish it yourself
```

- **You, manually:** pre-process each item's photos yourself (background removal, cropping, whatever you need) and upload the finished images into a Drive folder for that item — anywhere in your Drive, any name.
- **You, manually:** add a row to that shop's **Listings** sheet with the raw facts (see schema below) and a link to that folder. Leave `Status` blank.
- **The agent, daily:** finds the first row with a blank `Status`, downloads photos from its linked folder, sends the raw facts + photos to Claude for title/tags/description, creates the Etsy listing as a draft, uploads the photos, and writes the result back into that row (`Status = Drafted`).
- **You:** review the draft — including the AI-written title and description — in Etsy's Listings Manager, and publish it yourself whenever you're happy with it.

AI never publishes anything live — that step is always yours.

## The Google Sheet

One tab per shop's spreadsheet, named exactly **`Listings`**. One row per item. Column headers (order doesn't matter, only the names — must match exactly, case-sensitive).

**Active — the script actually reads/writes these:**

- `Photo URL` — link to (or bare folder ID of) this item's pre-processed photo folder (a *folder*, not a single image — the script uploads every image file it finds inside)
- `Category` — required; raw fact for Claude
- `1688 Title` — the raw (often Chinese) title copied straight off the supplier listing; Claude translates + rewrites it, doesn't invent facts beyond it
- `Fabric` — raw fact for Claude (what the item is made of)
- `Keywords` — raw fact for Claude
- `Price (AU$)` — required (whatever unit your shop's `PRICE_MULTIPLIER` expects — see setup step 7)
- `Quantity` — defaults to 1 if blank
- `SKU`
- `Scheduled Date` — optional. Accepts `YYYY-MM-DD` (typed as plain text) or `YYYY/M/D` (Google Sheets' own display format for a real date-typed cell — no zero-padding needed, e.g. `2026/8/20`). If set, the agent won't draft this row until today's date is on or after it (so a missed run still catches up rather than skipping the row forever — it's "on or before today," not an exact-day match). Leave blank to keep the old behavior: eligible as soon as `Status` is blank, no date needed.
- `Status` — leave **blank** for anything waiting to be drafted; the agent claims a row by writing `Drafting` here the moment it's selected (before the slow Drive/Claude/Etsy work starts, so two overlapping runs can't both grab the same row), then `Drafted` or `Error` once it finishes
- `Title` / `Description` / `Tags` — Claude's output, filled in by the agent
- `Etsy Draft URL` — filled in by the agent; link to review/publish the draft in Etsy
- `Error` — filled in by the agent; the failure reason, only set when `Status = Error`
- `Variation 1 name` / `Variation 1 values` — optional; e.g. name `Color`, values `Red, Blue, Green` (comma-separated). Leave both blank for a listing with no variations.
- `Variation 2 name` / `Variation 2 values` — optional second variation, e.g. name `Size`, values `S, M, L`. Requires Variation 1 to also be filled in — every Variation-1-value × Variation-2-value combination becomes its own product on the listing (Color×Size above makes 9). Price and quantity are the same across every combination, taken from that row's `Price (AU$)` and `Quantity` columns — there's no per-combination price/stock column.

**Reference-only — kept in the sheet for your own tracking, but not read by the script; this shop's `shops/<name>.env` defaults are used instead:** `When was it made`, `Processing profile`, `Shipping profile/option`, `Who made it`, `What is it`, `Shop section`, `Feature this listing`, `Etsy Ads`, `Renewal option`, `Returns & exchanges policy`. There's no `Taxonomy ID` column, so taxonomy always comes from the shop's `ETSY_DEFAULT_TAXONOMY_ID` — no per-row override.

A row's `Status` **is** its state — there's no separate queue or folder to keep in sync, so the agent never re-drafts a row it's already processed, and a row's photo folder is always identified by its explicit link, never by folder creation order (so re-processing/re-uploading photos into an existing folder never risks getting matched to the wrong row).

## One-time setup

### 0. Shared config (once, not per shop)

```
npm install
cp .env.example .env    # fill in ANTHROPIC_API_KEY (see step 6)
```

This is the same for every shop, so it lives in the root `.env`, not in a per-shop file. Google Drive + Sheets access (below) is shared the same way — it's one login as your own Google account, since every shop's folders and sheet live in that same personal Google account.

**Set up Google Drive + Sheets access:**

1. In [Google Cloud Console](https://console.cloud.google.com), create a
   project (or use an existing one) and enable the **Google Drive API** and
   the **Google Sheets API** (search each in the top search bar → Enable).
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**. If prompted, configure the OAuth consent screen first
   (External user type is fine for personal use).
3. Application type: **Web application**. Add this exact authorized
   redirect URI:

   ```
   http://localhost:3004/oauth/callback
   ```

   (A service account + downloadable JSON key would normally be simpler for
   a script like this, but Google now blocks key creation by default on new
   projects, with no override for personal/non-Workspace accounts — hence
   OAuth as your own account instead.)

4. Copy the **Client ID** and **Client secret** into the root `.env` as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. **Publish the app** — OAuth consent screen → **Publish App** → confirm.
   Skipping this leaves the app in "Testing" status, which forces
   `GOOGLE_REFRESH_TOKEN` to expire every 7 days regardless of use; publishing
   removes that cap (it stays unverified, which is fine for personal use —
   you'll just see a one-time "Google hasn't verified this app" warning
   during step 6, click **Advanced → Go to [app name] (unsafe)** to proceed).
6. Run `npm run auth-google` — opens a browser tab, you approve access to
   your own Google account, and the terminal prints `GOOGLE_REFRESH_TOKEN`
   to paste into `.env`.

No folder- or sheet-sharing step needed — since this authorizes as _you_, the script can already see everything in your own Drive and Sheets.

## One-time setup (per shop)

### 1. Register an Etsy Seller App

**Register a separate Seller App per shop** — don't reuse one app's
key/secret across shops; each shop gets its own keystring + shared secret.
Go to [etsy.com/developers/register-seller-app](https://www.etsy.com/developers/register-seller-app) and create one — this path is for sellers building tools for
their own shop, and it's approved automatically, no waiting.

Under the app's settings, add this exact redirect URI:

```
http://localhost:3003/oauth/redirect
```

(Etsy allows `http://localhost` specifically for this kind of local/personal testing, even though production apps need `https://`. If Etsy's dashboard rejects it, use a free tool like [ngrok](https://ngrok.com) to get a temporary `https://` URL instead and update `ETSY_REDIRECT_URI` to match. The same redirect URI value can be registered on all your shops' apps — it's just where the local OAuth server listens.)

Copy the new app's **keystring** and **shared secret** into `shops/<name>.env`
(see step 3).

### 2. If this shop is run through a proxy, set that up _before_ authorizing

If you operate this shop through a proxy (e.g. IPRoyal via AdsPower) to keep
it looking independent from your other stores, set `PROXY_URL` in
`shops/<name>.env` now — before running `npm run auth` in the next step.
Etsy sees the OAuth authorization itself as a login, so it has to come from
the same IP the shop normally uses, not just the daily publish calls.

```
PROXY_URL=http://username:password@host:port
```

Leave it blank for any shop that runs on this machine's regular IP.

### 3. Get a refresh token for this shop

```
cp shops/example.env.example shops/<name>.env    # e.g. shops/summercosta.env
# fill in ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_REDIRECT_URI, PROXY_URL
npm run auth -- --shop=<name>
```

This opens a browser tab, you approve access to your shop, and the terminal
prints `ETSY_SHOP_ID` and `ETSY_REFRESH_TOKEN` — paste both into
`shops/<name>.env`.

### 4. Set up this shop's Listings sheet

1. Create a new Google Sheet for this shop (anywhere in your Drive).
2. Rename its first tab to exactly **`Listings`**.
3. Add the header row. At minimum, the **active** columns the script reads/writes: `Photo URL`, `Category`, `1688 Title`, `Keywords`, `Price (AU$)`, `Quantity`, `SKU`, `Status`, `Title`, `Description`, `Tags`, `Etsy Draft URL`, `Error`, plus `Variation 1 name`, `Variation 1 values`, `Variation 2 name`, `Variation 2 values` for any item that has variations, and `Scheduled Date` if you want to queue items up for specific days (order doesn't matter, names must match exactly). Add any of the **reference-only** columns too if you want them for your own tracking — see "The Google Sheet" above for the full list.
4. Copy the Sheet's ID from its URL
   (`docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`) into
   `shops/<name>.env` as `GOOGLE_SHEET_ID`.

No sharing step needed — Drive/Sheets access is already authorized as you (step 0).

### 5. Find your shipping profile, processing profile, and category IDs

```
npm run find-ids -- --shop=<name>
```

This lists your existing shipping profiles and processing profiles (if you
don't have any yet, add one in Etsy's own Shop Manager first — it's a
one-time thing per shop) and lets you search Etsy's category tree for a
`taxonomy_id`. Paste the IDs you want into `shops/<name>.env` as your shop's
defaults (`ETSY_SHIPPING_PROFILE_ID`, `ETSY_READINESS_STATE_ID`,
`ETSY_DEFAULT_TAXONOMY_ID`) — these apply to every listing from this shop,
there's no per-row override (see "The Google Sheet" above).

### 6. Set up AI copywriting (title + description)

Get an API key from [console.anthropic.com](https://console.anthropic.com)
and paste it into the root `.env` as `ANTHROPIC_API_KEY`. On each item,
Claude gets the row's raw facts (`Category`, `1688 Title`, `Keywords`) plus
its photos, and returns a finished `Title`, `Tags`, and `Description` —
translating the raw (often Chinese) `1688 Title` into English as part of
the rewrite. It only uses what's in those columns, it doesn't invent
materials, dimensions, or claims that aren't there.

**What it writes is controlled by `prompts/listing-templates/`** — one file
per shop (plus a shared `common.md`), with one block per product category (dress / matching set / top / pant,
matcha bowl set / incense burner / tea cup, educational toy / baby gift /
crochet toy / pretend play), each with its own title format and description
section skeleton. The agent picks the block matching `--shop=<name>` and
that row's `Category`, so every listing from a shop comes out in the same
recognisable format. Editing the copy style is a Markdown edit in that file
— no code change. The same file doubles as copy/paste prompts if you'd
rather write a listing by hand in a chat window.

Before your first real run, fill in the `shop-details` block for each shop
in that file (store link, dispatch window, carrier, returns window).
Anything left in `[brackets]` there comes back bracketed in the draft — the
agent leaves the placeholder visible rather than inventing a shipping time,
so it's obvious what to fill in before you publish.

**Tags come from your verified lists, not from the AI.** Each category block
in that file carries a `<!-- tags -->` list — the search terms you've already
checked against Etsy's trending data. Those go on the listing verbatim and in
order, every time. If a category's list is shorter than Etsy's 13-tag limit,
the remaining slots are filled first by tags the AI writes from that specific
item, then from the shop's `<!-- shop-tags -->` top-up pool. The agent
re-applies this after the AI responds, so the verified tags land even if the
model ignores the instruction, and Etsy's limits (max 13 tags, max 20
characters each) are enforced before the API call — an overlong tag rejects
the whole listing.

| Shop | Categories with verified tags | Top-up pool |
| --- | --- | --- |
| SummerCosta | Dress, Jumpsuits & Rompers, Tops, Pants | — (AI fills the rest) |
| FourPillarsMatcha | Matcha Bowl Set, Incense Burner | your 18-term "Board Tag" list |
| BabySproutToys | Educational/Montessori, Toy Gifts, Nursery Items, Exploring Toys | terms shared across those four lists |

If a row's `Category` doesn't match any block, the agent falls back to that
shop's catch-all skeleton and the run logs `Prompt template: <shop> /
... (catch-all) — 13 tags` — add a `category:` block for it if you list that
type often.

### Variations (optional)

If an item has variations (color, size, etc.), fill in `Variation 1 name` /
`Variation 1 values` (and `Variation 2 name` / `Variation 2 values` for a
second dimension) on that row — see "The Google Sheet" above for the exact
format. Leave all four blank for a single-SKU listing.

Any variation name typed into those columns works — `Color`, `Size`,
`Material`, `Scent`, whatever the item needs — because it's sent to Etsy as
a custom variation rather than matched against Etsy's own predefined
property list, so there's no risk of a value getting silently rejected for
not matching Etsy's exact spelling. The tradeoff is Etsy's limit: only the
first two variations on a listing can be custom like this, which is why
there are two variation slots in the sheet and not three.

The run log shows what was sent, e.g.:
```
Setting variations: Color x Size — 6 combination(s)...
```

### Scheduling for a specific day (optional)

Leave `Scheduled Date` blank on a row and it behaves exactly like before —
eligible for drafting as soon as `Status` is blank, picked in sheet order.

Fill it in (`YYYY-MM-DD` or `YYYY/M/D`, e.g. `2026-08-25` or `2026/8/25`) to hold a row back until that
day: the daily run skips it until today's date reaches that value, so you
can add a whole batch of rows up front — say, one per day for the next two
weeks — and have them go out on their own schedule instead of all at once.
It's "on or before today," not an exact-day match, so if a run gets missed
(computer off, cron didn't fire) the row is still picked up on the next run
rather than being skipped forever.

Each run still only drafts **one** row — the first eligible one in the
sheet — same as always. If several rows share a due date, they go out on
separate days in sheet order, one per run.

### 7. Run a test listing before trusting it on autopilot

Add one real row to the sheet (leave `Status` blank), then:

```
npm run publish -- --shop=<name>
```

Check the draft it creates in Etsy's Listings Manager: **is the price
correct?** Etsy's own API docs contradict themselves about whether `price`
means dollars or cents. If your $45 item shows up as $4,500 (or $0.45), open
`scripts/publish-listing.js` and change `PRICE_MULTIPLIER` from `1` to `100`
(or vice versa), then test again. Also check the photos landed correctly,
the AI-written title/description actually reflect the raw facts you put in
the row, and every other field matches — this is the one pass worth doing
by hand before you let it run unattended every day.

## Running it daily

One cron line per shop, each passing its own `--shop=<name>`:

```
0 9 * * * cd /path/to/etsy-auto-listing && npm run publish -- --shop=summercosta >> log-summercosta.txt 2>&1
5 9 * * * cd /path/to/etsy-auto-listing && npm run publish -- --shop=shop2 >> log-shop2.txt 2>&1
```

(Staggering the minutes avoids both shops' Etsy/Drive/proxy calls firing at
the exact same instant — not required, just tidy.)

`SHOP=summercosta npm run publish` works the same as `-- --shop=summercosta`
if you prefer setting an env var (e.g. from Task Scheduler, where passing
extra CLI args is more awkward).

**Windows Task Scheduler:** create one daily task per shop, each running
`npm run publish` with `SHOP=<name>` set in the task's environment and
"Start in" set to this folder.

**Claude Code / Claude Cowork:** ask it to run `npm run publish -- --shop=<name>`
in this folder on a schedule per shop, or trigger it manually whenever you want.

Each run only processes one row (the first with a blank `Status`) — running
more than once a day just means it works through the queue faster, and rows
already `Drafted` are never picked up again.

## Multiple shops

The codebase is shared; only config is per shop, split into two layers:

- **Root `.env`** — config that's the same for every shop: Google Drive +
  Sheets OAuth (`GOOGLE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`), `ANTHROPIC_API_KEY`.
- **`shops/<name>.env`** (gitignored) — everything specific to one shop: its
  own Etsy app (own keystring + shared secret — don't reuse one app across
  shops), `ETSY_SHOP_ID`, `ETSY_REFRESH_TOKEN`, its shipping/processing
  profile IDs, its `GOOGLE_SHEET_ID`, and its `PROXY_URL` if it has one.

To add a new shop (now or a year from now — no code or `package.json`
changes needed):

```
cp shops/example.env.example shops/<name>.env
# fill it in, then walk One-time setup (per shop) above for that shop
npm run auth -- --shop=<name>
npm run find-ids -- --shop=<name>
```

Then run any script against that shop with `--shop=<name>` (or `SHOP=<name>`
as an env var):

```
npm run publish -- --shop=<name>
npm run find-ids -- --shop=<name>
```

`lib/env.js` loads the root `.env` first, then overlays `shops/<name>.env`
on top — if you forget `--shop`/`SHOP`, every script fails fast and lists
the shops it found configured under `shops/`, rather than silently running
against the wrong (or no) shop.

## Safety notes

- Listings are **always** created as drafts, never published live — that
  step is manual, on purpose. That matters more now that titles and
  descriptions are AI-written: you're the last check before anything's
  visible to buyers.
- Claude only uses the `Category` / `1688 Title` / `Keywords` columns per
  row — it doesn't invent materials, dimensions, or claims that aren't in
  those columns. Facts it can't confirm come back as visible `[brackets]`
  in the draft rather than as guesses, so an unfilled bracket in a draft is
  working as intended — fill it in before publishing. This matters most for
  BabySproutToys: never let a safety certification or age rating through
  that you haven't verified yourself.
- If a row fails (missing required column, no images in its linked folder,
  Etsy API error, etc.), the agent sets `Status = Error` and writes the
  reason into the `Error` column — it does **not** retry automatically, so a
  broken row can't burn API calls every day. Fix the row and clear `Status`
  back to blank to have it picked up again.
- If uploading a photo fails partway through a run, the draft is left as-is
  on Etsy (unpublished) and the row is marked `Status = Error` rather than
  `Drafted`, so nothing gets silently lost or half-finished.
- If a run is killed outright (process crash, machine sleeps mid-run) after
  claiming a row but before finishing, the row is left stuck on
  `Status = Drafting` forever rather than being auto-retried — clear it back
  to blank by hand to have it picked up again. This is rare (the claim only
  matters for the one process that got killed) but worth knowing so a stuck
  row doesn't look like a mystery.
- For proxied shops, double-check `PROXY_URL` is set correctly — a wrong or
  missing proxy on a shop that's supposed to have one is the kind of
  mistake Etsy's multi-account detection is specifically looking for.
- Etsy's refresh token rotates on every use and nominally lasts 90 days —
  the scripts save the newly-rotated token back into `shops/<name>.env`
  automatically on every run, so as long as the shop runs at least every 90
  days it keeps renewing itself. If it ever stops working anyway, run
  `npm run auth -- --shop=<name>` again.
- Google's refresh token doesn't rotate and has no fixed expiry (unlike
  Etsy's) — it only breaks if unused for 6+ months, manually revoked at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions),
  or if the OAuth consent screen was never published (see setup step 0.5).
