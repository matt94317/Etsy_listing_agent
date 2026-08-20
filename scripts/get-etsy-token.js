// One-time setup script — run this once per Etsy shop with
// `npm run auth -- --shop=<name>`. It walks through Etsy's OAuth 2.0 + PKCE
// flow and prints the values you need to paste into shops/<name>.env
// (ETSY_SHOP_ID and ETSY_REFRESH_TOKEN).
//
// You only need to do this again if a refresh token stops working
// (they last 90 days if actively used, so the daily script keeps it alive).

import { SHOP } from "../lib/env.js";
import crypto from "crypto";
import express from "express";
import open from "open";
import { etsyFetch } from "../lib/proxy.js";

const { ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_REDIRECT_URI, PROXY_URL } = process.env;

console.log(`Setting up OAuth for shop "${SHOP}"...`);

if (PROXY_URL) {
  console.log(`Authorizing through proxy (${new URL(PROXY_URL).hostname}) — make sure this matches the IP this shop normally logs in from.`);
} else {
  console.log("No PROXY_URL set — authorizing from this machine's regular IP.");
}

if (!ETSY_API_KEY || !ETSY_SHARED_SECRET || !ETSY_REDIRECT_URI) {
  console.error(
    `Missing ETSY_API_KEY, ETSY_SHARED_SECRET, or ETSY_REDIRECT_URI in shops/${SHOP}.env — fill those in first.`
  );
  process.exit(1);
}

// Scopes needed for everything this project does:
// - listings_r / listings_w: create and publish listings
// - shops_r / shops_w: read/create shipping profiles & processing profiles
const SCOPES = "listings_r listings_w shops_r shops_w";

const PORT = new URL(ETSY_REDIRECT_URI).port || 3003;

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = base64url(
  crypto.createHash("sha256").update(codeVerifier).digest()
);
const state = base64url(crypto.randomBytes(16));

const authorizeUrl = new URL("https://www.etsy.com/oauth/connect");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", ETSY_API_KEY);
authorizeUrl.searchParams.set("redirect_uri", ETSY_REDIRECT_URI);
authorizeUrl.searchParams.set("scope", SCOPES);
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("code_challenge", codeChallenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");

const app = express();

app.get("/oauth/redirect", async (req, res) => {
  const { code, state: returnedState, error } = req.query;

  if (error) {
    res.send(`Etsy returned an error: ${error}. Check the terminal.`);
    console.error("Authorization failed:", error);
    process.exit(1);
  }

  if (returnedState !== state) {
    res.send("State mismatch — possible CSRF, aborting. Check the terminal.");
    console.error("State mismatch, aborting.");
    process.exit(1);
  }

  try {
    const tokenResponse = await etsyFetch(
      "https://api.etsy.com/v3/public/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: ETSY_API_KEY,
          redirect_uri: ETSY_REDIRECT_URI,
          code,
          code_verifier: codeVerifier,
        }),
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error("Token exchange failed:", tokenData);
      res.send("Token exchange failed — check the terminal.");
      process.exit(1);
    }

    // The access_token is formatted "{user_id}.{opaque_string}" — that's the
    // Etsy member's user ID, NOT the shop ID (despite what the number might
    // look like), so the real shop_id has to be looked up separately.
    const userId = tokenData.access_token.split(".")[0];

    const shopsResponse = await etsyFetch(
      `https://api.etsy.com/v3/application/users/${userId}/shops`,
      {
        headers: {
          "x-api-key": `${ETSY_API_KEY}:${ETSY_SHARED_SECRET}`,
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      }
    );
    const shopData = await shopsResponse.json();
    if (!shopsResponse.ok) {
      console.error("Shop lookup failed:", shopData);
      res.send("Shop lookup failed — check the terminal.");
      process.exit(1);
    }
    const shopId = shopData.shop_id;

    console.log(`\n✅ Success! Paste these into shops/${SHOP}.env:\n`);
    console.log(`ETSY_SHOP_ID=${shopId}`);
    console.log(`ETSY_REFRESH_TOKEN=${tokenData.refresh_token}\n`);

    res.send(
      `Success — check your terminal for the values to paste into shops/${SHOP}.env. You can close this tab.`
    );

    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    console.error(err);
    res.send("Something went wrong — check the terminal.");
    process.exit(1);
  }
});

app.listen(PORT, async () => {
  console.log(`Listening on ${ETSY_REDIRECT_URI} for Etsy's redirect...`);
  console.log(
    "If a browser tab doesn't open automatically, visit this URL:\n"
  );
  console.log(authorizeUrl.toString(), "\n");
  await open(authorizeUrl.toString());
});
