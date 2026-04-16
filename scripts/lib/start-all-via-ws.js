#!/usr/bin/env node
// Test helper: drives the web admin's "Start All Enabled" button over its
// WebSocket, the same path the Dashboard tab uses. Exits 0 when the queue
// finishes with zero failures, non-zero otherwise.
//
// Usage: node start-all-via-ws.js <unix-socket-path> [timeoutSeconds]
//
// The ws package is not a scripts/ dependency — the web-admin backend
// already has it, so we resolve it from there via createRequire. Callers
// should set NODE_PATH=<repo>/web-admin/backend/node_modules before
// invoking so createRequire can find the package.

import http from "http";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

const socketPath = process.argv[2];
const timeoutSec = parseInt(process.argv[3] || "900", 10);
if (!socketPath) {
  console.error("usage: node start-all-via-ws.js <unix-socket-path> [timeoutSeconds]");
  process.exit(2);
}

const agent = new http.Agent({ socketPath });
const ws = new WebSocket("ws://localhost/", { agent });

const timer = setTimeout(() => {
  console.error(`start-all timed out after ${timeoutSec}s`);
  process.exit(3);
}, timeoutSec * 1000);

let kicked = false;
let lastProgress = "";

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  if (msg.type === "status") {
    if (!kicked) {
      kicked = true;
      ws.send(JSON.stringify({ type: "startAllEnabled" }));
      return;
    }
    const s = msg.startAllStatus;
    if (!s) return;

    const progress = `queue=${s.queue?.length ?? 0} current=${s.current || "-"} done=${s.completed?.length ?? 0}/${s.total ?? 0} failed=${s.failed?.length ?? 0}`;
    if (progress !== lastProgress) {
      console.log(`  ${progress}`);
      lastProgress = progress;
    }

    if (s.status === "completed" || s.status === "cancelled") {
      clearTimeout(timer);
      const failed = s.failed ?? [];
      if (failed.length > 0) {
        console.error(`start-all finished with ${failed.length} failure(s):`);
        for (const f of failed) {
          console.error(`  - ${f.stackName}: ${f.error}`);
          if (f.output) {
            console.error(`    tail: ${String(f.output).trim().slice(-500)}`);
          }
        }
        ws.close();
        process.exit(1);
      }
      console.log(`start-all ${s.status}: ${s.completed?.length ?? 0}/${s.total ?? 0} started`);
      ws.close();
      process.exit(0);
    }
  } else if (msg.type === "startAllError") {
    clearTimeout(timer);
    // "No enabled containers need to be started" means everything is
    // already running — that's a pass for this test.
    if (/no enabled containers need/i.test(msg.error || "")) {
      console.log(`start-all no-op: ${msg.error}`);
      ws.close();
      process.exit(0);
    }
    console.error(`startAllError: ${msg.error}`);
    ws.close();
    process.exit(1);
  }
});

ws.on("error", (err) => {
  clearTimeout(timer);
  console.error(`WebSocket error: ${err.message}`);
  process.exit(2);
});
