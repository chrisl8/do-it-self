#!/usr/bin/env node

// Tailscale preflight checks. Verifies the most common Tailscale-side
// configuration mistakes that otherwise only surface as crashlooping
// container sidecars or "the URL doesn't work, why?" debugging sessions.
//
// Checks performed:
//   1. ACL: tag:container is declared in tagOwners
//   2. Auth key: reusable, has tag:container, not expired
//      (looked up by ID parsed from TS_AUTHKEY; if that fails, falls back
//       to "list all keys, accept if any one matches")
//   3. HTTPS round-trip to https://admin.${TS_DOMAIN} as a best-effort
//      check for the HTTPS Certificates toggle (which has no API)
//
// Usage:
//   node scripts/lib/tailscale-preflight.js          # human output, exit 0 / 1
//   node scripts/lib/tailscale-preflight.js --json   # machine-readable, for the web admin
//   node scripts/lib/tailscale-preflight.js --quiet  # only print failures
//
// Reads from environment:
//   TS_API_TOKEN  (required)  Bearer token from https://login.tailscale.com/admin/settings/keys
//   TS_AUTHKEY    (optional)  Used to extract the key ID for direct lookup
//   TS_DOMAIN     (optional)  Used for the HTTPS round-trip; check is skipped if unset
//
// What is NOT checked (and why):
//   - HTTPS Certificates toggle: no Tailscale API exists for this. The
//     round-trip probe is a best-effort proxy.
//   - Device quota: no billing API; Personal plan is now "unlimited user
//     devices" so the gate is no longer meaningful.

import https from "node:https";

const KEYS_ADMIN_URL = "https://login.tailscale.com/admin/settings/keys";
const ACL_ADMIN_URL = "https://login.tailscale.com/admin/acls/file";
const DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

// ─── Tailscale API client ────────────────────────────────────────────

function tailscaleApi(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.tailscale.com",
        path: "/api/v2" + path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Invalid JSON from ${path}: ${err.message}`));
            }
          } else {
            const err = new Error(`API ${path} returned HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = data;
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`Timeout calling api.tailscale.com${path}`));
    });
    req.end();
  });
}

// ─── Auth key parsing ────────────────────────────────────────────────

// Tailscale credentials accepted by the sidecar's TS_AUTHKEY env var
// come in two formats:
//   "tskey-auth-<keyID>-<secret>"        legacy auth key
//   "tskey-client-<clientID>-<secret>"   OAuth client credential
// Both can carry trailing query parameters like "?ephemeral=false".
// Extracts the ID portion so we can look the key up via the API.
// Returns { id, kind: "auth" | "client" } or null on failure.
function parseKeyId(authKey) {
  if (!authKey || typeof authKey !== "string") return null;
  // Strip any trailing query parameters first.
  const stripped = authKey.split("?")[0];
  let kind, prefix;
  if (stripped.startsWith("tskey-auth-")) {
    kind = "auth";
    prefix = "tskey-auth-";
  } else if (stripped.startsWith("tskey-client-")) {
    kind = "client";
    prefix = "tskey-client-";
  } else {
    return null;
  }
  const rest = stripped.slice(prefix.length);
  const dashIdx = rest.indexOf("-");
  if (dashIdx <= 0) return null;
  return { id: rest.slice(0, dashIdx), kind };
}

function isKeyValid(keyData) {
  const cap = keyData?.capabilities?.devices?.create;
  if (!cap) return { ok: false, reason: "key has no devices.create capability" };
  if (!cap.reusable) {
    return { ok: false, reason: "key is not marked Reusable" };
  }
  if (!Array.isArray(cap.tags) || !cap.tags.includes("tag:container")) {
    return { ok: false, reason: "key does not have tag:container in its tags" };
  }
  if (keyData.expires) {
    const exp = new Date(keyData.expires);
    if (!isNaN(exp.getTime()) && exp < new Date()) {
      return { ok: false, reason: `key expired on ${keyData.expires}` };
    }
  }
  return { ok: true };
}

// ─── Checks ──────────────────────────────────────────────────────────

async function checkAclTag(token) {
  try {
    const acl = await tailscaleApi("/tailnet/-/acl", token);
    // The JSON response uses lowercase `tagowners` (despite the HuJSON
    // source files using camelCase `tagOwners`). Be defensive and accept
    // either form in case Tailscale ever changes this.
    const tagOwners = acl.tagowners || acl.tagOwners || {};
    const owners = tagOwners["tag:container"];
    if (Array.isArray(owners) && owners.length > 0) {
      return { name: "ACL tag:container", ok: true, message: "OK" };
    }
    return {
      name: "ACL tag:container",
      ok: false,
      message:
        'tag:container is not declared in your tailnet ACL. Container sidecars will fail with "requested tags [tag:container] are invalid or not permitted".',
      fix: 'Add this to the tagOwners section of your tailnet ACL:\n  "tagOwners": {\n    "tag:container": ["autogroup:admin"]\n  }',
      fixUrl: ACL_ADMIN_URL,
    };
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return {
        name: "ACL tag:container",
        ok: false,
        message:
          "TS_API_TOKEN was rejected by Tailscale (HTTP " +
          err.statusCode +
          "). Verify the token is valid and has admin access.",
        fixUrl: KEYS_ADMIN_URL,
      };
    }
    return {
      name: "ACL tag:container",
      ok: false,
      message: `Failed to fetch ACL: ${err.message}`,
    };
  }
}

async function checkAuthKey(token, authKey) {
  const parsed = parseKeyId(authKey);

  // Direct lookup by ID first.
  if (parsed) {
    try {
      const key = await tailscaleApi(`/tailnet/-/keys/${parsed.id}`, token);
      const v = isKeyValid(key);
      if (v.ok) {
        return {
          name: "Auth key",
          ok: true,
          message: `OK (validated by ID ${parsed.id}, kind=${parsed.kind})`,
        };
      }
      return {
        name: "Auth key",
        ok: false,
        message: `Your TS_AUTHKEY (id=${parsed.id}, kind=${parsed.kind}) is invalid: ${v.reason}.`,
        fix: "Mint a new auth key with Reusable=ON and Tags=tag:container.",
        fixUrl: KEYS_ADMIN_URL,
      };
    } catch (err) {
      if (err.statusCode !== 404) {
        return {
          name: "Auth key",
          ok: false,
          message: `Failed to fetch key ${parsed.id}: ${err.message}`,
        };
      }
      // 404: OAuth client credentials in particular don't appear under
      // /keys/{id} — fall through to the list-based fallback.
    }
  }

  // Fallback: list all keys, accept if at least one passes isKeyValid.
  // Used when the keyID isn't parseable or the direct lookup 404s
  // (e.g. the key was created by a different user, or the format
  // changed). This is weaker — won't catch "the user's specific key
  // is bad but they have a different good one" — but covers the
  // "all my keys are bad" case which is the common breakage.
  try {
    const list = await tailscaleApi("/tailnet/-/keys", token);
    const keys = Array.isArray(list.keys) ? list.keys : [];
    for (const keyRef of keys) {
      if (!keyRef?.id) continue;
      try {
        const full = await tailscaleApi(`/tailnet/-/keys/${keyRef.id}`, token);
        const v = isKeyValid(full);
        if (v.ok) {
          return {
            name: "Auth key",
            ok: true,
            message: `OK (fallback: found valid key id=${keyRef.id} in tailnet)`,
          };
        }
      } catch {
        // Ignore individual lookup failures and keep scanning.
      }
    }
    return {
      name: "Auth key",
      ok: false,
      message:
        "No reusable, tag:container-tagged, non-expired auth key found in your tailnet.",
      fix: "Mint a new auth key with Reusable=ON and Tags=tag:container.",
      fixUrl: KEYS_ADMIN_URL,
    };
  } catch (err) {
    return {
      name: "Auth key",
      ok: false,
      message: `Failed to list keys: ${err.message}`,
    };
  }
}

// Best-effort HTTPS round-trip. There's no API for the "Enable HTTPS"
// toggle, so we do a real GET against the admin URL and infer from the
// failure mode. Any HTTP response (including 4xx) is treated as success
// because it means the Tailscale Serve TLS chain is working — the
// failure modes we care about are connection refused, timeout, or TLS
// handshake failure, all of which surface as request errors.
async function checkHttpsRoundTrip(domain) {
  return new Promise((resolve) => {
    const url = `https://admin.${domain}/api/config/infisical-status`;
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      resolve({
        name: "HTTPS round-trip",
        ok: false,
        message: `Invalid TS_DOMAIN value: ${domain}`,
      });
      return;
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "GET",
        timeout: 5000,
      },
      (res) => {
        if (res.statusCode < 500) {
          resolve({
            name: "HTTPS round-trip",
            ok: true,
            message: `OK (${url} → ${res.statusCode})`,
          });
        } else {
          resolve({
            name: "HTTPS round-trip",
            ok: false,
            message: `${url} returned HTTP ${res.statusCode}`,
            fixUrl: DNS_ADMIN_URL,
          });
        }
      },
    );
    req.on("error", (err) => {
      resolve({
        name: "HTTPS round-trip",
        ok: false,
        message: `${url} unreachable: ${err.message}. Most likely cause: HTTPS Certificates not enabled in your tailnet.`,
        fix: "In the Tailscale admin console, go to DNS → HTTPS Certificates and click Enable HTTPS.",
        fixUrl: DNS_ADMIN_URL,
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({
        name: "HTTPS round-trip",
        ok: false,
        message: `${url} timed out after 5s. Most likely cause: HTTPS Certificates not enabled in your tailnet, or first-run cert provisioning still in progress.`,
        fix: "In the Tailscale admin console, go to DNS → HTTPS Certificates and click Enable HTTPS.",
        fixUrl: DNS_ADMIN_URL,
      });
    });
    req.end();
  });
}

// ─── Output formatting ───────────────────────────────────────────────

function printHuman(checks, quiet) {
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";
  for (const c of checks) {
    if (c.ok) {
      if (!quiet) console.log(`  ${GREEN}✓${RESET} ${c.name}: ${c.message}`);
    } else {
      console.error(`  ${RED}✗${RESET} ${c.name}: ${c.message}`);
      if (c.fix) {
        for (const line of c.fix.split("\n")) {
          console.error(`      ${line}`);
        }
      }
      if (c.fixUrl) console.error(`      Open: ${c.fixUrl}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const quiet = args.includes("--quiet");

  const token = process.env.TS_API_TOKEN;
  if (!token) {
    const errMsg =
      "TS_API_TOKEN environment variable is required. Generate one at " +
      KEYS_ADMIN_URL;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: errMsg, checks: [] }));
    } else {
      console.error(`Error: ${errMsg}`);
    }
    process.exit(1);
  }

  const authKey = process.env.TS_AUTHKEY;
  const domain = process.env.TS_DOMAIN;

  const checks = [];
  checks.push(await checkAclTag(token));
  checks.push(await checkAuthKey(token, authKey));
  if (domain) {
    checks.push(await checkHttpsRoundTrip(domain));
  }

  const allOk = checks.every((c) => c.ok);

  if (json) {
    console.log(JSON.stringify({ ok: allOk, checks }, null, 2));
  } else {
    printHuman(checks, quiet);
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(2);
});
