// Used by publish-listing.js to write the Etsy title/tags/description from
// the Sheet row's raw facts plus the item's photos.
//
// The copy rules themselves live in prompts/listing-templates/ (common.md plus
// one file per shop) — the shop's section, the row's Category block, and the
// shared house style are assembled into the system prompt by
// lib/prompt-templates.js. Change what the agent writes by editing those
// Markdown files, not this one.

import Anthropic from "@anthropic-ai/sdk";
import { buildListingPrompt, resolveTags, resolveClosing } from "./prompt-templates.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;

// The prompt asks for the verified tags, but asking isn't guaranteeing: this
// rebuilds the list so the category's verified tags are always present and in
// order, the model's own item-specific tags fill what's left, and the shop
// pool tops up any remainder. Also enforces Etsy's limits — a 21-character tag
// gets the whole listing rejected by the API.
function finalizeTags(modelTags, { base, pool }) {
  const tags = [];
  const add = (raw) => {
    const tag = String(raw || "").trim().toLowerCase();
    if (!tag || tag.length > MAX_TAG_LENGTH) return;
    if (tags.includes(tag) || tags.length >= MAX_TAGS) return;
    tags.push(tag);
  };

  base.forEach(add);
  (Array.isArray(modelTags) ? modelTags : []).forEach(add);
  pool.forEach(add);
  return tags;
}

// Etsy's title field only allows letters, numbers, punctuation, math
// symbols, and ™©® — an emoji anywhere in the title gets the whole
// createDraftListing call rejected. The templates say "No emoji in the
// title", but that's a prompt instruction, not a guarantee (same reasoning
// as finalizeTags above), so this strips any that slip through anyway.
function sanitizeTitle(title) {
  return String(title || "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "");
}

export async function draftListingCopy(brief, images, shop) {
  const { system, template } = buildListingPrompt({
    shop,
    category: brief.category,
  });
  const verified = resolveTags({ shop, category: brief.category });
  const closing = resolveClosing({ shop });

  const factsText = `Product facts:\n${JSON.stringify(brief, null, 2)}\n\nWrite the listing copy as JSON.`;

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    system,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType,
              data: img.buffer.toString("base64"),
            },
          })),
          { type: "text", text: factsText },
        ],
      },
    ],
  });

  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude didn't return JSON:\n${text}`);
  const copy = JSON.parse(jsonMatch[0]);

  // Appended in code, not asked of the model — exact policy wording and a
  // store URL shouldn't depend on an LLM retyping them faithfully every run.
  const description = closing ? `${copy.description.trim()}\n\n${closing}` : copy.description;

  return {
    ...copy,
    title: sanitizeTitle(copy.title),
    description,
    tags: finalizeTags(copy.tags, verified),
    template,
  };
}
