#!/usr/bin/env node

// Outputs git repo metadata for containers, one TSV line per repo.
// Used by all-containers.sh to clone or update external git repos.
//
// Usage:
//   node list-git-repos.js                  # enabled containers only
//   node list-git-repos.js --all            # all containers with git_repos
//   node list-git-repos.js --container foo  # single container
//
// Output format (tab-separated):
//   container	subdir	url	branch	shallow

import { readFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");

// Minimal YAML parser (same as list-enabled-containers.js / generate-env.js)
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isEnabled(def, userContainers, name) {
  const cc = userContainers[name];
  if (cc && cc.enabled !== undefined) {
    return cc.enabled === true || cc.enabled === "true";
  }
  return !def.default_disabled;
}

async function main() {
  const args = process.argv.slice(2);
  const allFlag = args.includes("--all");
  const containerIdx = args.indexOf("--container");
  const singleContainer =
    containerIdx !== -1 ? args[containerIdx + 1] : null;

  if (!(await fileExists(REGISTRY_PATH))) return;
  const registry = parseYaml(await readFile(REGISTRY_PATH, "utf8"));

  let userConfig = { containers: {} };
  if (await fileExists(USER_CONFIG_PATH)) {
    userConfig =
      parseYaml(await readFile(USER_CONFIG_PATH, "utf8")) || {
        containers: {},
      };
  }

  const containers = registry.containers || {};
  const userContainers = userConfig.containers || {};

  for (const name of Object.keys(containers).sort()) {
    if (singleContainer && name !== singleContainer) continue;
    if (!allFlag && !singleContainer && !isEnabled(containers[name], userContainers, name)) continue;

    const def = containers[name];
    const repos = def.git_repos;
    if (!repos || typeof repos !== "object") continue;

    for (const [subdir, meta] of Object.entries(repos)) {
      if (!meta || !meta.url) continue;
      const branch = meta.branch || "";
      const shallow = meta.shallow === true ? "true" : "";
      console.log(`${name}\t${subdir}\t${meta.url}\t${branch}\t${shallow}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
