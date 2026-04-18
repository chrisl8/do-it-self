#!/usr/bin/env node

// Outputs the names of containers that should be enabled, one per line.
// Reads the registry and user-config.yaml. Used by all-containers.sh to
// filter the container list.
//
// A container is "enabled" if:
//   - user-config.yaml has containers.<name>.enabled = true, OR
//   - the registry doesn't mark it default_disabled AND user-config has no
//     explicit override

import { readFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { installedContainerSet } from "./lib/container-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");
const INSTALLED_MODULES_PATH = join(CONTAINERS_DIR, "installed-modules.yaml");

// Reuse the minimal YAML parser from generate-env.js
function parseYaml(text) {
  const result = {};
  const lines = text.split("\n");
  const stack = [{ indent: -1, obj: result }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const content = line.trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (content.startsWith("- ")) {
      const val = content.slice(2).trim();
      const unquoted = val.replace(/^["']|["']$/g, "");
      if (Array.isArray(parent)) {
        if (val.includes(": ")) {
          const obj = {};
          const pairs = val.match(/(\w+):\s*"?([^",]*)"?/g) || [];
          for (const pair of pairs) {
            const [k, ...v] = pair.split(": ");
            obj[k.trim()] = v.join(": ").trim().replace(/^["']|["']$/g, "");
          }
          parent.push(obj);
        } else {
          parent.push(unquoted);
        }
      } else {
        const keys = Object.keys(parent);
        const lastKey = keys[keys.length - 1];
        if (lastKey && parent[lastKey] === null) {
          parent[lastKey] = [unquoted];
          stack.push({ indent, obj: parent[lastKey] });
        }
      }
      continue;
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    let value = content.slice(colonIdx + 1).trim();

    let wasQuoted = false;
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      wasQuoted = true;
    }

    if (!wasQuoted && (value === "" || value === null)) {
      parent[key] = null;
      let nextContent = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && !lines[j].trim().startsWith("#")) {
          nextContent = lines[j].trim();
          break;
        }
      }
      if (nextContent.startsWith("- ")) {
        parent[key] = [];
        stack.push({ indent, obj: parent[key] });
      } else {
        parent[key] = {};
        stack.push({ indent, obj: parent[key] });
      }
    } else {
      if (value === "true") value = true;
      else if (value === "false") value = false;
      parent[key] = value;
    }
  }

  return result;
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function main() {
  if (!(await fileExists(REGISTRY_PATH))) return;
  const registry = parseYaml(await readFile(REGISTRY_PATH, "utf8"));

  let userConfig = { containers: {} };
  if (await fileExists(USER_CONFIG_PATH)) {
    userConfig = parseYaml(await readFile(USER_CONFIG_PATH, "utf8")) || { containers: {} };
  }

  let installed = { modules: {} };
  if (await fileExists(INSTALLED_MODULES_PATH)) {
    installed = parseYaml(await readFile(INSTALLED_MODULES_PATH, "utf8")) || { modules: {} };
  }
  const installedSet = installedContainerSet(installed);

  const containers = registry.containers || {};
  const userContainers = userConfig.containers || {};

  for (const name of Object.keys(containers).sort()) {
    // Registry is the full catalog; only emit containers actually installed on this host.
    if (!installedSet.has(name)) continue;
    const def = containers[name];
    const cc = userContainers[name];
    // Explicit user override wins
    let enabled;
    if (cc && cc.enabled !== undefined) {
      enabled = cc.enabled === true || cc.enabled === "true";
    } else {
      enabled = !def.default_disabled;
    }
    if (enabled) console.log(name);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
