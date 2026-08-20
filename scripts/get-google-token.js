// One-time setup — run once with `npm run auth-google`. Walks through
// Google's OAuth 2.0 flow for your own Google account (not a service
// account — Google blocks service account key creation by default on new
// projects) and prints GOOGLE_REFRESH_TOKEN to paste into the root .env.
// One login covers Drive + Sheets for every shop, since they're all in
// your own Google account.

import "dotenv/config";
import crypto from "crypto";
import express from "express";
import open from "open";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error(
    "Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI in .env — fill those in first."
  );
  process.exit(1);
}

const SCOPES =
  "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";
const PORT = new URL(GOOGLE_REDIRECT_URI).port || 3004;
const state = crypto.randomBytes(16).toString("hex");

const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorizeUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
authorizeUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("scope", SCOPES);
// offline + consent so Google actually issues a refresh_token (it only
// does so on first consent, or when forced with prompt=consent).
authorizeUrl.searchParams.set("access_type", "offline");
authorizeUrl.searchParams.set("prompt", "consent");
authorizeUrl.searchParams.set("state", state);

const app = express();

app.get("/oauth/callback", async (req, res) => {
  const { code, state: returnedState, error } = req.query;

  if (error) {
    res.send(`Google returned an error: ${error}. Check the terminal.`);
    console.error("Authorization failed:", error);
    process.exit(1);
  }

  if (returnedState !== state) {
    res.send("State mismatch — possible CSRF, aborting. Check the terminal.");
    console.error("State mismatch, aborting.");
    process.exit(1);
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error("Token exchange failed:", tokenData);
      res.send("Token exchange failed — check the terminal.");
      process.exit(1);
    }

    if (!tokenData.refresh_token) {
      console.error(
        "No refresh_token in the response — Google only issues one on first " +
          "consent (or when forced). If you've authorized this app before, " +
          "remove its access at https://myaccount.google.com/permissions and try again."
      );
      res.send("No refresh token returned — check the terminal.");
      process.exit(1);
    }

    console.log("\n✅ Success! Paste this into the root .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokenData.refresh_token}\n`);

    res.send(
      "Success — check your terminal for the value to paste into .env. You can close this tab."
    );

    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    console.error(err);
    res.send("Something went wrong — check the terminal.");
    process.exit(1);
  }
});

app.listen(PORT, async () => {
  console.log(`Listening on ${GOOGLE_REDIRECT_URI} for Google's redirect...`);
  console.log(
    "If a browser tab doesn't open automatically, visit this URL:\n"
  );
  console.log(authorizeUrl.toString(), "\n");
  await open(authorizeUrl.toString());
});
