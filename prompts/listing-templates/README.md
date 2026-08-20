# AI Prompt Templates — Title & Description Generation

The single source of truth for the Etsy copy this project writes. Same skeleton every time — keyword-rich title → opening hook → product details → why-you'll-love-it → shipping/policy → CTA — so buyers instantly recognise the format across all three
stores. Mirrors the SummerCosta dress template in Notion (Product Development → Product Listing Template).

**One file per shop, plus what's shared:**

- [common.md](common.md) — Universal instructions, output formats, and the generic
  fallback. Applies to every shop.
- [summercosta.md](summercosta.md), [fourpillarmatcha.md](fourpillarmatcha.md),
  [babysprouttoys.md](babysprouttoys.md) — one file per shop, each named to match that
  shop's `shops/<slug>.env`. Holds that shop's `shop-details` and every one of its
  category templates.

**Two ways this gets used:**

1. **By hand** — copy the _Universal instructions_ block from `common.md`, the _Manual
   output format_ block, and the block for the product's category from the relevant
   shop file. Fill in the `[bracketed]` fields from the supplier listing / dispatch
   sheet, paste into Claude or ChatGPT, get back a ready-to-publish title + description.
2. **Automatically** — `npm run publish -- --shop=<name>` reads every `.md` file in
   this directory ([lib/prompt-templates.js](../../lib/prompt-templates.js)), picks the
   block matching that shop and the row's `Category`, and sends it as Claude's system
   prompt along with the row's raw facts and the item's photos. Editing any file here
   changes what the agent writes — no code change needed.

## Editing rules (so the automated path keeps working)

- The `<!-- ... -->` markers are what the parser reads. Headings, emoji and prose
  around them are for humans and can be changed freely.
- Every marker applies to the **next fenced code block** below it. Keep one fenced
  block per marker.
- `<!-- shop: <slug> | match: a, b -->` — one at the top of each shop file. `<slug>`
  must match the shop's filename in [shops/](../../shops/) (`shops/<slug>.env`), and by
  convention also this file's own name (`<slug>.md`). Everything below it in the file
  belongs to that shop.
- `<!-- category: <Name> | match: a, b, c -->` — `match` is the list of `Category`
  cell values that should pick this block. Matching ignores case and punctuation, so
  `match: dress` also catches "Dresses", "Midi Dress", "women's dress".
- `match: *` marks a shop's catch-all, used when no other category in that shop matches.
- Adding a new category = add a marker + a fenced block to that shop's file. Adding a
  new shop = add a new `<shop-slug>.md` file here with at least a `shop-details` block
  and a `match: *` catch-all category, matching a `shops/<slug>.env`.
- `[bracketed]` fields left unfilled stay bracketed in the generated draft on purpose —
  that's the flag for what to fill in before publishing. Never let the AI guess a
  fabric, material, measurement or safety claim.

## Notes

- All templates intentionally reuse the same section skeleton across categories and
  stores — buyers browsing multiple listings see a consistent, trustworthy format, and
  batch-generation stays fast since only the middle "PRODUCT DETAILS" section changes
  shape per category.
- The `[ ]` empty brackets mean: pull that fact from the supplier's product page /
  dispatch sheet before running the prompt — don't let the AI invent fabric, materials,
  or safety claims. In the automated path the agent works from the row's `Category`,
  `1688 Title` and `Keywords` plus the photos, so anything it can't see there comes back
  bracketed for you to fill in on the draft.
- The `shop-details` blocks are the one place to fill in each store's real shipping
  window, carrier, returns window and store link. Fill them in once and every listing
  from that shop stops coming back with `[X] days` placeholders.
