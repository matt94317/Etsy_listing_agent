// Shared by get-etsy-token.js and publish-listing.js. Etsy links shops by
// the IP address requests come from, so every call to Etsy (including the
// one-time OAuth authorization, not just daily publishing) for a proxied
// shop has to go out through that shop's proxy. Shops with no PROXY_URL set
// use the machine's normal connection.

import { ProxyAgent, fetch as undiciFetch } from "undici";

let dispatcher;

function getDispatcher() {
  const { PROXY_URL } = process.env;
  if (!PROXY_URL) return null;
  if (!dispatcher) dispatcher = new ProxyAgent(PROXY_URL);
  return dispatcher;
}

// Node's global fetch doesn't reliably accept a dispatcher from the
// standalone `undici` package — its version can drift from whatever undici
// Node bundles internally, and mixing the two throws "invalid onError
// method" deep in undici's dispatcher internals. Using undici's own fetch
// alongside its own ProxyAgent keeps both from the same version.
export function etsyFetch(url, options = {}) {
  const dispatcher = getDispatcher();
  if (!dispatcher) return fetch(url, options);
  return undiciFetch(url, { ...options, dispatcher });
}
