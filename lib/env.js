// Loads config in two layers: shared secrets from the root .env (Google
// Drive+Sheets OAuth, Anthropic key — same for every shop), then overlays
// one shop's own Etsy app + Sheet config from shops/<name>.env.
//
// Pick the shop with `--shop=<name>` or `SHOP=<name>`. Adding shop #4, #5,
// etc. later is just `cp shops/example.env.example shops/<name>.env` and
// filling it in — no code or package.json changes needed.

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shopsDir = path.join(root, "shops");

dotenv.config({ path: path.join(root, ".env") });

const shopArg = process.argv.find((a) => a.startsWith("--shop="));
export const SHOP = shopArg ? shopArg.slice("--shop=".length) : process.env.SHOP;

function availableShops() {
  if (!fs.existsSync(shopsDir)) return [];
  return fs
    .readdirSync(shopsDir)
    .filter((f) => f.endsWith(".env"))
    .map((f) => f.replace(/\.env$/, ""));
}

if (!SHOP) {
  const available = availableShops();
  console.error(
    "No shop specified — pass --shop=<name> or set SHOP=<name>.\n" +
      (available.length
        ? `Available shops: ${available.join(", ")}`
        : "No shops set up yet — copy shops/example.env.example to shops/<name>.env to add one.")
  );
  process.exit(1);
}

const shopEnvPath = path.join(shopsDir, `${SHOP}.env`);
if (!fs.existsSync(shopEnvPath)) {
  console.error(
    `No config found for shop "${SHOP}" — expected ${shopEnvPath}.\n` +
      `Available shops: ${availableShops().join(", ") || "(none set up yet)"}`
  );
  process.exit(1);
}

dotenv.config({ path: shopEnvPath, override: true });

// Etsy rotates the refresh token on every refresh grant (each call to
// /oauth/token returns a new one) — the old one can stop working well
// before its nominal 90-day life if the new one never gets saved. Scripts
// that do a refresh grant should call this with the fresh value so the
// next run still has a working token.
export function updateShopEnvValue(key, value) {
  const content = fs.readFileSync(shopEnvPath, "utf8");
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const updated = pattern.test(content)
    ? content.replace(pattern, `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
  fs.writeFileSync(shopEnvPath, updated);
  process.env[key] = value;
}
