"use strict";

/**
 * Surge CLI compatibility layer for running and debugging Surge scripts in Node.js.
 *
 * Purpose
 * -------
 * This file emulates Surge scripting globals in a plain Node runtime, so the
 * same script can be executed outside the Surge app. It is designed for local
 * debugging, CI smoke tests, and reproducible script development workflows.
 *
 * What this shim provides
 * -----------------------
 * 1. Runtime globals:
 *    - `$done`
 *    - `$httpClient` (get/post/put/delete/head/options/patch)
 *    - `$persistentStore`
 *    - `$notification`
 *    - `$utils` (geoip, ipasn, ipaso, ungzip)
 *    - `$httpAPI` (optional bridge mode)
 *    - `$surge` (best-effort control API state)
 *    - `$script`, `$environment`, `$network`, `$argument`, `$intent`
 *
 * 2. Script-type specific context:
 *    - `generic`
 *    - `http-request` with `$request`
 *    - `http-response` with `$request` and `$response`
 *    - `rule` with `$request`
 *    - `dns` with `$domain`
 *    - `event` with `$event`
 *    - `cron` with `$cronexp`
 *
 * 3. HTTP behavior for debugging:
 *    - timeout control
 *    - redirect toggle
 *    - binary response mode
 *    - in-memory cookie jar (`auto-cookie`)
 *    - optional insecure TLS for troubleshooting (`insecure`, Undici-backed)
 *
 * Usage
 * -----
 * Preload mode (closest to Surge script execution):
 * - `node -r ./surge_cli_compat.js ./disney_check.js`
 *
 * Standalone runner mode:
 * - `node ./surge_cli_compat.js --script ./disney_check.js --type generic`
 *
 * Runner with injected request/response context:
 * - `node ./surge_cli_compat.js --script ./rewrite.js --type http-response --request-json @./tmp/request.json --response-json @./tmp/response.json`
 *
 * Runner with script argument:
 * - `node ./surge_cli_compat.js --script ./panel.js --argument 'title=Demo&timeout=3000'`
 *
 * Public API for programmatic usage:
 * - `installSurgeCompat(options)`
 * - `runScriptWithCompat(scriptPath, options)`
 *
 * Important notes
 * ---------------
 * - This is a compatibility layer, not a full Surge runtime replacement.
 * - Some Surge-only capabilities cannot be reproduced in CLI and are surfaced
 *   via one-time warnings when `warnUnsupported` is enabled.
 * - Persistent data is stored in JSON file form (default:
 *   `.surge-persistent-store.json`) for deterministic local debugging.
 *
 * Key env vars (all optional)
 * ---------------------------
 * Core:
 * - `ARGUMENT`
 * - `SURGE_SHIM_SCRIPT_TYPE`
 * - `SURGE_SHIM_SCRIPT_PATH`
 * - `SURGE_SHIM_SCRIPT_NAME`
 * - `SURGE_SHIM_STORE_FILE`
 *
 * Context injection:
 * - `SURGE_SHIM_REQUEST_JSON`
 * - `SURGE_SHIM_RESPONSE_JSON`
 * - `SURGE_SHIM_EVENT_JSON`
 * - `SURGE_SHIM_EVENT_NAME`
 * - `SURGE_SHIM_EVENT_DATA`
 * - `SURGE_SHIM_DOMAIN`
 * - `SURGE_SHIM_CRONEXP`
 * - `SURGE_SHIM_INTENT_JSON`
 * - `SURGE_SHIM_INTENT_PARAMETER`
 *
 * Runtime behavior:
 * - `SURGE_SHIM_HTTP_TIMEOUT_SECONDS`
 * - `SURGE_SHIM_HTTP_API_BASE_URL`
 * - `SURGE_SHIM_HTTP_API_KEY`
 * - `SURGE_SHIM_HTTP_API_TIMEOUT_SECONDS`
 * - `SURGE_SHIM_PRINT_DONE`
 * - `SURGE_SHIM_EXIT_ON_DONE`
 * - `SURGE_SHIM_WARN_UNSUPPORTED`
 * - `SURGE_SHIM_WAIT_FOR_DONE_MS`
 * - `SURGE_SHIM_AUTO_INSTALL`
 */

const crypto = require("node:crypto");
const dns = require("node:dns");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const zlib = require("node:zlib");
const { pathToFileURL } = require("node:url");

let UndiciAgent = null;
try {
  ({ Agent: UndiciAgent } = require("undici"));
} catch {
  // Optional. We can still run without custom TLS dispatcher.
}

const SHIM_NAME = "surge-cli-compat";
const RUNTIME_SYMBOL = Symbol.for("surge.cli.compat.runtime");
const SUPPORTED_SCRIPT_TYPES = new Set([
  "generic",
  "http-request",
  "http-response",
  "rule",
  "dns",
  "event",
  "cron",
]);

const DEFAULTS = Object.freeze({
  scriptType: "generic",
  httpTimeoutSeconds: 5,
  httpApiTimeoutSeconds: 8,
  printDone: true,
  exitOnDone: true,
  warnUnsupported: true,
  autoInstallWhenRequired: true,
  waitForDoneMs: 30_000,
});

function warn(message) {
  console.warn(`[${SHIM_NAME}] ${message}`);
}

function info(message) {
  console.log(`[${SHIM_NAME}] ${message}`);
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeScriptType(rawType) {
  const value = String(rawType || DEFAULTS.scriptType)
    .trim()
    .toLowerCase();
  if (SUPPORTED_SCRIPT_TYPES.has(value)) {
    return value;
  }
  warn(`Unknown script type "${value}", fallback to "generic".`);
  return "generic";
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return fallback;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalNumber(value, fallback) {
  if (typeof value === "undefined" || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function cloneValue(value) {
  if (value == null) {
    return value;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fallback below.
    }
  }

  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneValue(v);
    }
    return out;
  }
  return value;
}

function toPrintableValue(value) {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  const binary = toBuffer(value);
  if (binary) {
    return {
      type: "binary",
      encoding: "base64",
      data: binary.toString("base64"),
      byteLength: binary.byteLength,
    };
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(toPrintableValue);
  }

  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toPrintableValue(v);
    }
    return out;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return util.inspect(value, { depth: 5, breakLength: 120 });
  }
}

function safeJsonStringify(value, space = 2) {
  return JSON.stringify(
    value,
    (_key, currentValue) => {
      if (typeof currentValue === "bigint") {
        return String(currentValue);
      }
      return currentValue;
    },
    space,
  );
}

function parseJsonText(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonObjectEnv(envKey) {
  const raw = process.env[envKey];
  if (!raw) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`${envKey} is not valid JSON, ignored.`);
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    warn(`${envKey} should be a JSON object, ignored.`);
    return undefined;
  }
  return parsed;
}

function parseJsonAnyEnv(envKey) {
  const raw = process.env[envKey];
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    warn(`${envKey} is not valid JSON, ignored.`);
    return undefined;
  }
}

function normalizeHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== "object") {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (!key || value == null) {
      continue;
    }
    out[String(key)] = String(value);
  }
  return out;
}

function findHeaderKey(headers, expectedName) {
  const expected = String(expectedName).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) {
      return key;
    }
  }
  return null;
}

function setHeader(headers, name, value, overwrite = true) {
  const existing = findHeaderKey(headers, name);
  if (existing) {
    if (overwrite) {
      headers[existing] = String(value);
    }
    return;
  }
  headers[String(name)] = String(value);
}

function normalizeBody(rawBody, headers) {
  if (rawBody == null) {
    return undefined;
  }

  if (
    typeof rawBody === "string" ||
    rawBody instanceof URLSearchParams ||
    rawBody instanceof Blob ||
    rawBody instanceof FormData
  ) {
    return rawBody;
  }

  const binary = toBuffer(rawBody);
  if (binary) {
    return binary;
  }

  if (isPlainObject(rawBody) || Array.isArray(rawBody)) {
    setHeader(headers, "content-type", "application/json", false);
    return JSON.stringify(rawBody);
  }

  return String(rawBody);
}

function resolveScriptPath(rawPath) {
  if (!rawPath) {
    return "";
  }
  try {
    return path.resolve(rawPath);
  } catch {
    return String(rawPath);
  }
}

function inferScriptName(scriptPath) {
  if (!scriptPath) {
    return "script.js";
  }
  return path.basename(scriptPath);
}

function generateRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function isPrivateIp(ip) {
  if (typeof ip !== "string" || !ip) {
    return false;
  }
  if (ip === "127.0.0.1" || ip === "::1") {
    return true;
  }
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) {
    return true;
  }

  const parts = ip.split(".");
  if (parts.length === 4) {
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    if (
      first === 172 &&
      Number.isFinite(second) &&
      second >= 16 &&
      second <= 31
    ) {
      return true;
    }
  }

  const lower = ip.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }

  return false;
}

function readPrimaryAddresses() {
  const output = {
    interface: "",
    ipv4: "",
    ipv6: "",
  };

  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.internal) {
        continue;
      }
      if (!output.interface) {
        output.interface = name;
      }
      if (!output.ipv4 && entry.family === "IPv4") {
        output.ipv4 = entry.address;
      }
      if (!output.ipv6 && entry.family === "IPv6") {
        output.ipv6 = entry.address;
      }
      if (output.ipv4 && output.ipv6) {
        return output;
      }
    }
  }

  return output;
}

function buildDefaultNetwork() {
  const addresses = readPrimaryAddresses();
  const servers = dns.getServers();
  return {
    v4: {
      primaryAddress: addresses.ipv4,
    },
    v6: {
      primaryAddress: addresses.ipv6,
    },
    wifi: {
      ssid: "",
      bssid: "",
    },
    cellular: {
      carrierName: "",
      radio: "",
    },
    dns: servers,

    // Backward-friendly aliases.
    "primary-interface": addresses.interface,
    "v4-primary-address": addresses.ipv4,
    "v6-primary-address": addresses.ipv6,
  };
}

function mergeObjects(base, patch) {
  if (!isPlainObject(base)) {
    return cloneValue(patch);
  }
  if (!isPlainObject(patch)) {
    return cloneValue(base);
  }
  const out = cloneValue(base);
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeObjects(out[key], value);
      continue;
    }
    out[key] = cloneValue(value);
  }
  return out;
}

function normalizeNetwork(rawNetwork) {
  const base = buildDefaultNetwork();
  if (!isPlainObject(rawNetwork)) {
    return base;
  }
  return mergeObjects(base, rawNetwork);
}

function buildDefaultEnvironment() {
  const locale =
    Intl.DateTimeFormat().resolvedOptions().locale ||
    process.env.LANG ||
    "en-US";
  const system =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform;

  return {
    system,
    "surge-build": process.env.SURGE_BUILD || process.version,
    "surge-version": process.env.SURGE_VERSION || "node-shim",
    language: String(locale),
    "device-model": os.hostname(),
  };
}

function normalizeEnvironment(rawEnvironment) {
  const base = buildDefaultEnvironment();
  if (!isPlainObject(rawEnvironment)) {
    return base;
  }
  return mergeObjects(base, rawEnvironment);
}

function buildDefaultRequestContext() {
  const url = "https://example.com/";
  return {
    id: generateRequestId(),
    url,
    method: "GET",
    headers: {},
    body: "",
    hostname: "example.com",
    destPort: 443,
    processPath: "",
    userAgent: "",
    sourceIP: "",
    listenPort: 0,
    srcPort: 0,
    protocol: 6,
    dnsResult: {
      address: "",
      asn: 0,
      country: "",
      isPrivate: false,
    },
  };
}

function normalizeRequestContext(rawRequest) {
  const base = buildDefaultRequestContext();
  if (!isPlainObject(rawRequest)) {
    return base;
  }

  const merged = mergeObjects(base, rawRequest);
  merged.id = merged.id ? String(merged.id) : generateRequestId();
  merged.method = String(merged.method || "GET").toUpperCase();
  merged.headers = normalizeHeaders(merged.headers);

  let parsedUrl = null;
  try {
    parsedUrl = new URL(String(merged.url));
  } catch {
    // Keep user value when URL parsing fails.
  }
  if (parsedUrl) {
    merged.hostname = merged.hostname || parsedUrl.hostname;
    if (!merged.destPort) {
      merged.destPort = parsedUrl.port
        ? Number(parsedUrl.port)
        : parsedUrl.protocol === "http:"
          ? 80
          : 443;
    }
  }
  return merged;
}

function buildDefaultResponseContext() {
  return {
    status: 200,
    headers: {},
    body: "",
  };
}

function normalizeResponseContext(rawResponse) {
  const base = buildDefaultResponseContext();
  if (!isPlainObject(rawResponse)) {
    return base;
  }
  const merged = mergeObjects(base, rawResponse);
  merged.status = Number.isFinite(Number(merged.status))
    ? Number(merged.status)
    : 200;
  merged.headers = normalizeHeaders(merged.headers);
  return merged;
}

function normalizeEventContext(rawEvent, fallbackName, fallbackData) {
  const base = {
    name: fallbackName || "network-changed",
    data: fallbackData || "",
  };
  if (!isPlainObject(rawEvent)) {
    return base;
  }
  const merged = mergeObjects(base, rawEvent);
  merged.name = String(merged.name || base.name);
  merged.data = merged.data == null ? "" : String(merged.data);
  return merged;
}

function normalizeIntent(rawIntent, fallbackParameter) {
  if (isPlainObject(rawIntent)) {
    return cloneValue(rawIntent);
  }
  if (typeof fallbackParameter === "string") {
    return { parameter: fallbackParameter };
  }
  return undefined;
}

class PersistentStoreBackend {
  constructor(storeFile, scriptKey) {
    this.storeFile = storeFile;
    this.scriptKey = scriptKey;
  }

  readAll() {
    const fallback = {
      version: 1,
      keyed: {},
      scriptScoped: {},
    };

    if (!fs.existsSync(this.storeFile)) {
      return fallback;
    }

    try {
      const text = fs.readFileSync(this.storeFile, "utf8");
      const parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) {
        return fallback;
      }
      return {
        version: 1,
        keyed: isPlainObject(parsed.keyed) ? parsed.keyed : {},
        scriptScoped: isPlainObject(parsed.scriptScoped)
          ? parsed.scriptScoped
          : {},
      };
    } catch {
      warn(`Cannot parse store file ${this.storeFile}, use empty store.`);
      return fallback;
    }
  }

  writeAll(store) {
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      fs.writeFileSync(
        this.storeFile,
        `${safeJsonStringify(store, 2)}\n`,
        "utf8",
      );
      return true;
    } catch (error) {
      warn(
        `Cannot write store file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  read(key) {
    const store = this.readAll();
    if (typeof key === "undefined") {
      return store.scriptScoped[this.scriptKey] ?? null;
    }
    return store.keyed[String(key)] ?? null;
  }

  write(data, key) {
    if (typeof data !== "string") {
      return false;
    }

    const store = this.readAll();
    if (typeof key === "undefined") {
      store.scriptScoped[this.scriptKey] = data;
    } else {
      store.keyed[String(key)] = data;
    }
    return this.writeAll(store);
  }
}

class CookieJar {
  constructor() {
    this.cookies = [];
  }

  purgeExpired(now = Date.now()) {
    this.cookies = this.cookies.filter((cookie) => {
      if (cookie.expiresAt == null) {
        return true;
      }
      return cookie.expiresAt > now;
    });
  }

  setFromResponse(urlString, responseHeaders) {
    const setCookies = getSetCookieHeaders(responseHeaders);
    if (!setCookies.length) {
      return;
    }

    let urlObj = null;
    try {
      urlObj = new URL(urlString);
    } catch {
      return;
    }

    for (const raw of setCookies) {
      const cookie = parseSetCookie(raw, urlObj);
      if (!cookie) {
        continue;
      }

      this.cookies = this.cookies.filter(
        (existing) =>
          !(
            existing.name === cookie.name &&
            existing.domain === cookie.domain &&
            existing.path === cookie.path
          ),
      );

      if (cookie.expiresAt != null && cookie.expiresAt <= Date.now()) {
        continue;
      }
      this.cookies.push(cookie);
    }
    this.purgeExpired();
  }

  getCookieHeader(urlString) {
    let urlObj = null;
    try {
      urlObj = new URL(urlString);
    } catch {
      return "";
    }

    this.purgeExpired();

    const host = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname || "/";
    const isHttps = urlObj.protocol === "https:";
    const matched = [];

    for (const cookie of this.cookies) {
      if (cookie.secure && !isHttps) {
        continue;
      }
      if (!domainMatches(host, cookie.domain, cookie.hostOnly)) {
        continue;
      }
      if (!pathMatches(pathname, cookie.path)) {
        continue;
      }
      matched.push(cookie);
    }

    if (!matched.length) {
      return "";
    }

    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }
}

function defaultCookiePath(pathname) {
  if (!pathname || !pathname.startsWith("/")) {
    return "/";
  }
  if (pathname === "/") {
    return "/";
  }
  const index = pathname.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return pathname.slice(0, index);
}

function parseSetCookie(rawSetCookie, urlObj) {
  if (typeof rawSetCookie !== "string" || !rawSetCookie.trim()) {
    return null;
  }

  const segments = rawSetCookie.split(";").map((item) => item.trim());
  if (!segments.length) {
    return null;
  }

  const [nameValue, ...attributeSegments] = segments;
  const eqIndex = nameValue.indexOf("=");
  if (eqIndex <= 0) {
    return null;
  }

  const name = nameValue.slice(0, eqIndex).trim();
  const value = nameValue.slice(eqIndex + 1).trim();
  if (!name) {
    return null;
  }

  const cookie = {
    name,
    value,
    domain: urlObj.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultCookiePath(urlObj.pathname),
    secure: false,
    expiresAt: null,
  };

  for (const attribute of attributeSegments) {
    if (!attribute) {
      continue;
    }
    const attrEqIndex = attribute.indexOf("=");
    const attrName =
      attrEqIndex >= 0
        ? attribute.slice(0, attrEqIndex).trim().toLowerCase()
        : attribute.trim().toLowerCase();
    const attrValue =
      attrEqIndex >= 0 ? attribute.slice(attrEqIndex + 1).trim() : "";

    if (attrName === "domain") {
      const normalized = attrValue.replace(/^\.+/, "").toLowerCase();
      if (normalized) {
        cookie.domain = normalized;
        cookie.hostOnly = false;
      }
      continue;
    }

    if (attrName === "path") {
      cookie.path = attrValue || "/";
      continue;
    }

    if (attrName === "secure") {
      cookie.secure = true;
      continue;
    }

    if (attrName === "max-age") {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) {
        cookie.expiresAt = Date.now() + Math.round(seconds * 1000);
      }
      continue;
    }

    if (attrName === "expires") {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) {
        cookie.expiresAt = parsed;
      }
      continue;
    }
  }

  if (!cookie.path.startsWith("/")) {
    cookie.path = "/";
  }
  return cookie;
}

function splitCombinedSetCookie(value) {
  // Fallback parser when headers.getSetCookie() is unavailable.
  const out = [];
  let current = "";
  let inExpires = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    current += char;

    if (char === ",") {
      const lower = current.toLowerCase();
      if (lower.includes("expires=") && !lower.endsWith("gmt,")) {
        inExpires = true;
        continue;
      }
      if (!inExpires) {
        out.push(current.slice(0, -1).trim());
        current = "";
      }
      continue;
    }

    if (inExpires && char === ";") {
      inExpires = false;
    }
  }

  if (current.trim()) {
    out.push(current.trim());
  }
  return out.filter(Boolean);
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  if (!single) {
    return [];
  }
  return splitCombinedSetCookie(single);
}

function domainMatches(hostname, cookieDomain, hostOnly) {
  if (hostOnly) {
    return hostname === cookieDomain;
  }
  return hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`);
}

function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) {
    return true;
  }
  if (!pathname.startsWith(cookiePath)) {
    return false;
  }
  if (cookiePath.endsWith("/")) {
    return true;
  }
  return pathname[cookiePath.length] === "/";
}

function buildHttpClientResponse(response) {
  const headers = Object.fromEntries(response.headers.entries());
  if (!hasOwn(headers, "x-originating-url")) {
    headers["x-originating-url"] = response.url;
  }
  return {
    status: response.status,
    statusCode: response.status,
    ok: response.ok,
    headers,
    url: response.url,
  };
}

function warnUnsupported(runtime, feature, details) {
  if (!runtime.config.warnUnsupported) {
    return;
  }
  const key = `${feature}:${details}`;
  if (runtime.warnedUnsupported.has(key)) {
    return;
  }
  runtime.warnedUnsupported.add(key);
  warn(`${feature} is not fully supported in Node shim. ${details}`);
}

function parseHttpRequestOptions(runtime, input, forcedMethod) {
  let options = null;
  if (typeof input === "string") {
    options = { url: input };
  } else if (isPlainObject(input)) {
    options = input;
  } else {
    throw new Error("$httpClient options must be URL string or object.");
  }

  const url = typeof options.url === "string" ? options.url.trim() : "";
  if (!url) {
    throw new Error("$httpClient options.url is required.");
  }

  const method = String(forcedMethod || options.method || "GET").toUpperCase();
  const headers = normalizeHeaders(options.headers);
  const body = normalizeBody(options.body, headers);
  const timeoutSeconds = parsePositiveNumber(
    options.timeout,
    runtime.config.httpTimeoutSeconds,
  );
  const autoRedirect = options["auto-redirect"] !== false;
  const binaryMode = options["binary-mode"] === true;
  const autoCookie = options["auto-cookie"] !== false;
  const insecure = options.insecure === true;

  if (typeof options.policy !== "undefined") {
    warnUnsupported(
      runtime,
      "`policy`",
      "Policy routing cannot be emulated in CLI.",
    );
  }
  if (typeof options["policy-descriptor"] !== "undefined") {
    warnUnsupported(
      runtime,
      "`policy-descriptor`",
      "Temporary policy descriptors are unavailable in CLI.",
    );
  }

  return {
    url,
    method,
    headers,
    body,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    autoRedirect,
    binaryMode,
    autoCookie,
    insecure,
  };
}

async function executeHttpRequest(runtime, input, forcedMethod) {
  const parsed = parseHttpRequestOptions(runtime, input, forcedMethod);
  const headers = { ...parsed.headers };

  if (parsed.autoCookie) {
    const cookieHeader = runtime.cookieJar.getCookieHeader(parsed.url);
    if (cookieHeader && !findHeaderKey(headers, "cookie")) {
      headers.Cookie = cookieHeader;
    }
  }

  let body = parsed.body;
  if (
    typeof body !== "undefined" &&
    (parsed.method === "GET" || parsed.method === "HEAD")
  ) {
    warnUnsupported(runtime, "`body` for GET/HEAD", "Request body dropped.");
    body = undefined;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), parsed.timeoutMs);

  const requestInit = {
    method: parsed.method,
    headers,
    body,
    redirect: parsed.autoRedirect ? "follow" : "manual",
    signal: controller.signal,
  };

  if (parsed.insecure) {
    if (UndiciAgent) {
      if (!runtime.insecureAgent) {
        runtime.insecureAgent = new UndiciAgent({
          connect: { rejectUnauthorized: false },
        });
      }
      requestInit.dispatcher = runtime.insecureAgent;
    } else {
      warnUnsupported(
        runtime,
        "`insecure`",
        "Undici Agent is unavailable in this Node runtime.",
      );
    }
  }

  try {
    const response = await fetch(parsed.url, requestInit);
    if (parsed.autoCookie) {
      runtime.cookieJar.setFromResponse(parsed.url, response.headers);
    }

    const data = parsed.binaryMode
      ? new Uint8Array(await response.arrayBuffer())
      : await response.text();

    return {
      error: null,
      response: buildHttpClientResponse(response),
      data,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      response: null,
      data: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function makeHttpClient(runtime) {
  const call = (input, callback, forcedMethod) => {
    if (typeof callback !== "function") {
      throw new TypeError("$httpClient callback must be a function.");
    }
    executeHttpRequest(runtime, input, forcedMethod)
      .then((result) => {
        callback(result.error, result.response, result.data);
      })
      .catch((error) => {
        callback(
          error instanceof Error ? error.message : String(error),
          null,
          null,
        );
      });
  };

  return {
    get(input, callback) {
      call(input, callback, "GET");
    },
    post(input, callback) {
      call(input, callback, "POST");
    },
    put(input, callback) {
      call(input, callback, "PUT");
    },
    delete(input, callback) {
      call(input, callback, "DELETE");
    },
    head(input, callback) {
      call(input, callback, "HEAD");
    },
    options(input, callback) {
      call(input, callback, "OPTIONS");
    },
    patch(input, callback) {
      call(input, callback, "PATCH");
    },
  };
}

function normalizeDoneResult(runtime, result) {
  const type = runtime.config.scriptType;
  if (typeof result === "undefined") {
    return result;
  }

  if (type === "rule") {
    if (!isPlainObject(result) || typeof result.matched !== "boolean") {
      warnUnsupported(
        runtime,
        "$done result for rule",
        "Expected object with boolean `matched`.",
      );
    }
    return result;
  }

  if (type === "dns") {
    if (!isPlainObject(result)) {
      warnUnsupported(
        runtime,
        "$done result for dns",
        "Expected object with address/addresses/server/servers.",
      );
      return result;
    }
    const hasKnownField =
      hasOwn(result, "address") ||
      hasOwn(result, "addresses") ||
      hasOwn(result, "server") ||
      hasOwn(result, "servers");
    if (!hasKnownField) {
      warnUnsupported(
        runtime,
        "$done result for dns",
        "No result field provided, Surge would fallback to default resolver.",
      );
    }
    return result;
  }

  if (type === "http-request") {
    if (result != null && !isPlainObject(result)) {
      warnUnsupported(
        runtime,
        "$done result for http-request",
        "Expected object or undefined.",
      );
    }
    return result;
  }

  if (type === "http-response") {
    if (result != null && !isPlainObject(result)) {
      warnUnsupported(
        runtime,
        "$done result for http-response",
        "Expected object or undefined.",
      );
    }
    return result;
  }

  return result;
}

function createDoneFunction(runtime) {
  return function done(result) {
    if (runtime.doneCalled) {
      return;
    }

    runtime.doneCalled = true;
    runtime.doneResult = normalizeDoneResult(runtime, result);
    runtime.resolveDone(runtime.doneResult);

    if (runtime.config.printDone && typeof runtime.doneResult !== "undefined") {
      const printable = toPrintableValue(runtime.doneResult);
      if (typeof printable === "string") {
        console.log(printable);
      } else {
        console.log(safeJsonStringify(printable, 2));
      }
    }

    if (runtime.config.exitOnDone) {
      process.nextTick(() => {
        process.exit(process.exitCode ?? 0);
      });
    }
  };
}

function createHttpApiFunction(runtime) {
  return function httpAPI(method, apiPath, body, callback) {
    let payload = body;
    let cb = callback;
    if (typeof payload === "function" && typeof cb === "undefined") {
      cb = payload;
      payload = undefined;
    }
    if (typeof cb !== "function") {
      throw new TypeError("$httpAPI callback must be a function.");
    }

    const baseUrl = runtime.config.httpApiBaseUrl;
    if (!baseUrl) {
      cb({
        error: `${SHIM_NAME}: $httpAPI is unavailable, set SURGE_SHIM_HTTP_API_BASE_URL.`,
      });
      return;
    }

    let url = `${baseUrl.replace(/\/+$/, "")}/${String(apiPath || "").replace(/^\/+/, "")}`;
    const normalizedMethod = String(method || "GET").toUpperCase();
    const headers = {
      accept: "application/json, */*",
    };
    if (runtime.config.httpApiKey) {
      headers["x-key"] = runtime.config.httpApiKey;
    }

    const requestInit = {
      method: normalizedMethod,
      headers,
    };

    if (normalizedMethod === "GET" && isPlainObject(payload)) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        if (value == null) {
          continue;
        }
        params.set(key, String(value));
      }
      const query = params.toString();
      if (query) {
        url += url.includes("?") ? `&${query}` : `?${query}`;
      }
    } else if (typeof payload !== "undefined") {
      headers["content-type"] = "application/json";
      requestInit.body =
        typeof payload === "string" ? payload : safeJsonStringify(payload, 0);
    }

    const controller = new AbortController();
    const timeoutMs = Math.round(runtime.config.httpApiTimeoutSeconds * 1000);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    requestInit.signal = controller.signal;

    fetch(url, requestInit)
      .then(async (response) => {
        const text = await response.text();
        let result;
        try {
          result = text ? JSON.parse(text) : {};
        } catch {
          result = {
            status: response.status,
            body: text,
          };
        }

        if (!isPlainObject(result)) {
          cb({
            status: response.status,
            data: result,
          });
          return;
        }

        if (!hasOwn(result, "status")) {
          result.status = response.status;
        }
        cb(result);
      })
      .catch((error) => {
        cb({
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });
  };
}

function createSurgeControlApi(runtime) {
  const state = runtime.surgeState;
  return {
    setSelectGroupPolicy(groupName, policyName) {
      const group = String(groupName || "").trim();
      const policy = String(policyName || "").trim();
      if (!group || !policy) {
        return false;
      }
      state.selectedPolicies[group] = policy;
      return true;
    },
    selectGroupDetails() {
      return cloneValue(state.selectGroupDetails);
    },
    getSelectGroupPolicy(groupName) {
      const group = String(groupName || "").trim();
      if (!group) {
        return null;
      }
      return state.selectedPolicies[group] ?? null;
    },
    setOutboundMode(mode) {
      const normalized = String(mode || "").trim();
      if (!normalized) {
        return false;
      }
      state.outboundMode = normalized;
      return true;
    },
    getOutboundMode() {
      return state.outboundMode;
    },
    setScriptResult(result) {
      state.scriptResult = cloneValue(result);
      return true;
    },
    setDNSResult(result) {
      state.dnsResult = cloneValue(result);
      return true;
    },
  };
}

function createUtilsApi(runtime) {
  return {
    geoip(ip) {
      const value = String(ip || "");
      if (value && hasOwn(runtime.geoipMap, value)) {
        return String(runtime.geoipMap[value]);
      }
      if (isPrivateIp(value)) {
        return "PRIVATE";
      }
      return null;
    },
    ipasn(ip) {
      const value = String(ip || "");
      if (value && hasOwn(runtime.ipasnMap, value)) {
        return String(runtime.ipasnMap[value]);
      }
      return null;
    },
    ipaso(ip) {
      const value = String(ip || "");
      if (value && hasOwn(runtime.ipasoMap, value)) {
        return String(runtime.ipasoMap[value]);
      }
      return null;
    },
    ungzip(binary) {
      const buffer = toBuffer(binary);
      if (!buffer) {
        throw new TypeError(
          "$utils.ungzip expects Uint8Array/ArrayBuffer/Buffer.",
        );
      }
      return new Uint8Array(zlib.gunzipSync(buffer));
    },
  };
}

function createNotificationApi() {
  return {
    post(title, subtitle, body, options) {
      const payload = {
        title: title ?? "",
        subtitle: subtitle ?? "",
        body: body ?? "",
        options: toPrintableValue(options),
      };
      console.log(`[notification] ${safeJsonStringify(payload, 0)}`);
    },
  };
}

function setGlobalIfNeeded(name, value, force) {
  if (typeof globalThis[name] !== "undefined" && !force) {
    return;
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function buildScriptContext(config) {
  const context = {
    argument: config.argument,
    request: config.request,
    response: config.response,
    event: config.event,
    domain: config.domain,
    cronexp: config.cronexp,
    intent: config.intent,
  };

  if (config.scriptType === "http-request") {
    context.request = normalizeRequestContext(context.request);
  }
  if (config.scriptType === "http-response") {
    context.request = normalizeRequestContext(context.request);
    context.response = normalizeResponseContext(context.response);
  }
  if (config.scriptType === "rule") {
    context.request = normalizeRequestContext(context.request);
  }
  if (config.scriptType === "dns") {
    context.domain = String(context.domain || "example.com");
  }
  if (config.scriptType === "cron") {
    context.cronexp = String(context.cronexp || "* * * * *");
  }
  if (config.scriptType === "event") {
    context.event = normalizeEventContext(
      context.event,
      config.eventName,
      config.eventData,
    );
  }
  if (typeof context.intent !== "undefined") {
    context.intent = cloneValue(context.intent);
  }

  return context;
}

function buildConfig(overrides = {}) {
  const scriptPath = resolveScriptPath(
    overrides.scriptPath ||
      process.env.SURGE_SHIM_SCRIPT_PATH ||
      process.env.SURGE_CLI_SCRIPT_PATH ||
      process.argv[1],
  );
  const scriptName =
    overrides.scriptName ||
    process.env.SURGE_SHIM_SCRIPT_NAME ||
    process.env.SURGE_CLI_SCRIPT_NAME ||
    inferScriptName(scriptPath);

  const rawType =
    overrides.scriptType ||
    process.env.SURGE_SHIM_SCRIPT_TYPE ||
    process.env.SURGE_CLI_SCRIPT_TYPE ||
    DEFAULTS.scriptType;

  const storeFile =
    overrides.storeFile ||
    process.env.SURGE_SHIM_STORE_FILE ||
    process.env.SURGE_CLI_STORE_FILE ||
    path.resolve(process.cwd(), ".surge-persistent-store.json");

  const argument =
    typeof overrides.argument !== "undefined"
      ? String(overrides.argument)
      : typeof process.env.ARGUMENT === "string"
        ? process.env.ARGUMENT
        : typeof process.env.SURGE_SHIM_ARGUMENT === "string"
          ? process.env.SURGE_SHIM_ARGUMENT
          : typeof process.env.SURGE_CLI_ARGUMENT === "string"
            ? process.env.SURGE_CLI_ARGUMENT
            : undefined;

  const requestRaw =
    typeof overrides.request !== "undefined"
      ? overrides.request
      : (parseJsonAnyEnv("SURGE_SHIM_REQUEST_JSON") ??
        parseJsonAnyEnv("SURGE_CLI_REQUEST_JSON"));

  const responseRaw =
    typeof overrides.response !== "undefined"
      ? overrides.response
      : (parseJsonAnyEnv("SURGE_SHIM_RESPONSE_JSON") ??
        parseJsonAnyEnv("SURGE_CLI_RESPONSE_JSON"));

  const eventRaw =
    typeof overrides.event !== "undefined"
      ? overrides.event
      : (parseJsonAnyEnv("SURGE_SHIM_EVENT_JSON") ??
        parseJsonAnyEnv("SURGE_CLI_EVENT_JSON"));

  const intentRaw =
    typeof overrides.intent !== "undefined"
      ? overrides.intent
      : (parseJsonAnyEnv("SURGE_SHIM_INTENT_JSON") ??
        parseJsonAnyEnv("SURGE_CLI_INTENT_JSON"));

  const eventName =
    overrides.eventName ||
    process.env.SURGE_SHIM_EVENT_NAME ||
    process.env.SURGE_CLI_EVENT_NAME ||
    "network-changed";
  const eventData =
    typeof overrides.eventData !== "undefined"
      ? overrides.eventData
      : (process.env.SURGE_SHIM_EVENT_DATA ??
        process.env.SURGE_CLI_EVENT_DATA ??
        "");

  const intentParameter =
    typeof overrides.intentParameter === "string"
      ? overrides.intentParameter
      : typeof process.env.SURGE_SHIM_INTENT_PARAMETER === "string"
        ? process.env.SURGE_SHIM_INTENT_PARAMETER
        : typeof process.env.SURGE_CLI_INTENT_PARAMETER === "string"
          ? process.env.SURGE_CLI_INTENT_PARAMETER
          : undefined;

  const networkRaw =
    typeof overrides.network !== "undefined"
      ? overrides.network
      : (parseJsonObjectEnv("SURGE_SHIM_NETWORK_JSON") ??
        parseJsonObjectEnv("SURGE_CLI_NETWORK_JSON"));

  const environmentRaw =
    typeof overrides.environment !== "undefined"
      ? overrides.environment
      : (parseJsonObjectEnv("SURGE_SHIM_ENVIRONMENT_JSON") ??
        parseJsonObjectEnv("SURGE_CLI_ENVIRONMENT_JSON"));

  const geoipMap =
    (isPlainObject(overrides.geoipMap) ? overrides.geoipMap : null) ??
    parseJsonObjectEnv("SURGE_SHIM_GEOIP_MAP") ??
    parseJsonObjectEnv("SURGE_CLI_GEOIP_MAP") ??
    {};
  const ipasnMap =
    (isPlainObject(overrides.ipasnMap) ? overrides.ipasnMap : null) ??
    parseJsonObjectEnv("SURGE_SHIM_IPASN_MAP") ??
    parseJsonObjectEnv("SURGE_CLI_IPASN_MAP") ??
    {};
  const ipasoMap =
    (isPlainObject(overrides.ipasoMap) ? overrides.ipasoMap : null) ??
    parseJsonObjectEnv("SURGE_SHIM_IPASO_MAP") ??
    parseJsonObjectEnv("SURGE_CLI_IPASO_MAP") ??
    {};

  const selectGroupDetails =
    (Array.isArray(overrides.selectGroupDetails)
      ? overrides.selectGroupDetails
      : null) ??
    parseJsonAnyEnv("SURGE_SHIM_SELECT_GROUP_DETAILS_JSON") ??
    parseJsonAnyEnv("SURGE_CLI_SELECT_GROUP_DETAILS_JSON") ??
    [];

  return {
    force: parseBoolean(overrides.force, false),
    scriptType: normalizeScriptType(rawType),
    scriptPath,
    scriptName,
    scriptStartTime: overrides.scriptStartTime || new Date(),

    argument,
    request: requestRaw,
    response: responseRaw,
    domain:
      typeof overrides.domain !== "undefined"
        ? overrides.domain
        : (process.env.SURGE_SHIM_DOMAIN ?? process.env.SURGE_CLI_DOMAIN),
    cronexp:
      typeof overrides.cronexp !== "undefined"
        ? overrides.cronexp
        : (process.env.SURGE_SHIM_CRONEXP ?? process.env.SURGE_CLI_CRONEXP),
    event: eventRaw,
    eventName,
    eventData,
    intent: normalizeIntent(intentRaw, intentParameter),

    storeFile: path.resolve(storeFile),
    network: normalizeNetwork(networkRaw),
    environment: normalizeEnvironment(environmentRaw),
    geoipMap,
    ipasnMap,
    ipasoMap,

    httpTimeoutSeconds: parsePositiveNumber(
      overrides.httpTimeoutSeconds ??
        process.env.SURGE_SHIM_HTTP_TIMEOUT_SECONDS ??
        process.env.SURGE_CLI_HTTP_TIMEOUT_SECONDS,
      DEFAULTS.httpTimeoutSeconds,
    ),
    httpApiBaseUrl: String(
      overrides.httpApiBaseUrl ??
        process.env.SURGE_SHIM_HTTP_API_BASE_URL ??
        process.env.SURGE_CLI_HTTP_API_BASE_URL ??
        "",
    ).trim(),
    httpApiKey: String(
      overrides.httpApiKey ??
        process.env.SURGE_SHIM_HTTP_API_KEY ??
        process.env.SURGE_CLI_HTTP_API_KEY ??
        "",
    ).trim(),
    httpApiTimeoutSeconds: parsePositiveNumber(
      overrides.httpApiTimeoutSeconds ??
        process.env.SURGE_SHIM_HTTP_API_TIMEOUT_SECONDS ??
        process.env.SURGE_CLI_HTTP_API_TIMEOUT_SECONDS,
      DEFAULTS.httpApiTimeoutSeconds,
    ),

    printDone: parseBoolean(
      overrides.printDone ??
        process.env.SURGE_SHIM_PRINT_DONE ??
        process.env.SURGE_CLI_PRINT_DONE,
      DEFAULTS.printDone,
    ),
    exitOnDone: parseBoolean(
      overrides.exitOnDone ??
        process.env.SURGE_SHIM_EXIT_ON_DONE ??
        process.env.SURGE_CLI_EXIT_ON_DONE,
      DEFAULTS.exitOnDone,
    ),
    warnUnsupported: parseBoolean(
      overrides.warnUnsupported ??
        process.env.SURGE_SHIM_WARN_UNSUPPORTED ??
        process.env.SURGE_CLI_WARN_UNSUPPORTED,
      DEFAULTS.warnUnsupported,
    ),

    waitForDoneMs: parseOptionalNumber(
      overrides.waitForDoneMs ??
        process.env.SURGE_SHIM_WAIT_FOR_DONE_MS ??
        process.env.SURGE_CLI_WAIT_FOR_DONE_MS,
      DEFAULTS.waitForDoneMs,
    ),

    autoInstallWhenRequired: parseBoolean(
      overrides.autoInstallWhenRequired ??
        process.env.SURGE_SHIM_AUTO_INSTALL ??
        process.env.SURGE_CLI_AUTO_INSTALL,
      DEFAULTS.autoInstallWhenRequired,
    ),

    selectGroupDetails: Array.isArray(selectGroupDetails)
      ? selectGroupDetails
      : [],
  };
}

function createRuntime(config) {
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const scriptStoreKey =
    config.scriptPath || config.scriptName || "__default_script__";
  const persistentStore = new PersistentStoreBackend(
    config.storeFile,
    scriptStoreKey,
  );

  const runtime = {
    config,
    warnedUnsupported: new Set(),
    cookieJar: new CookieJar(),
    insecureAgent: null,

    doneCalled: false,
    doneResult: undefined,
    donePromise,
    resolveDone,

    geoipMap: config.geoipMap,
    ipasnMap: config.ipasnMap,
    ipasoMap: config.ipasoMap,

    persistentStore,

    surgeState: {
      selectedPolicies: {},
      selectGroupDetails: cloneValue(config.selectGroupDetails),
      outboundMode: "rule",
      scriptResult: null,
      dnsResult: null,
    },
  };

  runtime.waitForDone = function waitForDone(timeoutMs) {
    if (runtime.doneCalled) {
      return Promise.resolve(runtime.doneResult);
    }

    const timeout = parseOptionalNumber(timeoutMs, config.waitForDoneMs);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return runtime.donePromise;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error(
            `$done was not called within ${timeout} ms. You can adjust --wait-for-done-ms.`,
          ),
        );
      }, timeout);

      runtime.donePromise.then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  };

  return runtime;
}

function installGlobals(runtime) {
  const { config } = runtime;
  const context = buildScriptContext(config);

  setGlobalIfNeeded(
    "$script",
    {
      name: config.scriptName,
      type: config.scriptType,
      path: config.scriptPath,
      startTime: config.scriptStartTime,
    },
    config.force,
  );

  setGlobalIfNeeded(
    "$environment",
    cloneValue(config.environment),
    config.force,
  );
  setGlobalIfNeeded("$network", cloneValue(config.network), config.force);

  if (typeof context.argument !== "undefined") {
    setGlobalIfNeeded("$argument", context.argument, config.force);
  } else if (config.force && typeof globalThis.$argument !== "undefined") {
    delete globalThis.$argument;
  }

  setGlobalIfNeeded(
    "$persistentStore",
    {
      read(key) {
        return runtime.persistentStore.read(key);
      },
      write(data, key) {
        return runtime.persistentStore.write(data, key);
      },
    },
    config.force,
  );

  setGlobalIfNeeded("$notification", createNotificationApi(), config.force);
  setGlobalIfNeeded("$utils", createUtilsApi(runtime), config.force);
  setGlobalIfNeeded("$httpClient", makeHttpClient(runtime), config.force);
  setGlobalIfNeeded("$httpAPI", createHttpApiFunction(runtime), config.force);
  setGlobalIfNeeded("$surge", createSurgeControlApi(runtime), config.force);
  setGlobalIfNeeded("$done", createDoneFunction(runtime), config.force);

  if (typeof context.intent !== "undefined") {
    setGlobalIfNeeded("$intent", context.intent, config.force);
  } else if (config.force && typeof globalThis.$intent !== "undefined") {
    delete globalThis.$intent;
  }

  if (typeof context.request !== "undefined") {
    setGlobalIfNeeded("$request", context.request, config.force);
  } else if (config.force && typeof globalThis.$request !== "undefined") {
    delete globalThis.$request;
  }

  if (typeof context.response !== "undefined") {
    setGlobalIfNeeded("$response", context.response, config.force);
  } else if (config.force && typeof globalThis.$response !== "undefined") {
    delete globalThis.$response;
  }

  if (typeof context.domain !== "undefined") {
    setGlobalIfNeeded("$domain", String(context.domain), config.force);
  } else if (config.force && typeof globalThis.$domain !== "undefined") {
    delete globalThis.$domain;
  }

  if (typeof context.cronexp !== "undefined") {
    setGlobalIfNeeded("$cronexp", String(context.cronexp), config.force);
  } else if (config.force && typeof globalThis.$cronexp !== "undefined") {
    delete globalThis.$cronexp;
  }

  if (typeof context.event !== "undefined") {
    setGlobalIfNeeded("$event", context.event, config.force);
  } else if (config.force && typeof globalThis.$event !== "undefined") {
    delete globalThis.$event;
  }
}

function installSurgeCompat(rawOptions = {}) {
  const existing = globalThis[RUNTIME_SYMBOL];
  const force = parseBoolean(rawOptions.force, false);
  if (existing && !force) {
    return existing;
  }

  const config = buildConfig(rawOptions);
  const runtime = createRuntime(config);
  installGlobals(runtime);
  globalThis[RUNTIME_SYMBOL] = runtime;
  return runtime;
}

async function requireOrImportScript(scriptPath) {
  try {
    require(scriptPath);
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ERR_REQUIRE_ESM") {
      throw error;
    }
  }

  await import(pathToFileURL(scriptPath).href);
}

async function runScriptWithCompat(scriptPath, rawOptions = {}) {
  const absoluteScriptPath = resolveScriptPath(scriptPath);
  if (!absoluteScriptPath) {
    throw new Error("script path is required.");
  }
  if (!fs.existsSync(absoluteScriptPath)) {
    throw new Error(`script does not exist: ${absoluteScriptPath}`);
  }

  const runtime = installSurgeCompat({
    ...rawOptions,
    scriptPath: absoluteScriptPath,
    scriptName: rawOptions.scriptName || inferScriptName(absoluteScriptPath),
    exitOnDone: false,
    force: true,
  });

  await requireOrImportScript(absoluteScriptPath);
  await runtime.waitForDone(rawOptions.waitForDoneMs);
  return runtime.doneResult;
}

function parseCliJson(value, label) {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.startsWith("@")) {
    const filePath = path.resolve(value.slice(1));
    const text = fs.readFileSync(filePath, "utf8");
    return parseJsonText(text, `${label} (${filePath})`);
  }
  return parseJsonText(value, label);
}

function parseCliArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      const rawKey = eqIndex >= 0 ? token.slice(2, eqIndex) : token.slice(2);
      const hasInlineValue = eqIndex >= 0;
      const next = argv[i + 1];
      const hasNextValue = typeof next === "string" && !next.startsWith("-");
      const value = hasInlineValue
        ? token.slice(eqIndex + 1)
        : hasNextValue
          ? next
          : true;
      flags[rawKey] = value;
      if (!hasInlineValue && hasNextValue) {
        i += 1;
      }
      continue;
    }

    if (token.startsWith("-") && token.length === 2) {
      const shortKey = token.slice(1);
      const next = argv[i + 1];
      const hasNextValue = typeof next === "string" && !next.startsWith("-");
      const value = hasNextValue ? next : true;
      flags[shortKey] = value;
      if (hasNextValue) {
        i += 1;
      }
      continue;
    }

    positional.push(token);
  }

  return { flags, positional };
}

function printHelp() {
  const message = `
${SHIM_NAME} - Surge script Node.js compatibility layer

Usage
  node -r ./surge_cli_compat.js ./script.js
  node ./surge_cli_compat.js --script ./script.js [options]
  node ./surge_cli_compat.js ./script.js [options]

Core options
  --script <path>               Target script path
  --type <type>                 generic|http-request|http-response|rule|dns|event|cron
  --argument <text>             Value for $argument
  --wait-for-done-ms <ms>       Max wait for $done in runner mode (default: 30000)
  --print-done <bool>           Print $done payload (default: true)
  --warn-unsupported <bool>     Warn on unsupported behaviors (default: true)

Context options
  --request-json <json|@file>   Value for $request
  --response-json <json|@file>  Value for $response
  --event-json <json|@file>     Value for $event
  --event-name <name>           Event name fallback
  --event-data <text>           Event data fallback
  --domain <domain>             Value for $domain (dns scripts)
  --cronexp <expr>              Value for $cronexp (cron scripts)
  --intent-json <json|@file>    Value for $intent
  --intent-parameter <text>     Value for $intent.parameter fallback

Runtime options
  --store-file <path>           Persistent store file
  --http-timeout-seconds <sec>  Default $httpClient timeout
  --http-api-base-url <url>     Base URL for $httpAPI bridge
  --http-api-key <key>          X-Key for $httpAPI bridge
  --network-json <json|@file>   Override $network object
  --environment-json <json|@file> Override $environment object
  --help                        Show this help
`;
  console.log(message.trim());
}

function buildRunOptionsFromCli(flags) {
  const scriptPath = flags.script || flags.s;
  const options = {
    scriptPath,
    scriptType: flags.type,
    argument: typeof flags.argument === "string" ? flags.argument : undefined,
    printDone: parseBoolean(flags["print-done"], DEFAULTS.printDone),
    warnUnsupported: parseBoolean(
      flags["warn-unsupported"],
      DEFAULTS.warnUnsupported,
    ),
    waitForDoneMs: parseOptionalNumber(
      flags["wait-for-done-ms"],
      DEFAULTS.waitForDoneMs,
    ),
    storeFile: flags["store-file"],
    httpTimeoutSeconds: parsePositiveNumber(
      flags["http-timeout-seconds"],
      DEFAULTS.httpTimeoutSeconds,
    ),
    httpApiBaseUrl: flags["http-api-base-url"],
    httpApiKey: flags["http-api-key"],
    eventName: flags["event-name"],
    eventData: flags["event-data"],
    domain: flags.domain,
    cronexp: flags.cronexp,
    intentParameter: flags["intent-parameter"],
  };

  if (typeof flags["request-json"] === "string") {
    options.request = parseCliJson(flags["request-json"], "--request-json");
  }
  if (typeof flags["response-json"] === "string") {
    options.response = parseCliJson(flags["response-json"], "--response-json");
  }
  if (typeof flags["event-json"] === "string") {
    options.event = parseCliJson(flags["event-json"], "--event-json");
  }
  if (typeof flags["intent-json"] === "string") {
    options.intent = parseCliJson(flags["intent-json"], "--intent-json");
  }
  if (typeof flags["network-json"] === "string") {
    options.network = parseCliJson(flags["network-json"], "--network-json");
  }
  if (typeof flags["environment-json"] === "string") {
    options.environment = parseCliJson(
      flags["environment-json"],
      "--environment-json",
    );
  }
  return options;
}

async function runCli(argv) {
  const { flags, positional } = parseCliArgs(argv);
  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  const runOptions = buildRunOptionsFromCli(flags);
  const scriptPath = runOptions.scriptPath || positional[0];
  if (!scriptPath) {
    printHelp();
    throw new Error("Missing script path.");
  }

  await runScriptWithCompat(scriptPath, runOptions);
}

module.exports = {
  installSurgeCompat,
  runScriptWithCompat,
};

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then(() => {
      // Keep success quiet; script output already includes details.
    })
    .catch((error) => {
      warn(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
} else {
  const runtime = buildConfig();
  if (runtime.autoInstallWhenRequired) {
    installSurgeCompat();
  } else {
    info("Auto install disabled by SURGE_SHIM_AUTO_INSTALL=0.");
  }
}
