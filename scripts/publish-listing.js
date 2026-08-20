// Run once a day (via cron / Task Scheduler / Claude Code) with
// `npm run publish -- --shop=<name>`. Picks the first row in that shop's
// "Listings" sheet with a blank Status AND whose "Scheduled Date" (if set)
// is today or earlier — see isDueToday below. A blank "Scheduled Date"
// behaves exactly as before (eligible immediately), so this is fully
// backward compatible with sheets that don't use the column at all. Drafts
// Etsy title/tags/description from Category/1688 Title/Keywords + the
// photos in its linked "Photo URL" Drive folder (already pre-processed —
// no background removal here), and creates the listing as a DRAFT on Etsy.
// Nothing is ever auto-published live — you review and publish each one
// yourself in Etsy's Listings Manager, then write the result back into that
// row.
//
// Everything else in the sheet (Processing/Shipping profile, Who made it,
// Feature/Ads/Renewal/Returns, When was it made) is reference-only for
// now — this shop's defaults from shops/<name>.env are used instead.
// Wiring those up as real per-row overrides would need Etsy API lookups
// to match profile names to IDs.
//
// The title/description/tag copy follows the per-shop, per-category
// templates in prompts/listing-templates/ (one file per shop, plus
// common.md) — edit those files to change the house style; no code
// change needed.
//
// Variations ("Variation 1/2 name/values") ARE read and sent to Etsy — see
// buildVariationProducts below.
//
// "Shop section" IS read and applied — the agent matches it against the
// shop's existing sections by title (case-insensitive) and creates a new
// section if none matches. If that lookup fails (e.g. a missing OAuth
// scope), it's logged as a warning and the listing is still created
// without a section, rather than failing the whole row — see
// resolveShopSectionId below.

import { SHOP, updateShopEnvValue } from "../lib/env.js";
import { etsyFetch } from "../lib/proxy.js";
import { getRows, updateRowFields } from "../lib/sheets.js";
import { listFolderContents, downloadFile, folderIdFromUrl } from "../lib/drive.js";
import { draftListingCopy } from "../lib/claude.js";

const {
  ETSY_API_KEY,
  ETSY_SHARED_SECRET,
  ETSY_SHOP_ID,
  ETSY_REFRESH_TOKEN,
  ETSY_SHIPPING_PROFILE_ID,
  ETSY_READINESS_STATE_ID,
  ETSY_DEFAULT_TAXONOMY_ID,
  ETSY_WHO_MADE,
  ETSY_WHEN_MADE,
  GOOGLE_SHEET_ID,
} = process.env;

// As of the shops set up in this project (Aug 2026), Etsy's v3 API rejects
// x-api-key with just the keystring — it needs "keystring:shared_secret".
// Undocumented as of the last written docs; confirmed empirically via curl
// against /application/openapi-ping (keystring-only -> 403, combined -> 200).
const API_KEY_HEADER = `${ETSY_API_KEY}:${ETSY_SHARED_SECRET}`;

// ⚠️ Etsy's own docs contradict themselves on whether `price` is dollars
// or cents for this endpoint. Draft ONE test listing, check the price
// that actually shows up on Etsy, then set this to 1 (dollars) or 100
// (cents) to match. Don't trust this on autopilot until you've checked.
const PRICE_MULTIPLIER = 1;

const REQUIRED_COLUMNS = ["Category", "Price (AU$)", "Photo URL"];

// ---- Scheduling ----

// "Scheduled Date" is optional — a row with no date behaves exactly as
// before (eligible as soon as its Status is blank). A row with a date is
// only eligible once that date has arrived, so you can queue up a week's
// worth of listings in advance and have one go out per day on its own day
// (or catch up if a run gets missed — "on or before today" rather than an
// exact-day match, so nothing silently waits forever for a run that never
// happened on the exact date).
// Accepts both "2026-08-20" (typed as plain text) and "2026/8/20" (Google
// Sheets' own display format for a real date-typed cell, no zero-padding
// guaranteed) — a date picked from the sheet's calendar UI comes back from
// the API as the latter, not the former.
function parseSheetDate(value) {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  const valid =
    date.getFullYear() === Number(y) &&
    date.getMonth() === Number(m) - 1 &&
    date.getDate() === Number(d);
  return valid ? date : null;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Malformed dates are treated as "due" rather than silently skipped forever
// — the row gets picked up and immediately flagged as Status=Error below
// (same as any other bad data in the row), so a typo surfaces instead of
// leaving the row stuck with no explanation.
function isDueToday(row, today) {
  const raw = (row["Scheduled Date"] || "").trim();
  if (!raw) return true;
  const date = parseSheetDate(raw);
  if (!date) return true;
  return date <= today;
}

// ---- Etsy ----

async function getAccessToken() {
  const res = await etsyFetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ETSY_API_KEY,
      refresh_token: ETSY_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  // Etsy rotates the refresh token on every use — save the new one or the
  // old one can go stale well before its nominal 90-day life.
  if (data.refresh_token && data.refresh_token !== ETSY_REFRESH_TOKEN) {
    updateShopEnvValue("ETSY_REFRESH_TOKEN", data.refresh_token);
  }
  return data.access_token;
}

function etsyHeaders(token, extra = {}) {
  return {
    "x-api-key": API_KEY_HEADER,
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function getShopSections(token) {
  const res = await etsyFetch(
    `https://api.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/sections`,
    { headers: etsyHeaders(token) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`getShopSections failed: ${JSON.stringify(data)}`);
  return data.results || [];
}

async function createShopSection(token, title) {
  const res = await etsyFetch(
    `https://api.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/sections`,
    {
      method: "POST",
      headers: etsyHeaders(token, { "Content-Type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ title }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`createShopSection failed: ${JSON.stringify(data)}`);
  return data;
}

// Matches the row's "Shop section" value against the shop's existing
// sections by title (case-insensitive) and creates a new section if none
// matches — sections are just organizational folders in the shop, low
// stakes to create on the fly, unlike anything price/taxonomy-related.
async function resolveShopSectionId(token, title) {
  const wanted = title.trim().toLowerCase();
  const sections = await getShopSections(token);
  const match = sections.find((s) => s.title.trim().toLowerCase() === wanted);
  if (match) return match.shop_section_id;
  const created = await createShopSection(token, title.trim());
  return created.shop_section_id;
}

async function createDraftListing(token, item) {
  const body = new URLSearchParams({
    quantity: item.quantity || "1",
    title: item.title,
    description: item.description,
    price: String(Number(item.price) * PRICE_MULTIPLIER),
    who_made: ETSY_WHO_MADE,
    when_made: ETSY_WHEN_MADE,
    taxonomy_id: item.taxonomy_id || ETSY_DEFAULT_TAXONOMY_ID,
    shipping_profile_id: ETSY_SHIPPING_PROFILE_ID,
    readiness_state_id: ETSY_READINESS_STATE_ID,
    ...(item.tags ? { tags: item.tags } : {}),
    ...(item.sku ? { sku: item.sku } : {}),
    ...(item.shopSectionId ? { shop_section_id: String(item.shopSectionId) } : {}),
  });

  const res = await etsyFetch(
    `https://api.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings`,
    {
      method: "POST",
      headers: etsyHeaders(token, {
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body,
    }
  );
  const data = await res.json();
  if (!res.ok)
    throw new Error(`createDraftListing failed: ${JSON.stringify(data)}`);
  return data;
}

// Etsy has two reserved property_ids for variations that don't map to one
// of its own standardized properties (Color, Size, etc.) — using them means
// any variation name/values the sheet has typed in just works, with no
// lookup against Etsy's taxonomy-specific property/value IDs needed. Etsy
// only allows this for the first two variations; a third would have to be
// a real taxonomy property instead, which is why the sheet only has two.
const CUSTOM_VARIATION_PROPERTY_IDS = [513, 514];

// Reads "Variation 1 name"/"Variation 1 values" and "Variation 2
// name"/"Variation 2 values" into [{ name, values: string[] }] — one entry
// per variation slot that's actually filled in. Values are comma-separated
// in the sheet. Throws if a slot is half-filled (name with no values or
// vice versa), or if slot 2 is used without slot 1 — both are almost
// certainly a typo in the row rather than something to guess past.
function readVariationGroups(row) {
  const groups = [];
  for (const slot of [1, 2]) {
    const name = (row[`Variation ${slot} name`] || "").trim();
    const valuesRaw = (row[`Variation ${slot} values`] || "").trim();
    if (!name && !valuesRaw) continue;
    if (!name || !valuesRaw) {
      throw new Error(
        `"Variation ${slot} name" and "Variation ${slot} values" must both be set, or both left blank`
      );
    }
    if (slot === 2 && groups.length === 0) {
      throw new Error(`"Variation 2" is set but "Variation 1" is blank — fill in Variation 1 first`);
    }
    const values = valuesRaw.split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) {
      throw new Error(`"Variation ${slot} values" has no usable values after splitting on commas`);
    }
    groups.push({ name, values });
  }
  return groups;
}

// One product per combination of variation values (Color x Size => a
// product for every color/size pair) — Etsy requires every combination to
// be listed explicitly, there's no shorthand for "applies to all sizes".
// Price and quantity are the same across every combination, taken from the
// row's own Price/Quantity columns, same as the non-variation listing path.
function buildVariationProducts(groups, { price, quantity, sku }) {
  let combos = [[]];
  for (const group of groups) {
    combos = combos.flatMap((combo) =>
      group.values.map((value) => [...combo, { name: group.name, value }])
    );
  }

  return combos.map((combo) => ({
    // Confirmed by testing against a live draft (Aug 2026): once
    // updateListingInventory is called, its products array fully replaces
    // whatever SKU createDraftListing set — leaving sku blank here doesn't
    // "leave the listing's SKU alone", it wipes it (listing.skus comes
    // back []). So the row's one SKU has to be repeated on every product,
    // not left off — sub-items don't get a SEPARATE SKU of their own,
    // they all carry the item's single SKU. Etsy requires SKU to be
    // identical across every product when sku_on_property is empty (same
    // reasoning as price/quantity being uniform), which this satisfies.
    sku: sku || "",
    offerings: [
      {
        price: Number(price) * PRICE_MULTIPLIER,
        quantity: Number(quantity) || 1,
        is_enabled: true,
        // Confirmed by testing against a live draft (Aug 2026): unlike
        // createDraftListing, where readiness_state_id is set once at the
        // listing level, the inventory endpoint rejects every offering
        // with "All offerings need readiness state" unless it's repeated
        // here per offering too.
        readiness_state_id: Number(ETSY_READINESS_STATE_ID),
      },
    ],
    property_values: combo.map((c, i) => ({
      property_id: CUSTOM_VARIATION_PROPERTY_IDS[i],
      property_name: c.name,
      value_ids: [],
      values: [c.value],
      scale_id: null,
    })),
  }));
}

async function setListingVariations(token, listingId, products) {
  const res = await etsyFetch(
    `https://api.etsy.com/v3/application/listings/${listingId}/inventory`,
    {
      method: "PUT",
      headers: etsyHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        products,
        // Empty = price/quantity/sku don't vary by property, even though
        // each product above happens to repeat the same price/quantity —
        // matches "same price and quantity for every combination".
        price_on_property: [],
        quantity_on_property: [],
        sku_on_property: [],
      }),
    }
  );
  const data = await res.json();
  if (!res.ok)
    throw new Error(`setListingVariations failed: ${JSON.stringify(data)}`);
  return data;
}

async function uploadListingImage(token, listingId, buffer, filename) {
  const form = new FormData();
  form.append("image", new Blob([buffer]), filename);

  const res = await etsyFetch(
    `https://api.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`,
    { method: "POST", headers: etsyHeaders(token), body: form }
  );
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      `uploadListingImage failed for ${filename}: ${JSON.stringify(data)}`
    );
  return data;
}

// ---- Main ----

async function main() {
  if (!GOOGLE_SHEET_ID) {
    throw new Error(
      `GOOGLE_SHEET_ID not set for shop "${SHOP}" — add it to shops/${SHOP}.env`
    );
  }

  console.log(
    `[${new Date().toISOString()}] Checking sheet for shop "${SHOP}" (${ETSY_SHOP_ID})...`
  );

  const rows = await getRows(GOOGLE_SHEET_ID);
  const pending = rows.filter((r) => !r.Status || !r.Status.trim());
  const today = startOfToday();
  const row = pending.find((r) => isDueToday(r, today));

  if (!row) {
    console.log(
      pending.length > 0
        ? `No rows due today — ${pending.length} row(s) waiting for a future Scheduled Date.`
        : "No rows waiting — nothing to draft today."
    );
    return;
  }

  const scheduledNote = (row["Scheduled Date"] || "").trim();
  console.log(
    `Selected row ${row._row}: ${row["Category"] || "(uncategorized)"}` +
      (scheduledNote ? ` (scheduled ${scheduledNote})` : "")
  );

  const missing = REQUIRED_COLUMNS.filter((col) => !row[col]);
  if (missing.length > 0) {
    const message = `Missing ${missing.map((c) => `"${c}"`).join(", ")}`;
    await updateRowFields(GOOGLE_SHEET_ID, row._row, { Status: "Error", Error: message });
    throw new Error(`Row ${row._row}: ${message}`);
  }

  if (scheduledNote && !parseSheetDate(scheduledNote)) {
    const message = `"Scheduled Date" is not a valid date (expected YYYY-MM-DD): "${scheduledNote}"`;
    await updateRowFields(GOOGLE_SHEET_ID, row._row, { Status: "Error", Error: message });
    throw new Error(`Row ${row._row}: ${message}`);
  }

  // Claim the row before the expensive work (Drive download, Claude call,
  // Etsy draft + image uploads — 30-90+ seconds) starts. Without this, two
  // runs that both start while Status is still blank will each draft the
  // same row independently, creating two separate Etsy listings with only
  // the one that finishes last recorded in the sheet — confirmed happening
  // in practice (Aug 2026) when a manual run overlapped with another.
  await updateRowFields(GOOGLE_SHEET_ID, row._row, { Status: "Drafting" });

  try {
    const variationGroups = readVariationGroups(row);

    const folderId = folderIdFromUrl(row["Photo URL"]);
    const files = await listFolderContents(folderId);
    const images = files.filter((f) => f.mimeType.startsWith("image/"));
    if (images.length === 0) {
      throw new Error(`No image files found in the linked Drive folder`);
    }

    console.log(`Downloading ${images.length} photo(s)...`);
    const imageBuffers = [];
    for (const img of images) {
      imageBuffers.push({ buffer: await downloadFile(img.id), mimeType: img.mimeType });
    }

    const brief = {
      category: row["Category"],
      raw_title_1688: row["1688 Title"],
      fabric: row["Fabric"],
      keywords: row["Keywords"],
      price: row["Price (AU$)"],
      quantity: row["Quantity"] || "1",
      sku: row["SKU"],
    };

    console.log("Drafting title/tags/description with Claude...");
    const copy = await draftListingCopy(brief, imageBuffers, SHOP);
    // Worth watching: a "(catch-all)" here means the row's Category didn't
    // match any block in that shop's prompts/listing-templates/<shop>.md, so the copy came out
    // of that shop's generic skeleton rather than a category-specific one.
    console.log(`Prompt template: ${copy.template} — ${copy.tags.length} tags`);

    const token = await getAccessToken();

    let shopSectionId;
    const shopSection = (row["Shop section"] || "").trim();
    if (shopSection) {
      try {
        shopSectionId = await resolveShopSectionId(token, shopSection);
        console.log(`Shop section: "${shopSection}" -> section_id ${shopSectionId}`);
      } catch (err) {
        // Not fatal — a section is just organization within the shop, not
        // something that makes the listing itself wrong. Log it clearly so
        // it doesn't go unnoticed (e.g. a missing OAuth scope needs a
        // one-time re-auth, not a retry) and carry on without one.
        console.warn(`⚠️  Could not set shop section "${shopSection}": ${err.message} — continuing without one.`);
      }
    }

    console.log("Creating draft listing on Etsy...");
    const draft = await createDraftListing(token, {
      title: copy.title,
      description: copy.description,
      tags: copy.tags.join(","),
      price: row["Price (AU$)"],
      quantity: row["Quantity"] || "1",
      sku: row["SKU"],
      shopSectionId,
    });
    console.log(`Draft created: listing_id ${draft.listing_id}`);

    if (variationGroups.length > 0) {
      const products = buildVariationProducts(variationGroups, {
        price: row["Price (AU$)"],
        quantity: row["Quantity"] || "1",
        sku: row["SKU"],
      });
      console.log(
        `Setting variations: ${variationGroups.map((g) => g.name).join(" x ")} — ${products.length} combination(s)...`
      );
      await setListingVariations(token, draft.listing_id, products);
    }

    console.log(`Uploading ${imageBuffers.length} image(s)...`);
    for (let i = 0; i < imageBuffers.length; i++) {
      await uploadListingImage(token, draft.listing_id, imageBuffers[i].buffer, images[i].name);
    }
    // Note: if an image upload throws above, the run stops here — the
    // listing stays as an unpublished draft on Etsy, and the row stays
    // Status=Error rather than Drafted, so nothing gets silently lost.

    const draftUrl = `https://www.etsy.com/your/shops/me/listing-editor/edit/${draft.listing_id}`;

    await updateRowFields(GOOGLE_SHEET_ID, row._row, {
      Status: "Drafted",
      Title: copy.title,
      Description: copy.description,
      Tags: copy.tags.join(", "),
      "Etsy Draft URL": draftUrl,
    });

    console.log(`✅ Drafted (not live) — review and publish yourself: ${draftUrl}`);
  } catch (err) {
    await updateRowFields(GOOGLE_SHEET_ID, row._row, {
      Status: "Error",
      Error: err.message,
    }).catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error("❌ Run failed:", err.message);
  console.error(
    "If a row was found, it's marked Status=Error in the sheet — fix it and clear Status to retry."
  );
  process.exit(1);
});
