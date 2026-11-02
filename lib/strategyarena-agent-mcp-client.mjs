import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 630_000;
const MCP_ERROR_MESSAGE_LIMIT = 500;
const REDACTED_MCP_ERROR_MESSAGE = "Strategy Arena Lab MCP request failed (sensitive details redacted).";
const DEFAULT_MCP_ERROR_MESSAGE = "Strategy Arena Lab MCP tool call failed.";
let requestSequence = 0;
// One opaque id per wrapper process, so the Lab counts capability demand by
// distinct agent sessions instead of calls. The Lab hashes it before storage.
export const AGENT_SESSION_HEADER = "x-strategyarena-agent-session";
// wave-244c: a client that starts one wrapper process per call (scripts, cron,
// agents) keeps ONE session across its calls with `--session-id <id>` or
// STRATEGY_ARENA_AGENT_SESSION_ID (letters, digits, . _ -; 1..96 chars):
// work episodes, declare_lab_goal and the end-of-session prompt then follow it.
export function resolveAgentSessionId(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const raw = String(argumentValue("--session-id", argv) || env.STRATEGY_ARENA_AGENT_SESSION_ID || "").trim();
  return /^[A-Za-z0-9._-]{1,96}$/.test(raw) ? `sa-agent-client-${raw}` : `sa-agent-${randomUUID()}`;
}
export const AGENT_SESSION_ID = resolveAgentSessionId(); // wave-244c
// Lab 235: MCP profile (essential | full) and text format (summary | json)
// requested by the AI-facing wrapper. Library callers that pass neither keep
// the legacy full profile (the Lab defaults to full for this client).
export const MCP_PROFILE_HEADER = "x-strategyarena-mcp-profile";
export const MCP_TEXT_HEADER = "x-strategyarena-mcp-text";
const MCP_PROFILES = new Set(["essential", "full"]);
// Lab 236 wave B (Colisée): display name of the lane of this agent in Jarvis, and
// the MCP clientInfo.name seen at initialize. Percent-encoded (headers are ASCII).
export const AGENT_LABEL_HEADER = "x-strategyarena-agent-label";
export const CLIENT_NAME_HEADER = "x-strategyarena-client-name";

export function resolveAgentLabel(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const raw = String(argumentValue("--label", argv) || env.STRATEGY_ARENA_AGENT_LABEL || "").trim();
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")).slice(0, 32).join("");
}
const MCP_TEXT_FORMATS = new Set(["summary", "json"]);

export function resolveMcpProfile(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const raw = String(
    argumentValue("--profile", argv)
    || env.STRATEGY_ARENA_MCP_PROFILE
    || "essential"
  ).trim().toLowerCase();
  return MCP_PROFILES.has(raw) ? raw : "essential";
}

export function resolveMcpTextFormat(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const raw = String(
    argumentValue("--text", argv)
    || env.STRATEGY_ARENA_MCP_TEXT
    || "summary"
  ).trim().toLowerCase();
  return MCP_TEXT_FORMATS.has(raw) ? raw : "summary";
}

function presentationHeaders(options = {}) {
  const headers = {};
  if (MCP_PROFILES.has(options.profile)) headers[MCP_PROFILE_HEADER] = options.profile;
  if (options.textFormat === "json") headers[MCP_TEXT_HEADER] = "json";
  if (options.agentLabel) headers[AGENT_LABEL_HEADER] = encodeURIComponent(String(options.agentLabel).slice(0, 32));
  if (options.clientName) headers[CLIENT_NAME_HEADER] = encodeURIComponent(String(options.clientName).slice(0, 64));
  return headers;
}

const powershellHttpClient = `
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Net.Http
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$handler = New-Object System.Net.Http.HttpClientHandler
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromMilliseconds(630000)
try {
  $request = New-Object System.Net.Http.HttpRequestMessage(
    [System.Net.Http.HttpMethod]::Post,
    [string]$payload.endpoint
  )
  $request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + [string]$payload.token) | Out-Null
  $request.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream") | Out-Null
  if ($payload.agentSession) {
    $request.Headers.TryAddWithoutValidation("X-StrategyArena-Agent-Session", [string]$payload.agentSession) | Out-Null
  }
  if ($payload.profile) {
    $request.Headers.TryAddWithoutValidation("X-StrategyArena-MCP-Profile", [string]$payload.profile) | Out-Null
  }
  if ($payload.textFormat) {
    $request.Headers.TryAddWithoutValidation("X-StrategyArena-MCP-Text", [string]$payload.textFormat) | Out-Null
  }
  if ($payload.agentLabel) {
    $request.Headers.TryAddWithoutValidation("X-StrategyArena-Agent-Label", [string]$payload.agentLabel) | Out-Null
  }
  if ($payload.clientName) {
    $request.Headers.TryAddWithoutValidation("X-StrategyArena-Client-Name", [string]$payload.clientName) | Out-Null
  }
  $body = $payload.message | ConvertTo-Json -Depth 40 -Compress
  $request.Content = New-Object System.Net.Http.StringContent(
    $body,
    [System.Text.Encoding]::UTF8,
    "application/json"
  )
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $contentBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  $contentBase64 = [Convert]::ToBase64String($contentBytes)
  [Console]::Out.Write(([int]$response.StatusCode).ToString() + [Environment]::NewLine + $contentBase64)
} finally {
  $client.Dispose()
  $handler.Dispose()
}
`;

export function argumentValue(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || "").trim() : "";
}

export function sessionCandidates(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || homedir();
  const argv = options.argv || process.argv;
  const explicit = options.sessionFile
    || argumentValue("--session-file", argv)
    || String(env.STRATEGY_ARENA_AGENT_SESSION_FILE || "").trim();
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  if (platform === "win32" && env.LOCALAPPDATA) {
    candidates.push(join(
      env.LOCALAPPDATA,
      "io.strategyarena.gpuclient",
      "agent-control-session.json"
    ));
  }
  const username = String(env.USER || env.USERNAME || "").trim();
  if (username) {
    candidates.push(join(
      "/mnt/c/Users",
      username,
      "AppData/Local/io.strategyarena.gpuclient/agent-control-session.json"
    ));
  }
  candidates.push(join(
    home,
    ".local/share/io.strategyarena.gpuclient/agent-control-session.json"
  ));
  return [...new Set(candidates)];
}

// Lab 235: the plain-text descriptor that builds before 230 wrote to the
// shared temp directory is no longer read at all (any local user could plant
// one there). Only the private per-user descriptors above are trusted.

export function validateSessionDescriptor(session) {
  const endpoint = new URL(String(session?.endpoint || ""));
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname);
  if (
    session?.schema !== "strategyarena.agent_control_bridge.v1"
    || endpoint.protocol !== "http:"
    || !loopback
    || !/^[a-f0-9]{64}$/i.test(String(session?.token || ""))
  ) {
    throw new Error("Invalid Strategy Arena Lab Agent Control session descriptor.");
  }
  return { ...session, endpoint: endpoint.toString() };
}

export function readSession(options = {}) {
  for (const path of sessionCandidates(options)) {
    try {
      const session = validateSessionDescriptor(JSON.parse(readFileSync(path, "utf8")));
      return { path, session };
    } catch {
      // Session paths and descriptor failures are deliberately not surfaced.
    }
  }
  throw typedMcpError(
    "mcp_session_unavailable",
    null,
    "Strategy Arena Lab Agent Control session was not found or is invalid."
  );
}

export function parseHttpResponse(status, body) {
  if (status === 202 || status === 204) return null;
  if (status < 200 || status >= 300) {
    let remoteMessage = null;
    let tooLarge = null; // wave-249d (B3): the named 413 of the bridge (size, limit, file routes)
    try {
      const parsed = body ? JSON.parse(body) : null;
      remoteMessage = parsed?.error?.message
        || parsed?.message
        || parsed?.structuredContent?.error?.message
        || null;
      if (status === 413 && parsed?.code === "mcp.request_too_large") {
        tooLarge = {
          code: "mcp.request_too_large",
          limitBytes: Number.isFinite(parsed.limitBytes) ? parsed.limitBytes : null,
          requestBytes: Number.isFinite(parsed.requestBytes) ? parsed.requestBytes : null,
          fileRoutes: parsed.fileRoutes && typeof parsed.fileRoutes === "object" ? parsed.fileRoutes : null,
          allowedFolders: Array.isArray(parsed.allowedFolders) ? parsed.allowedFolders.filter((f) => typeof f === "string").slice(0, 8) : [],
          messageFr: typeof parsed.messageFr === "string" ? parsed.messageFr.slice(0, 600) : null
        };
      }
    } catch {
      // An unstructured response body is never copied into an error.
    }
    const error = typedMcpError(
      `mcp_http_${status}`,
      remoteMessage,
      `Strategy Arena Lab MCP returned HTTP ${status}.`
    );
    if (tooLarge) error.data = tooLarge; // wave-249d (B3)
    throw error;
  }
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw typedMcpError(
      "mcp_invalid_json",
      null,
      "Strategy Arena Lab MCP returned invalid JSON."
    );
  }
}

export function isWindowsInteropRuntime(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  if (platform !== "linux") return false;
  if (
    String(environment.WSL_DISTRO_NAME || "").trim()
    || String(environment.WSL_INTEROP || "").trim()
  ) {
    return true;
  }
  const readText = options.readText
    || ((path) => readFileSync(path, "utf8"));
  for (const path of [
    "/proc/sys/kernel/osrelease",
    "/proc/version"
  ]) {
    try {
      if (/\bmicrosoft\b|\bwsl\d*\b/i.test(String(readText(path)))) {
        return true;
      }
    } catch {
      // A missing procfs marker simply means this is not a detectable WSL host.
    }
  }
  return false;
}

export function forwardThroughWindows(session, message, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const windowsBridgeCwd = options.windowsBridgeCwd
      || (existsSync("/mnt/c/Windows/Temp") ? "/mnt/c/Windows/Temp" : homedir());
    const child = (options.spawnImpl || spawn)(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", powershellHttpClient],
      {
        cwd: windowsBridgeCwd,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      child.kill();
      finish(rejectPromise, typedMcpError(
        "mcp_request_aborted",
        null,
        "Strategy Arena Lab MCP request was aborted."
      ));
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(
      rejectPromise,
      typedMcpError(
        "mcp_windows_bridge_transport",
        error?.message,
        "Strategy Arena Lab Windows bridge could not start."
      )
    ));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          rejectPromise,
          typedMcpError(
            "mcp_windows_bridge_failed",
            stderr,
            `Strategy Arena Lab Windows bridge failed with exit code ${code}.`
          )
        );
        return;
      }
      const newline = stdout.indexOf("\n");
      const status = Number((newline >= 0 ? stdout.slice(0, newline) : stdout).trim());
      const encodedBody = (newline >= 0 ? stdout.slice(newline + 1) : "").trim();
      if (!Number.isInteger(status)) {
        finish(
          rejectPromise,
          typedMcpError(
            "mcp_windows_bridge_invalid_status",
            null,
            "Strategy Arena Lab Windows bridge returned no HTTP status."
          )
        );
        return;
      }
      try {
        if (
          encodedBody
          && (
            encodedBody.length % 4 !== 0
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedBody)
            || Buffer.from(encodedBody, "base64").toString("base64") !== encodedBody
          )
        ) {
          throw typedMcpError(
            "mcp_windows_bridge_invalid_body",
            null,
            "Strategy Arena Lab Windows bridge returned an invalid encoded body."
          );
        }
        const body = Buffer.from(encodedBody, "base64").toString("utf8");
        finish(resolvePromise, parseHttpResponse(status, body));
      } catch (error) {
        finish(rejectPromise, error);
      }
    });
    const presentation = presentationHeaders(options);
    child.stdin.end(JSON.stringify({
      endpoint: session.endpoint,
      token: session.token,
      agentSession: AGENT_SESSION_ID,
      profile: presentation[MCP_PROFILE_HEADER] || "",
      textFormat: presentation[MCP_TEXT_HEADER] || "",
      agentLabel: presentation[AGENT_LABEL_HEADER] || "",
      clientName: presentation[CLIENT_NAME_HEADER] || "",
      message
    }));
  });
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function forwardMcpMessage(message, options = {}) {
  const session = options.session || readSession(options).session;
  const timeoutMs = Math.max(1_000, Math.min(
    REQUEST_TIMEOUT_MS,
    Number(options.timeoutMs || REQUEST_TIMEOUT_MS)
  ));
  let response;
  try {
    response = await (options.fetchImpl || fetch)(session.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${session.token}`,
        [AGENT_SESSION_HEADER]: AGENT_SESSION_ID,
        ...presentationHeaders(options)
      },
      body: JSON.stringify(message),
      signal: requestSignal(options.signal, timeoutMs)
    });
  } catch (error) {
    if (
      options.allowWindowsFallback !== false
      && isWindowsInteropRuntime()
      && !options.signal?.aborted
    ) {
      try {
        return await forwardThroughWindows(session, message, options);
      } catch (fallbackError) {
        throw typedMcpError(
          fallbackError?.code || "mcp_windows_bridge_transport",
          fallbackError?.message,
          "Strategy Arena Lab MCP transport failed."
        );
      }
    }
    throw typedMcpError(
      options.signal?.aborted ? "mcp_request_aborted" : "mcp_transport_error",
      error?.message,
      options.signal?.aborted
        ? "Strategy Arena Lab MCP request was aborted."
        : "Strategy Arena Lab MCP transport failed."
    );
  }
  const body = await response.text();
  return parseHttpResponse(response.status, body);
}

function safeMcpErrorMessage(value, fallback = DEFAULT_MCP_ERROR_MESSAGE) {
  const text = typeof value === "string" && value.trim() ? value : fallback;
  const normalized = text.normalize("NFKC");
  const lower = normalized.toLowerCase();
  const dense = lower.replace(/[\s"'`]+/g, "");
  const sensitiveAssignment = [
    "authorization",
    "token",
    "secret",
    "password",
    "apikey",
    "api_key",
    "api-key",
    "cookie",
    "credential",
    "endpoint",
    "param",
    "params",
    "parameters",
    "requestbody",
    "responsebody",
    "body",
    "payload",
    "pine",
    "pinescript",
    "pinesource"
  ].some((key) => dense.includes(`${key}:`) || dense.includes(`${key}=`));
  const sensitiveText = sensitiveAssignment
    || /\bbearer\s/i.test(normalized)
    || /\b(?:https?|wss?|file):\/\//i.test(normalized)
    || /\b(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?\b/i.test(normalized)
    || /(?:^|[\s"'([{:=])(?:~[\\/]|\.{1,2}[\\/]|\/(?!\/)[^\s"'()[\]{}]+|[a-z]:[\\/]|\\\\)/i.test(normalized)
    || /\/\/@\s*version\s*=|(?:strategy|indicator|library|study)\s*\(|(?:request\.security|strategy\.(?:entry|exit|order))\s*\(/i.test(normalized)
    || /\b(?:sk|rk)_(?:live|test)_[a-z0-9_-]{16,}\b/i.test(normalized)
    || /\bwhsec_[a-z0-9_-]{16,}\b/i.test(normalized)
    || /\b[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{16,}\b/i.test(normalized)
    || /^\s*[\[{]/.test(normalized);
  if (sensitiveText) return REDACTED_MCP_ERROR_MESSAGE;
  return Array.from(normalized
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim())
    .slice(0, MCP_ERROR_MESSAGE_LIMIT)
    .join("") || fallback;
}

function typedMcpError(code, value, fallback = DEFAULT_MCP_ERROR_MESSAGE) {
  const error = new Error(safeMcpErrorMessage(value, fallback));
  error.code = code;
  return error;
}

function mcpCallError(errorValue, fallbackMessage = DEFAULT_MCP_ERROR_MESSAGE) {
  const error = new Error(safeMcpErrorMessage(errorValue?.message, fallbackMessage));
  if (typeof errorValue?.code === "string" || typeof errorValue?.code === "number") {
    error.code = errorValue.code;
  }
  return error;
}

export async function callMcpTool(name, argumentsValue = {}, options = {}) {
  const id = options.requestId
    || `planner-${Date.now().toString(36)}-${String(++requestSequence).padStart(4, "0")}`;
  const response = await forwardMcpMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: argumentsValue
    }
  }, options);
  if (response?.error) {
    throw mcpCallError(response.error);
  }
  const result = response?.result;
  if (result?.isError) {
    const structuredError = result?.structuredContent?.error || result?.error;
    const message = structuredError?.message
      || result?.content?.find((item) => item?.type === "text")?.text
      || DEFAULT_MCP_ERROR_MESSAGE;
    throw mcpCallError({ code: structuredError?.code, message });
  }
  return result?.structuredContent ?? null;
}

export async function listMcpTools(options = {}) {
  const response = await forwardMcpMessage({
    jsonrpc: "2.0",
    id: options.requestId || `planner-tools-${Date.now().toString(36)}`,
    method: "tools/list",
    params: {}
  }, options);
  if (response?.error) {
    throw mcpCallError(response.error, "Strategy Arena Lab MCP tools/list failed.");
  }
  return Array.isArray(response?.result?.tools) ? response.result.tools : [];
}
