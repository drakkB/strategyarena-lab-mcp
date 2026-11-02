import { createInterface } from "node:readline";
import { realpathSync } from "node:fs"; // wave-246d (C13)
import { fileURLToPath } from "node:url"; // wave-246d (C13)
import {
  forwardMcpMessage,
  resolveAgentLabel,
  resolveMcpProfile,
  resolveMcpTextFormat
} from "./lib/strategyarena-agent-mcp-client.mjs";

// wave-246d (C13): status reads and cancellations never wait behind a long
// call (wait_for_local_proof can hold the queue up to 600 s). They are
// forwarded at once; every other message (mutations, initialize, lists)
// stays strictly in order in a bounded queue.
export const MAX_QUEUED_MESSAGES_246D = 64; // wave-246d (C13)
export const QUEUE_FULL_ERROR_CODE_246D = -32002; // wave-246d (C13)

// wave-246d (C13): true for the messages that bypass the serial queue.
export function isImmediateMessage246d(message) {
  const method = message?.method;
  if (method === "notifications/cancelled" || method === "ping") return true;
  // wave-249c: MCP tasks (get, list, cancel, result) are reads or cancellations: never queued
  // behind a long call (tasks/result waits for its task on the Lab side, on a thread of its own).
  if (typeof method === "string" && TASK_METHODS_249C.has(method)) return true; // wave-249c
  if (method !== "tools/call") return false;
  const name = message?.params?.name;
  // wave-249c: reading or cancelling a research project is not queued either.
  if (name === "research_project" && ["read", "cancel"].includes(message?.params?.arguments?.action)) return true; // wave-249c
  return typeof name === "string" && (name.startsWith("cancel_") || name.endsWith("_status"));
}

// wave-249c: the MCP tasks methods (protocol 2025-11-25).
export const TASK_METHODS_249C = new Set(["tasks/get", "tasks/list", "tasks/cancel", "tasks/result"]); // wave-249c

// wave-246d (C13): the routing of the stdio adapter, without process I/O.
// `forward(message)` returns the JSON-RPC response (or null for a notification),
// `write(response)` emits it, `isStopped()` stops the work after an output failure.
export function createMessageRouter({ forward, write, isStopped = () => false, maxQueued = MAX_QUEUED_MESSAGES_246D, onInvalidJson = () => {} }) {
  let chain = Promise.resolve();
  let queued = 0;
  const inFlight = new Set();

  async function handle(message) {
    if (isStopped()) return;
    let response;
    try {
      response = await forward(message);
    } catch (error) {
      const id = message?.id ?? null;
      response = {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: String(error?.message || error).slice(0, 500),
          ...(error?.data && typeof error.data === "object" ? { data: error.data } : {}) // wave-249d (B3): the named 413 (size, limit, file routes)
        }
      };
    }
    if (response && !isStopped()) await write(response);
  }

  function track(promise) {
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
    return promise;
  }

  function push(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Invalid JSON keeps its place in the order of the queue (as before).
      chain = chain.then(() => { if (!isStopped()) onInvalidJson(); });
      return;
    }
    if (isImmediateMessage246d(message)) {
      track(handle(message));
      return;
    }
    if (queued >= maxQueued) {
      if (message?.id !== undefined && message?.id !== null) {
        track(Promise.resolve(write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: QUEUE_FULL_ERROR_CODE_246D,
            message: `mcp_stdio_queue_full: ${maxQueued} calls are already waiting; retry after the running call (cancel_* and *_status are not queued).`,
            data: { reason: "mcp_stdio_queue_full", maxQueued }
          }
        })));
      } else {
        process.stderr.write("Strategy Arena Lab MCP dropped a notification: the call queue is full.\n");
      }
      return;
    }
    queued += 1;
    chain = chain.then(() => handle(message)).finally(() => { queued -= 1; });
  }

  // Resolves when the serial queue and every immediate message are done.
  async function drain() {
    for (;;) {
      const pending = [chain, ...inFlight];
      await Promise.allSettled(pending);
      if (inFlight.size === 0) {
        const tail = chain;
        await tail;
        if (tail === chain && inFlight.size === 0) return;
      }
    }
  }

  return { push, drain, queuedCount: () => queued };
}

function main() { // wave-246d (C13): the CLI runs only when this file is the entry point
// Lab 235: AI clients get the essential profile (16 tools, compact answers)
// unless started with `--profile full` or STRATEGY_ARENA_MCP_PROFILE=full.
// `--text json` (or STRATEGY_ARENA_MCP_TEXT=json) puts the compact data in the
// text block for clients that ignore structuredContent.
const presentation = {
  profile: resolveMcpProfile(),
  textFormat: resolveMcpTextFormat(),
  // Lab 236 wave B (Colisée): lane name in Jarvis (`--label Claude` or
  // STRATEGY_ARENA_AGENT_LABEL); otherwise the Lab uses the MCP clientInfo name.
  agentLabel: resolveAgentLabel(),
  clientName: ""
};

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false
});

let outputFailed = false;
const pendingOutputs = new Set(); // wave-246d (C13): several writes may be pending at once

function failOutput() {
  outputFailed = true;
  for (const finish of pendingOutputs) finish(false); // wave-246d (C13)
  pendingOutputs.clear();
  input.close();
}

process.stdout.on("error", failOutput);

function writeResponse(response) {
  if (outputFailed) return Promise.resolve(false);
  return new Promise((resolve) => {
    pendingOutputs.add(resolve); // wave-246d (C13)
    try {
      process.stdout.write(`${JSON.stringify(response)}\n`, (error) => {
        if (error) {
          failOutput();
          return;
        }
        pendingOutputs.delete(resolve); // wave-246d (C13)
        resolve(true);
      });
    } catch {
      failOutput();
    }
  });
}

// wave-246d (C13): routing by category instead of one chain for every message.
const router = createMessageRouter({
  forward: (message) => {
    const clientName = message?.method === "initialize" ? message?.params?.clientInfo?.name : null;
    if (typeof clientName === "string" && clientName.trim()) presentation.clientName = clientName.trim().slice(0, 64);
    return forwardMcpMessage(message, presentation);
  },
  write: writeResponse,
  isStopped: () => outputFailed,
  onInvalidJson: () => process.stderr.write("Strategy Arena Lab MCP ignored invalid JSON input.\n")
});

input.on("line", (line) => router.push(line));

input.on("close", () => {
  void router.drain().finally(() => process.exit(outputFailed ? 1 : 0));
});
}

// wave-246d (C13): the CLI starts only when this file is run, not when a test imports it.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) main(); // wave-246d (C13)
