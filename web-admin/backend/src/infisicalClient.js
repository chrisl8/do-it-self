// Infisical API client for reading/writing secrets.
// Uses the machine identity token from ~/credentials/infisical.env.
//
// API versions for self-hosted Infisical:
//   Folders: POST /api/v1/folders
//   Secrets: GET/POST/PATCH/DELETE /api/v3/secrets/raw

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CRED_FILE = join(homedir(), "credentials", "infisical.env");

let cachedCreds = null;

async function loadCredentials() {
  if (cachedCreds) return cachedCreds;
  try {
    const content = await readFile(CRED_FILE, "utf8");
    const creds = {};
    for (const line of content.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      creds[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    if (!creds.INFISICAL_TOKEN || !creds.INFISICAL_PROJECT_ID) return null;
    cachedCreds = creds;
    return creds;
  } catch {
    return null;
  }
}

export function clearCache() {
  cachedCreds = null;
}

// Real connectivity check: credentials exist AND the Infisical API is
// reachable. Cached briefly to avoid hammering the API on every web admin
// request (30s on success, 5s on failure so recovery is quick).
let cachedAvailability = null;
let cachedAt = 0;
const CACHE_TTL_OK = 30000;
const CACHE_TTL_FAIL = 5000;

export async function isAvailable() {
  const now = Date.now();
  if (cachedAvailability !== null) {
    const ttl = cachedAvailability ? CACHE_TTL_OK : CACHE_TTL_FAIL;
    if (now - cachedAt < ttl) return cachedAvailability;
  }

  const creds = await loadCredentials();
  if (!creds) {
    cachedAvailability = false;
    cachedAt = now;
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = `${creds.INFISICAL_API_URL}/api/v3/secrets/raw?environment=prod&workspaceId=${creds.INFISICAL_PROJECT_ID}&secretPath=/`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.INFISICAL_TOKEN}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    cachedAvailability = res.ok;
  } catch {
    cachedAvailability = false;
  }
  cachedAt = now;
  return cachedAvailability;
}

async function apiRequest(method, path, body) {
  const creds = await loadCredentials();
  if (!creds) throw new Error("Infisical credentials not available");

  const url = `${creds.INFISICAL_API_URL}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${creds.INFISICAL_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Infisical API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

export async function listSecrets(folderPath = "/") {
  const creds = await loadCredentials();
  const params = new URLSearchParams({
    environment: "prod",
    workspaceId: creds.INFISICAL_PROJECT_ID,
    secretPath: folderPath,
  });
  const data = await apiRequest("GET", `/api/v3/secrets/raw?${params}`);
  return (data.secrets || []).map((s) => ({
    key: s.secretKey,
    value: s.secretValue,
    id: s.id,
  }));
}

export async function getSecret(key, folderPath = "/") {
  const creds = await loadCredentials();
  const params = new URLSearchParams({
    environment: "prod",
    workspaceId: creds.INFISICAL_PROJECT_ID,
    secretPath: folderPath,
  });
  try {
    const data = await apiRequest(
      "GET",
      `/api/v3/secrets/raw/${encodeURIComponent(key)}?${params}`,
    );
    return data.secret?.secretValue ?? null;
  } catch {
    return null;
  }
}

export async function setSecret(key, value, folderPath = "/") {
  const creds = await loadCredentials();

  // Try to create first; if it exists, update it
  try {
    await apiRequest("POST", `/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
      workspaceId: creds.INFISICAL_PROJECT_ID,
      environment: "prod",
      secretPath: folderPath,
      secretValue: value,
      type: "shared",
    });
  } catch (e) {
    if (
      e.message.includes("400") ||
      e.message.includes("409") ||
      e.message.includes("already exist")
    ) {
      await apiRequest(
        "PATCH",
        `/api/v3/secrets/raw/${encodeURIComponent(key)}`,
        {
          workspaceId: creds.INFISICAL_PROJECT_ID,
          environment: "prod",
          secretPath: folderPath,
          secretValue: value,
          type: "shared",
        },
      );
    } else {
      throw e;
    }
  }
}

export async function deleteSecret(key, folderPath = "/") {
  const creds = await loadCredentials();
  await apiRequest(
    "DELETE",
    `/api/v3/secrets/raw/${encodeURIComponent(key)}`,
    {
      workspaceId: creds.INFISICAL_PROJECT_ID,
      environment: "prod",
      secretPath: folderPath,
      type: "shared",
    },
  );
}

export async function createFolder(name, parentPath = "/") {
  const creds = await loadCredentials();
  try {
    await apiRequest("POST", "/api/v1/folders", {
      workspaceId: creds.INFISICAL_PROJECT_ID,
      environment: "prod",
      name,
      path: parentPath,
    });
  } catch (e) {
    // Ignore "already exists" errors
    if (!e.message.includes("400") && !e.message.includes("409")) {
      throw e;
    }
  }
}

export async function getContainerSecrets(containerName) {
  const [shared, container] = await Promise.all([
    listSecrets("/shared").catch(() => []),
    listSecrets(`/${containerName}`).catch(() => []),
  ]);

  const result = {};
  for (const s of shared) result[s.key] = s.value;
  for (const s of container) result[s.key] = s.value;
  return result;
}

export async function setContainerSecrets(containerName, secrets) {
  await createFolder(containerName, "/");
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined && value !== null && value !== "") {
      await setSecret(key, String(value), `/${containerName}`);
    }
  }
}

export async function setSharedSecrets(secrets) {
  await createFolder("shared", "/");
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined && value !== null && value !== "") {
      await setSecret(key, String(value), "/shared");
    }
  }
}
