// Run once per shop (after `npm run auth`) with
// `npm run find-ids -- --shop=<name>`. Prints your shipping profiles,
// processing profiles, and lets you search Etsy's category tree for a
// taxonomy_id — the three values that go in ETSY_SHIPPING_PROFILE_ID,
// ETSY_READINESS_STATE_ID, and ETSY_DEFAULT_TAXONOMY_ID in shops/<name>.env.
//
// If you don't have a shipping profile or processing profile yet, this
// script also offers to create simple default ones for you.

import { SHOP, updateShopEnvValue } from "../lib/env.js";
import readline from "readline/promises";
import { etsyFetch } from "../lib/proxy.js";

const { ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_SHOP_ID } = process.env;

// As of the shops set up in this project (Aug 2026), Etsy's v3 API rejects
// x-api-key with just the keystring — it needs "keystring:shared_secret".
// Undocumented as of the last written docs; confirmed empirically via curl
// against /application/openapi-ping (keystring-only -> 403, combined -> 200).
const API_KEY_HEADER = `${ETSY_API_KEY}:${ETSY_SHARED_SECRET}`;

async function getAccessToken() {
  const res = await etsyFetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ETSY_API_KEY,
      refresh_token: process.env.ETSY_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  // Etsy rotates the refresh token on every use — save the new one or the
  // old one can go stale well before its nominal 90-day life.
  if (data.refresh_token && data.refresh_token !== process.env.ETSY_REFRESH_TOKEN) {
    updateShopEnvValue("ETSY_REFRESH_TOKEN", data.refresh_token);
  }
  return data.access_token;
}

async function etsy(path, token, options = {}) {
  const res = await etsyFetch(`https://api.etsy.com/v3/application${path}`, {
    ...options,
    headers: {
      "x-api-key": API_KEY_HEADER,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  console.log(`Looking up IDs for shop "${SHOP}"...`);
  const token = await getAccessToken();

  console.log(`\n=== Shipping profiles for shop ${ETSY_SHOP_ID} ===`);
  const shipping = await etsy(
    `/shops/${ETSY_SHOP_ID}/shipping-profiles`,
    token
  );
  if (shipping.results.length === 0) {
    console.log("None yet.");
  } else {
    for (const p of shipping.results) {
      console.log(`  ${p.shipping_profile_id}  —  ${p.title}`);
    }
  }

  console.log(`\n=== Processing (readiness) profiles for shop ${ETSY_SHOP_ID} ===`);
  const readiness = await etsy(
    `/shops/${ETSY_SHOP_ID}/readiness-state-definitions`,
    token
  );
  if (!readiness.results || readiness.results.length === 0) {
    console.log("None yet.");
  } else {
    for (const p of readiness.results) {
      console.log(
        `  ${p.readiness_state_id}  —  ${p.readiness_state} (${p.processing_days_display_label})`
      );
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const searchTerm = await rl.question(
    "\nSearch Etsy's category tree for a taxonomy_id (e.g. 'scarf', 'candle'), or press enter to skip: "
  );

  if (searchTerm.trim()) {
    const taxonomy = await etsy("/seller-taxonomy/nodes", token);
    const flat = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        flat.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(taxonomy.results);

    const matches = flat.filter((n) =>
      n.name.toLowerCase().includes(searchTerm.trim().toLowerCase())
    );

    console.log(`\n=== Matching categories for "${searchTerm}" ===`);
    if (matches.length === 0) {
      console.log("No matches — try a broader term.");
    } else {
      for (const m of matches.slice(0, 25)) {
        console.log(`  ${m.id}  —  ${m.name}`);
      }
      if (matches.length > 25) {
        console.log(`  ...and ${matches.length - 25} more, refine your search term`);
      }
    }
  }

  rl.close();

  console.log(
    `\nCopy the IDs you want into ETSY_SHIPPING_PROFILE_ID, ETSY_READINESS_STATE_ID, and ETSY_DEFAULT_TAXONOMY_ID in shops/${SHOP}.env.\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
