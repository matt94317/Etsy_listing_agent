// Parses prompts/listing-templates/*.md into the system prompt Claude gets
// for one listing. Those files — not this one — are where the copy rules
// live, so tweaking what the agent writes is a Markdown edit, no code
// change: common.md holds what's shared across every shop, and each shop
// gets its own <slug>.md (matching shops/<slug>.env) with its shop-details
// and category templates.
//
// The parser only reads the <!-- ... --> markers and the fenced code block
// directly under each one; headings, emoji and prose in between are for
// humans. See prompts/listing-templates/README.md for the full editing
// rules. Internally, every file in the directory is just concatenated into
// one source string before parsing — the marker grammar below doesn't care
// how many files it came from.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = path.join(root, "prompts", "listing-templates");
const COMMON_PATH = path.join(TEMPLATES_DIR, "common.md");

// common.md first (universal/output/fallback), then every shop file in a
// stable order — order doesn't affect parsing (each shop's own <!-- shop -->
// marker scopes its content), but stable output makes debugging easier.
function readTemplateSource() {
  if (!fs.existsSync(COMMON_PATH)) {
    throw new Error(
      `Prompt templates not found at ${COMMON_PATH} — the listing copy is written ` +
        `from prompts/listing-templates/, so common.md has to exist there.`
    );
  }
  const shopFiles = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".md") && f !== "common.md" && f !== "README.md")
    .sort();
  const parts = [fs.readFileSync(COMMON_PATH, "utf8")];
  for (const file of shopFiles) {
    parts.push(fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf8"));
  }
  return parts.join("\n\n---\n\n");
}

const MARKER = /^<!--\s*(.+?)\s*-->\s*$/;
const FENCE = /^```/;

// "dress, dresses" and "Midi Dress!" should match each other — compare on
// lowercased alphanumerics only.
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Etsy's hard limits on the tags field.
const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;

// Tag blocks are written comma-separated and wrapped across lines for
// readability. Anything Etsy would reject is dropped here, loudly — better a
// warning while editing the Markdown than a rejected listing at 3am.
function parseTags(text, where) {
  const tags = [];
  for (const raw of text.split(/[,\n]/)) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      console.warn(
        `⚠️  Tag "${tag}" (${tag.length} chars) in ${where} exceeds Etsy's ` +
          `${MAX_TAG_LENGTH}-character limit — skipping it. Shorten it in ` +
          `prompts/listing-templates/<shop>.md.`
      );
      continue;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function parseMarker(raw) {
  const [head, ...rest] = raw.split("|");
  const [key, value] = head.split(":");
  const marker = { key: key.trim().toLowerCase(), value: (value || "").trim() };
  for (const part of rest) {
    const [name, val] = part.split(":");
    if (name && val) marker[name.trim().toLowerCase()] = val.trim();
  }
  return marker;
}

function parse(source) {
  const doc = { universal: "", outputs: {}, fallback: "", shops: [] };
  const lines = source.split("\n");
  let pending = null;
  let shop = null;

  for (let i = 0; i < lines.length; i++) {
    const markerMatch = lines[i].match(MARKER);
    if (markerMatch) {
      const marker = parseMarker(markerMatch[1]);
      if (marker.key === "shop") {
        shop = {
          slug: marker.value,
          aliases: (marker.match || marker.value).split(",").map((a) => a.trim()),
          details: "",
          closing: "",
          tagPool: [],
          categories: [],
        };
        doc.shops.push(shop);
        pending = null;
      } else if (
        [
          "universal",
          "output",
          "fallback",
          "shop-details",
          "shop-tags",
          "closing",
          "category",
          "tags",
        ].includes(marker.key)
      ) {
        pending = marker;
      }
      continue;
    }

    if (!pending || !FENCE.test(lines[i])) continue;

    // Consume the fenced block this marker owns.
    const body = [];
    i++;
    while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
    const text = body.join("\n").trim();

    switch (pending.key) {
      case "universal":
        doc.universal = text;
        break;
      case "output":
        doc.outputs[pending.value.toLowerCase()] = text;
        break;
      case "fallback":
        doc.fallback = text;
        break;
      case "shop-details":
        if (shop) shop.details = text;
        break;
      case "closing":
        if (shop) shop.closing = text;
        break;
      case "category":
        if (shop) {
          shop.categories.push({
            name: pending.value,
            aliases: (pending.match || pending.value).split(",").map((a) => a.trim()),
            body: text,
            tags: [],
          });
        }
        break;
      case "shop-tags":
        if (shop) shop.tagPool = parseTags(text, `shop "${shop.slug}"`);
        break;
      // A <!-- tags --> block belongs to the category block above it.
      case "tags": {
        const owner = shop && shop.categories[shop.categories.length - 1];
        if (owner) {
          owner.tags = parseTags(text, `${shop.slug} / ${owner.name}`).slice(0, MAX_TAGS);
        }
        break;
      }
    }
    pending = null;
  }

  return doc;
}

let cached = null;

export function loadTemplates() {
  if (cached) return cached;
  cached = parse(readTemplateSource());
  if (!cached.universal) {
    throw new Error(
      `No <!-- universal --> block found in prompts/listing-templates/common.md — ` +
        `check the markers still sit directly above their fenced blocks.`
    );
  }
  return cached;
}

function findShop(doc, slug) {
  const wanted = normalize(slug);
  if (!wanted) return null;
  return (
    doc.shops.find((s) => s.aliases.some((a) => normalize(a) === wanted)) || null
  );
}

// Matches on whole words so "top" doesn't win on "Laptop Sleeve", and prefers
// the longest matching alias so "matching set" beats a bare "set".
function findCategory(shop, category) {
  const text = ` ${normalize(category)} `;
  if (normalize(category)) {
    let best = null;
    let bestLength = 0;
    for (const cat of shop.categories) {
      for (const alias of cat.aliases) {
        const key = normalize(alias);
        if (!key || key === "*") continue;
        if (text.includes(` ${key} `) && key.length > bestLength) {
          best = cat;
          bestLength = key.length;
        }
      }
    }
    if (best) return { category: best, matched: true };
  }
  const catchAll = shop.categories.find((c) => c.aliases.some((a) => a.trim() === "*"));
  return catchAll ? { category: catchAll, matched: false } : null;
}

/**
 * The verified Etsy tags for one listing: `base` is the category's own list,
 * used verbatim and in order; `pool` is the shop's top-up list, used only for
 * slots the base leaves open. Both come from prompts/listing-templates/<shop>.md.
 */
export function resolveTags({ shop, category } = {}) {
  const doc = loadTemplates();
  const matchedShop = findShop(doc, shop);
  if (!matchedShop) return { base: [], pool: [] };
  const hit = findCategory(matchedShop, category);
  const base = hit ? hit.category.tags : [];
  return {
    base,
    pool: matchedShop.tagPool.filter((t) => !base.includes(t)),
  };
}

/**
 * The shop's fixed Customer Service / sign-off closing, if it has one — raw
 * text, appended to the description verbatim by lib/claude.js after Claude
 * responds. Not part of the prompt's output, so there's no risk of the
 * model paraphrasing a policy line or a store URL.
 */
export function resolveClosing({ shop } = {}) {
  const doc = loadTemplates();
  const matchedShop = findShop(doc, shop);
  return matchedShop?.closing || "";
}

function tagsSection({ base, pool }) {
  if (base.length === 0 && pool.length === 0) return null;
  const lines = ["Tags for this listing."];
  if (base.length > 0) {
    lines.push(
      `Verified tags for this shop and category — use these first, verbatim and in ` +
        `this order, all ${base.length} of them:\n${base.join(", ")}`
    );
  }
  if (pool.length > 0) {
    lines.push(
      `Verified tag pool for this shop — draw on these, in this order, for the slots ` +
        `the list above leaves open, keeping only ones that genuinely fit this item:\n` +
        pool.join(", ")
    );
  }
  const remaining = MAX_TAGS - base.length;
  lines.push(
    remaining > 0
      ? `That leaves up to ${remaining} slot(s) to fill — pool first, then your own ` +
        `specific long-tail phrases drawn from the photos and facts. Return exactly ` +
        `${MAX_TAGS} tags.`
      : `That is already ${MAX_TAGS} tags — return exactly those, and don't substitute ` +
        `your own.`
  );
  return lines.join("\n\n");
}

/**
 * Builds the system prompt for one listing.
 *
 * @param {{shop?: string, category?: string, mode?: "automated"|"manual"}} opts
 * @returns {{system: string, template: string}} `template` names the block that
 *   was used, e.g. "summercosta / Dress" — worth logging so it's obvious when a
 *   row's Category fell through to a catch-all.
 */
export function buildListingPrompt({ shop, category, mode = "automated" } = {}) {
  const doc = loadTemplates();
  const matchedShop = findShop(doc, shop);
  const hit = matchedShop ? findCategory(matchedShop, category) : null;

  const sections = [doc.universal];
  const output = doc.outputs[mode];
  if (output) sections.push(output);

  if (matchedShop && matchedShop.details) {
    sections.push(
      "Shop details — follow these for this listing. Any value still in [brackets] " +
        "hasn't been filled in yet: keep the bracket in your output rather than " +
        "inventing a number.\n\n" +
        matchedShop.details
    );
  }

  if (matchedShop && matchedShop.closing) {
    sections.push(
      "This shop has a fixed Customer Service / sign-off closing that gets appended " +
        "to your description automatically, word-for-word, after you respond. Do NOT " +
        "write your own Customer Service, sign-off, or store-link section — stop your " +
        "description at the end of the template's own sections below."
    );
  }

  const tags = tagsSection({
    base: hit ? hit.category.tags : [],
    pool: matchedShop
      ? matchedShop.tagPool.filter((t) => !(hit ? hit.category.tags : []).includes(t))
      : [],
  });
  if (tags) sections.push(tags);

  const body = hit ? hit.category.body : doc.fallback;
  if (body) {
    sections.push(`Template for this product — follow it exactly:\n\n${body}`);
  }

  const template = !matchedShop
    ? "(no shop section — generic fallback)"
    : hit
      ? `${matchedShop.slug} / ${hit.category.name}${hit.matched ? "" : " (catch-all)"}`
      : `${matchedShop.slug} / (generic fallback)`;

  return { system: sections.join("\n\n"), template };
}
