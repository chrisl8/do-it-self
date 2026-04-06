// Infisical API client for reading/writing secrets.
// Uses the machine identity token from ~/credentials/infisical.env.

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

// Clear cached credentials (useful if token is refreshed)
export function clearCache() {
  cachedCreds = null;
}

export async function isAvailable() {
  const creds = await loadCredentials();
  return creds !== null;
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

// List all secrets at a given path
export async function listSecrets(folderPath = "/") {
  const creds = await loadCredentials();
  const params = new URLSearchParams({
    environment: "prod",
    projectId: creds.INFISICAL_PROJECT_ID,
    secretPath: folderPath,
  });
  const data = await apiRequest("GET", `/api/v4/secrets?${params}`);
  return (data.secrets || []).map((s) => ({
    key: s.secretKey,
    value: s.secretValue,
    id: s.id,
  }));
}

// Get a single secret
export async function getSecret(key, folderPath = "/") {
  const creds = await loadCredentials();
  const params = new URLSearchParams({
    environment: "prod",
    projectId: creds.INFISICAL_PROJECT_ID,
    secretPath: folderPath,
  });
  try {
    const data = await apiRequest("GET", `/api/v4/secrets/${encodeURIComponent(key)}?${params}`);
    return data.secret?.secretValue ?? null;
  } catch {
    return null;
  }
}

// Create or update a secret
export async function setSecret(key, value, folderPath = "/") {
  const creds = await loadCredentials();

  // Try to create first; if it already exists, update it
  try {
    await apiRequest("POST", `/api/v4/secrets/${encodeURIComponent(key)}`, {
      projectId: creds.INFISICAL_PROJECT_ID,
      environment: "prod",
      secretPath: folderPath,
      secretValue: value,
    });
  } catch (e) {
    // If creation fails (secret exists), try PATCH to update
    if (e.message.includes("400") || e.message.includes("409") || e.message.includes("already exist")) {
      await apiRequest("PATCH", `/api/v4/secrets/${encodeURIComponent(key)}`, {
        projectId: creds.INFISICAL_PROJECT_ID,
        environment: "prod",
        secretPath: folderPath,
        secretValue: value,
      });
    } else {
      throw e;
    }
  }
}

// Delete a secret
export async function deleteSecret(key, folderPath = "/") {
  const creds = await loadCredentials();
  await apiRequest("DELETE", `/api/v4/secrets/${encodeURIComponent(key)}`, {
    projectId: creds.INFISICAL_PROJECT_ID,
    environment: "prod",
    secretPath: folderPath,
  });
}

// Create a folder (idempotent -- ignores if it already exists)
export async function createFolder(name, parentPath = "/") {
  const creds = await loadCredentials();
  try {
    await apiRequest("POST", "/api/v2/folders", {
      projectId: creds.INFISICAL_PROJECT_ID,
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

// Get all secrets for a container (from /shared + /container-name)
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

// Set secrets for a container (writes to /container-name folder)
export async function setContainerSecrets(containerName, secrets) {
  // Ensure folder exists
  await createFolder(containerName, "/");

  // Set each secret
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined && value !== null && value !== "") {
      await setSecret(key, String(value), `/${containerName}`);
    }
  }
}

// Set shared secrets (writes to /shared folder)
export async function setSharedSecrets(secrets) {
  await createFolder("shared", "/");
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined && value !== null && value !== "") {
      await setSecret(key, String(value), "/shared");
    }
  }
}
