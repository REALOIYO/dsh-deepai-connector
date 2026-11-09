var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// src/adapter/sse.ts
var sse_exports = {};
__export(sse_exports, {
  SSE_DONE: () => SSE_DONE,
  chatChunkDelta: () => chatChunkDelta,
  chatChunkUsage: () => chatChunkUsage,
  forEachSseFrame: () => forEachSseFrame
});
async function forEachSseFrame(body, fn, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => {
    });
  };
  if (signal !== void 0) {
    if (signal.aborted) {
      onAbort();
      throw new Error("\u8BF7\u6C42\u5DF2\u4E2D\u65AD");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for (; ; ) {
      if (signal?.aborted === true) throw new Error("\u8BF7\u6C42\u5DF2\u4E2D\u65AD");
      const { done, value } = await reader.read();
      if (signal?.aborted === true) throw new Error("\u8BF7\u6C42\u5DF2\u4E2D\u65AD");
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (; ; ) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!await dispatchLine(line, fn)) return;
      }
    }
    if (buffer !== "") await dispatchLine(buffer, fn);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
    }
  }
}
async function dispatchLine(line, fn) {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (trimmed.startsWith(":")) return fn({ comment: trimmed });
  if (trimmed.startsWith("event:")) {
    return fn({ event: trimmed.slice("event:".length).trim() });
  }
  if (!trimmed.startsWith("data:")) return true;
  const data = trimmed.slice("data:".length).trim();
  if (data === "") return true;
  if (data === SSE_DONE) {
    await fn({ data: SSE_DONE });
    return false;
  }
  let object;
  try {
    const parsed = JSON.parse(data);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      object = parsed;
    }
  } catch {
  }
  return fn({ data, ...object !== void 0 ? { object } : {} });
}
function intOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
function strOf(value) {
  return typeof value === "string" ? value : "";
}
function chatChunkDelta(chunk) {
  const empty = { reasoning: "", content: "", toolCalls: [] };
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { delta: empty, finish: "" };
  const choice = choices[0];
  if (choice === null || typeof choice !== "object") return { delta: empty, finish: "" };
  const cm = choice;
  const finish = strOf(cm.finish_reason);
  const rawDelta = cm.delta;
  if (rawDelta === null || typeof rawDelta !== "object") return { delta: empty, finish };
  const delta = rawDelta;
  const out = {
    reasoning: strOf(delta.reasoning) || strOf(delta.reasoning_content),
    content: strOf(delta.content),
    toolCalls: []
  };
  const toolCalls = delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) {
      if (item === null || typeof item !== "object") continue;
      const tc = item;
      const fn = tc.function;
      const fnObj = fn !== null && typeof fn === "object" ? fn : void 0;
      out.toolCalls.push({
        index: intOf(tc.index),
        id: strOf(tc.id),
        name: strOf(fnObj?.name),
        args: strOf(fnObj?.arguments)
      });
    }
  }
  return { delta: out, finish };
}
function floatOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
function chatChunkUsage(chunk) {
  const usage = chunk.usage;
  if (usage === null || typeof usage !== "object") return void 0;
  const u = usage;
  let input = intOf(u.prompt_tokens);
  let output = intOf(u.completion_tokens);
  if (input === 0) input = intOf(u.input_tokens);
  if (output === 0) output = intOf(u.output_tokens);
  const total = intOf(u.total_tokens) || input + output;
  if (input === 0 && output === 0 && total === 0) return void 0;
  const result = { inputTokens: input, outputTokens: output };
  if (total > 0) result.totalTokens = total;
  const promptDetails = u.prompt_tokens_details;
  if (promptDetails !== null && typeof promptDetails === "object") {
    const cached = intOf(promptDetails.cached_tokens);
    if (cached > 0) result.cacheReadTokens = cached;
  }
  const completionDetails = u.completion_tokens_details;
  if (completionDetails !== null && typeof completionDetails === "object") {
    const reasoning = intOf(completionDetails.reasoning_tokens);
    if (reasoning > 0) result.reasoningTokens = reasoning;
  }
  if (result.reasoningTokens === void 0) {
    const outputDetails = u.output_tokens_details;
    if (outputDetails !== null && typeof outputDetails === "object") {
      const reasoning = intOf(outputDetails.reasoning_tokens);
      if (reasoning > 0) result.reasoningTokens = reasoning;
    }
  }
  let cost = floatOf(u.cost);
  if (cost === 0) {
    const costDetails = u.cost_details;
    if (costDetails !== null && typeof costDetails === "object") {
      cost = floatOf(costDetails.upstream_inference_cost);
    }
  }
  if (cost > 0) result.cost = cost;
  return result;
}
var SSE_DONE;
var init_sse = __esm({
  "src/adapter/sse.ts"() {
    "use strict";
    SSE_DONE = "[DONE]";
  }
});

// src/adapter/auth.ts
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// src/adapter/protocol.ts
var ORIGIN = "https://api.deepai.org";
function origin(env = process.env) {
  const override = (env.DEEPAI_API_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (override !== "") {
    try {
      const parsed = new URL(override);
      if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host !== "") return override;
    } catch {
    }
  }
  return ORIGIN;
}
var MODEL_BASE = "/deepai_code";
var LANE_CANDIDATES = Object.freeze([
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "3",
  "2"
]);
var LANE_VERSION = "4";
var APP_VERSION = "0.3.20";
var HEADER_KEY = "Api-Key";
var HEADER_LANE = "X-DeepAI-Code-Theos";
var HEADER_MACHINE = "X-DeepAI-Code-Machine";
var HEADER_INSTANCE = "X-DeepAI-Code-Instance";
var HEADER_CHECK_IN = "X-DeepAI-Code-Check-In";
var HEADER_BEACON = "X-DeepAI-Code-Beacon";
var HEADER_AFFINITY = "X-Session-Affinity";
var PATH_MODELS = "/models";
var PATH_CHAT = "/chat/completions";
var PATH_THEOS = "/theos";
var PATH_SIGN_IN = "/desktop_auth/";
var PATH_EXCHANGE = "/desktop_auth/exchange/";
var CODE_SESSION_BUSY = "session_busy";
var CODE_LANE_UNSUPPORTED = "lane_version_unsupported";
var CODE_SOCIAL_LOGIN = "social_login_required";
var CODE_MACHINE_REQUIRED = "machine_required";
var CODE_EMAIL_UNVERIFIED = "email_unverified";
var CODE_AUTH_REQUIRED = "auth_required";
var CODE_INVALID_API_KEY = "invalid_api_key";
var CODE_CHECK_IN_REFUSED = "check_in_refused";
var CODE_NETWORK_BOUND = "network_bound";
var DESKTOP_INFERENCE_HEADERS = Object.freeze({
  "User-Agent": "node",
  Accept: "*/*",
  "Accept-Language": "*",
  "Sec-Fetch-Mode": "cors"
});
function modelUrl(path, env = process.env) {
  return `${origin(env)}${MODEL_BASE}${path}`;
}
function isResponsesApi(api) {
  return api === "openai-responses";
}

// src/adapter/auth.ts
var LOGIN_TTL_MS = 10 * 60 * 1e3;
var AccountStore = class {
  #path;
  #account;
  #loaded = false;
  constructor(dataDir) {
    this.#path = join(dataDir, "account.json");
  }
  get path() {
    return this.#path;
  }
  /** 读盘。首次运行没有文件是正常情况。 */
  async load() {
    if (this.#loaded) return;
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.apiKey === "string" && parsed.apiKey.trim() !== "") {
        this.#account = {
          apiKey: parsed.apiKey.trim(),
          username: typeof parsed.username === "string" ? parsed.username : "",
          isPro: parsed.isPro === true,
          obtainedAt: typeof parsed.obtainedAt === "string" ? parsed.obtainedAt : ""
        };
      }
    } catch {
    }
    this.#loaded = true;
  }
  /** 同步取当前账号；调用方须先 `load()`。 */
  get() {
    return this.#account;
  }
  /** 写入并落盘。 */
  async save(account) {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(account, null, 2)}
`, { encoding: "utf8", mode: 384 });
    await rename(tmp, this.#path);
    await chmod(this.#path, 384).catch(() => {
    });
    this.#account = account;
    this.#loaded = true;
  }
  /** 登出：删掉内存与磁盘上的凭据。 */
  async clear() {
    this.#account = void 0;
    this.#loaded = true;
    const { rm } = await import("node:fs/promises");
    await rm(this.#path, { force: true }).catch(() => {
    });
  }
};
async function exchangeCode(code, signal) {
  const response = await fetch(modelUrl(PATH_EXCHANGE), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "node",
      Accept: "*/*",
      "Accept-Language": "*",
      "Sec-Fetch-Mode": "cors"
    },
    body: JSON.stringify({ code }),
    ...signal !== void 0 ? { signal } : {}
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`\u6362\u53D6\u6388\u6743\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\uFF1A${text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`\u6362\u53D6\u6388\u6743\u7684\u54CD\u5E94\u4E0D\u662F JSON\uFF1A${text.slice(0, 200)}`);
  }
  const apiKey = typeof payload.api_key === "string" ? payload.api_key : typeof payload.key === "string" ? payload.key : "";
  if (apiKey.trim() === "") throw new Error("\u6362\u53D6\u6388\u6743\u6210\u529F\u4F46\u54CD\u5E94\u91CC\u6CA1\u6709 API Key");
  return {
    apiKey: apiKey.trim(),
    username: typeof payload.username === "string" ? payload.username : "",
    isPro: payload.is_pro === true,
    obtainedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function shutdown(server) {
  if (server === void 0) return;
  try {
    server.close();
  } catch {
  }
}
function startSignIn(env = process.env) {
  const state = randomBytes(32).toString("hex");
  let server;
  let settle = () => {
  };
  let fail = () => {
  };
  let finished = false;
  let timer;
  const done = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  done.catch(() => {
  });
  const finish = (fn) => {
    if (finished) return;
    finished = true;
    if (timer !== void 0) clearTimeout(timer);
    shutdown(server);
    fn();
  };
  const origin2 = (env.DEEPAI_API_ORIGIN ?? ORIGIN).trim().replace(/\/+$/, "");
  const signInUrl = `${origin2}${MODEL_BASE}${PATH_SIGN_IN}`;
  const pending = new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth-callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const gotState = url.searchParams.get("state") ?? "";
      if (req.method !== "GET" || code === "" || code.length > 4096 || !safeEqual(gotState, state)) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid sign-in callback.");
        return;
      }
      void exchangeCode(code).then((account) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end("<h2>\u5DF2\u6388\u6743 DeepAI Code</h2><p>\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\uFF0C\u56DE\u5230 DSH \u8BBE\u7F6E\u9875\u3002</p>");
        finish(() => settle(account));
      }).catch((error) => {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("Sign-in failed. Return to the console and try again.");
        finish(() => fail(error instanceof Error ? error : new Error(String(error))));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("\u65E0\u6CD5\u53D6\u5F97\u56DE\u8C03\u7AEF\u53E3"));
    });
  });
  timer = setTimeout(() => {
    finish(() => fail(new Error("\u6388\u6743\u8D85\u65F6\uFF0810 \u5206\u949F\uFF09\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77")));
  }, LOGIN_TTL_MS);
  timer.unref?.();
  return {
    ready: () => pending.then((port) => {
      const target = new URL(signInUrl);
      target.searchParams.set("state", state);
      target.searchParams.set("port", String(port));
      return target.toString();
    }),
    wait: () => done,
    cancel: () => finish(() => fail(new Error("\u6388\u6743\u5DF2\u53D6\u6D88")))
  };
}
function defaultDataDir() {
  return join(homedir(), ".dsh-deepai-connect");
}

// src/adapter/client.ts
import { randomBytes as randomBytes2 } from "node:crypto";

// src/adapter/body.ts
var DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant. Answer the user's request directly.";
var DESKTOP_CHAT_KEYS = /* @__PURE__ */ new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "stream",
  "stream_options",
  "store",
  "seed",
  "service_tier",
  "reasoning_effort",
  "prompt_cache_key"
]);
function blocksOf(content) {
  return Array.isArray(content) ? content.filter((b) => b !== null && typeof b === "object") : [];
}
function flattenText(message) {
  return blocksOf(message.content).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("");
}
function parseArguments(raw) {
  if (raw !== null && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
    }
  }
  return {};
}
function messageToolCallId(message) {
  if (typeof message.toolCallId === "string" && message.toolCallId !== "") return message.toolCallId;
  if (typeof message.tool_call_id === "string" && message.tool_call_id !== "") return message.tool_call_id;
  const source = message.source;
  if (source?.kind === "tool" && typeof source.callId === "string" && source.callId !== "") return source.callId;
  return void 0;
}
function toOpenAIMessages(messages) {
  const out = [];
  const toolNames = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.role === "assistant") {
      const content = [];
      const toolCalls = [];
      let reasoning = "";
      for (const block of blocksOf(message.content)) {
        switch (block.type) {
          case "text":
            if (typeof block.text === "string") content.push(block.text);
            break;
          case "reasoning":
            if (typeof block.text === "string") reasoning += block.text;
            break;
          case "tool-call": {
            const id = typeof block.id === "string" ? block.id : "";
            const name2 = typeof block.name === "string" ? block.name : "";
            if (id === "" || name2 === "") break;
            toolNames.set(id, name2);
            toolCalls.push({
              id,
              type: "function",
              function: { name: name2, arguments: JSON.stringify(parseArguments(block.arguments)) }
            });
            break;
          }
          default:
            break;
        }
      }
      for (const call of message.tool_calls ?? []) {
        const id = typeof call.id === "string" ? call.id : "";
        const name2 = typeof call.function?.name === "string" ? call.function.name : "";
        if (id === "" || name2 === "") continue;
        toolNames.set(id, name2);
        toolCalls.push({
          id,
          type: "function",
          function: { name: name2, arguments: JSON.stringify(parseArguments(call.function?.arguments)) }
        });
      }
      const assistant = { role: "assistant" };
      const text = content.join("");
      assistant.content = text !== "" ? text : toolCalls.length > 0 ? null : "";
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      if (reasoning !== "") assistant.reasoning_content = reasoning;
      out.push(assistant);
      continue;
    }
    const toolCallId = messageToolCallId(message);
    if (toolCallId !== void 0) {
      const text = flattenText(message);
      out.push({
        role: "tool",
        tool_call_id: toolCallId,
        // 空输出要补占位：上游不要空 content
        content: text !== "" ? text : "(no output)",
        ...message.isError === true ? { is_error: true } : {}
      });
      continue;
    }
    const inlineResults = blocksOf(message.content).filter((b) => b.type === "tool-result");
    if (inlineResults.length > 0) {
      for (const result of inlineResults) {
        const id = typeof result.toolCallId === "string" ? result.toolCallId : "";
        if (id === "") continue;
        const text = blocksOf(result.content).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("");
        out.push({
          role: "tool",
          tool_call_id: id,
          content: text !== "" ? text : "(no output)",
          ...result.isError === true ? { is_error: true } : {}
        });
      }
      continue;
    }
    const parts = [];
    for (const block of blocksOf(message.content)) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        parts.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
      }
    }
    const role = message.role === "system" ? "system" : message.role === "developer" ? "developer" : "user";
    if (parts.length === 0) {
      out.push({ role, content: "" });
    } else if (parts.length === 1 && parts[0].type === "text") {
      out.push({ role, content: parts[0].text });
    } else {
      out.push({ role, content: parts });
    }
  }
  return out;
}
function hasSystemMessage(messages) {
  return messages.some((message) => message.role === "system" || message.role === "developer");
}
function buildChatBody(options, model, systemPrompt) {
  const messages = toOpenAIMessages(options.messages);
  const prompt = systemPrompt !== void 0 && systemPrompt !== "" ? systemPrompt : options.system;
  if (!hasSystemMessage(messages)) {
    messages.unshift({
      role: "system",
      content: prompt !== void 0 && prompt !== "" ? prompt : DEFAULT_SYSTEM_PROMPT
    });
  }
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // 桌面端每个 chat 请求都带这个（supportsStore=true）
    store: false
  };
  if (options.tools !== void 0 && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} }
      }
    }));
    body.parallel_tool_calls = true;
  }
  if (options.maxTokens !== void 0) body.max_completion_tokens = options.maxTokens;
  if (options.temperature !== void 0) body.temperature = options.temperature;
  const effort = options.reasoningEffort ?? options.reasoning;
  if (effort !== void 0 && effort !== "") {
    body.reasoning_effort = effort === "off" ? "none" : effort;
  } else if (options.reasoningEffort === "none") {
    body.reasoning_effort = "none";
  }
  return body;
}
function chatBodyFallback(body, systemPrompt) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return void 0;
  const strict = {};
  for (const [key, value] of Object.entries(body)) {
    if (DESKTOP_CHAT_KEYS.has(key)) strict[key] = value;
  }
  const typed = messages.filter((m) => m !== null && typeof m === "object");
  if (!hasSystemMessage(typed)) {
    strict.messages = [
      { role: "system", content: systemPrompt !== void 0 && systemPrompt !== "" ? systemPrompt : DEFAULT_SYSTEM_PROMPT },
      ...messages
    ];
  }
  return strict;
}

// src/adapter/client.ts
var CHECK_IN_MIN_INTERVAL_MS = 3e4;
var CHECK_IN_TIMEOUT_MS = 1e4;
var CHECK_IN_REFUSED_LOCK_MS = 6 * 60 * 60 * 1e3;
var NON_STREAM_BUDGET_MS = 9e4;
function isValidCheckIn(value) {
  if (value === void 0) return false;
  if (!Number.isFinite(value.seconds) || value.seconds <= 0) return false;
  if (!/^[0-9a-f]{32}$/.test(value.nonce)) return false;
  return true;
}
var UpstreamError = class extends Error {
  status;
  code;
  body;
  /** 上游 `Retry-After`，秒。 */
  retryAfter;
  constructor(status, code, message, body = "", retryAfter) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.body = body;
    if (retryAfter !== void 0) this.retryAfter = retryAfter;
  }
  /** 账号级策略拦截：换号、重试都无解。 */
  get socialLoginRequired() {
    return this.code === CODE_SOCIAL_LOGIN;
  }
  /** 缺机器指纹。 */
  get machineRequired() {
    return this.code === CODE_MACHINE_REQUIRED;
  }
  /**
   * 账号鉴权失败（401，或 401 语义的错误码）。
   *
   * 与普通 403 不同：登录态本身无效，换不换号都一样，应提示重新授权。
   */
  get authFailed() {
    if (this.status === 401) return true;
    return this.code === CODE_AUTH_REQUIRED || this.code === CODE_INVALID_API_KEY || this.code === CODE_EMAIL_UNVERIFIED;
  }
  /**
   * 邮箱未验证。
   *
   * 上游因邮箱未验证拒绝时，登录态无效；标记后应跳过，而不是当可重试失败
   * 反复打。
   */
  get emailUnverified() {
    return this.code === CODE_EMAIL_UNVERIFIED;
  }
  /** 车道版本不被接受。 */
  get laneUnsupported() {
    return this.status === 426 || this.code === CODE_LANE_UNSUPPORTED;
  }
  /** 会话忙：等 `Retry-After` 再试。 */
  get capacityWaiting() {
    return this.status === 409 && this.code === CODE_SESSION_BUSY;
  }
  /** 当天签到次数用尽。 */
  get checkInRefused() {
    return this.code === CODE_CHECK_IN_REFUSED;
  }
  /** 网络级免费额度领完。 */
  get networkBound() {
    return this.code === CODE_NETWORK_BOUND;
  }
  /**
   * 请求体形状被拒。
   *
   * 上游对新车道加了请求体校验，典型响应是 400 + `invalid_request_error`，
   * message 固定为 `This request is not one DeepAI Code sends.`。
   * 命中后按桌面端字段白名单重排一次，这是唯一值得纠正的 400。
   */
  get bodyRejected() {
    if (this.status !== 400) return false;
    return this.body.toLowerCase().includes("not one deepai code sends");
  }
  /** 该不该重试。策略类错误码是终态，换谁问都一样。 */
  get retryable() {
    if (this.socialLoginRequired || this.machineRequired || this.laneUnsupported) return false;
    if (this.status === 400 || this.status === 404 || this.status === 422) return false;
    return [401, 403, 409, 429, 500, 502, 503, 504].includes(this.status) || this.status >= 500;
  }
};
function errorCodeOf(body) {
  try {
    const parsed = JSON.parse(body);
    const code = parsed.error?.code ?? parsed.code;
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}
function errorMessageOf(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
  }
  return body.trim().slice(0, 200);
}
function retryAfterSeconds(header, fallback = 3) {
  if (header === null || header.trim() === "") return fallback;
  const parsed = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(30, Math.max(1, parsed));
}
var AFFINITY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
function affinityFor(body) {
  const raw = body.prompt_cache_key;
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  return AFFINITY_PATTERN.test(value) ? value : "";
}
var DeepAIClient = class {
  #instance;
  #startedAt = Date.now();
  #machine;
  #apiKey = "";
  #lane;
  #checkIns = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.#instance = randomBytes2(16).toString("hex");
    this.#machine = options.machine ?? "";
    this.#lane = options.lane ?? LANE_VERSION;
  }
  /** 当前车道版本。 */
  get lane() {
    return this.#lane;
  }
  /** 进程级实例号。桌面端每进程生成一次，随所有 JSON 请求发出。 */
  get instanceId() {
    return this.#instance;
  }
  /** 当前机器指纹（空串表示没探到）。 */
  get machine() {
    return this.#machine;
  }
  /** 补设机器指纹（异步探到后调用）。 */
  setMachine(fingerprint) {
    this.#machine = fingerprint.trim();
  }
  /** 设置当前账号的 API Key。 */
  setApiKey(key) {
    this.#apiKey = key.trim();
  }
  /** 是否已有 Key。 */
  get hasKey() {
    return this.#apiKey !== "";
  }
  /** 取（必要时创建）某个 Key 的签到状态。 */
  #state(key) {
    let state = this.#checkIns.get(key);
    if (state === void 0) {
      state = { challenge: void 0, notedAt: 0, attemptedAt: 0, ackedNonce: "", refusedUntil: 0, lastRelay: 0 };
      this.#checkIns.set(key, state);
    }
    return state;
  }
  /**
   * 组装公共请求头。
   *
   * `DESKTOP_INFERENCE_HEADERS` 必须原样发出：这几行是上游区分真假客户端的
   * 主要判据。不要「顺手加上更完整的头」——带 `sec-ch-ua` 或 Chrome UA
   * 反而会被识别成非客户端。
   */
  #commonHeaders() {
    const headers = {
      ...DESKTOP_INFERENCE_HEADERS,
      "Content-Type": "application/json",
      [HEADER_LANE]: this.#lane,
      [HEADER_INSTANCE]: this.#instance
    };
    if (this.#machine !== "") headers[HEADER_MACHINE] = this.#machine;
    if (this.#apiKey !== "") headers[HEADER_KEY] = this.#apiKey;
    return headers;
  }
  /** 把非 2xx 响应转成 {@link UpstreamError}。 */
  async #toError(response, op) {
    const body = await response.text().catch(() => "");
    const code = errorCodeOf(body);
    const message = errorMessageOf(body);
    return new UpstreamError(
      response.status,
      code,
      `${op}\u5931\u8D25\uFF08HTTP ${response.status}\uFF09${message !== "" ? `\uFF1A${message}` : ""}`,
      body,
      retryAfterSeconds(response.headers.get("retry-after"))
    );
  }
  /**
   * 拉模型目录。
   *
   * `/models` 免鉴权，因此也是探测车道最便宜的方式。
   */
  async listModels(signal) {
    const response = await fetch(modelUrl(PATH_MODELS), {
      method: "GET",
      headers: this.#commonHeaders(),
      ...signal !== void 0 ? { signal } : {},
      // 无效 Key 会 302 到登录页，跟随只会把鉴权失败伪装成 200。
      redirect: "manual"
    });
    if (!response.ok) throw await this.#toError(response, "\u62C9\u53D6\u6A21\u578B\u76EE\u5F55");
    const payload = await response.json();
    const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    const out = [];
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const raw = item;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (id === "") continue;
      out.push({
        id,
        ...typeof raw.name === "string" ? { name: raw.name } : {},
        ...typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {},
        ...Array.isArray(raw.input) ? { input: raw.input.filter((v) => typeof v === "string") } : {},
        ...typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {},
        ...typeof raw.maxTokens === "number" ? { maxTokens: raw.maxTokens } : {},
        ...typeof raw.premier === "boolean" ? { premier: raw.premier } : {},
        ...typeof raw.api === "string" ? { api: raw.api } : {},
        ...typeof raw.theosPerRequest === "string" ? { theosPerRequest: raw.theosPerRequest } : {}
      });
    }
    return out;
  }
  /**
   * 探测可用车道版本。
   *
   * 上游每抬一次车道就把旧值一律回 426。按「新版优先、旧版兜底」试，
   * 命中即落盘，这样上游升级车道时插件不需要改代码。
   */
  async probeLane(signal) {
    const candidates = LANE_CANDIDATES;
    const previous = this.#lane;
    for (const lane of candidates) {
      this.#lane = lane;
      try {
        const response = await fetch(modelUrl(PATH_MODELS), {
          method: "GET",
          headers: this.#commonHeaders(),
          ...signal !== void 0 ? { signal } : {},
          redirect: "manual"
        });
        if (response.ok) return lane;
        if (response.status !== 426) {
          this.#lane = previous;
          return previous;
        }
      } catch {
        this.#lane = previous;
        return previous;
      }
    }
    this.#lane = LANE_VERSION;
    return LANE_VERSION;
  }
  /** 给 `/theos` 加签到头与心跳。 */
  #checkInHeaders(state) {
    const headers = {};
    const challenge = state.challenge;
    const ttl = challenge !== void 0 && challenge.seconds > 0 ? challenge.seconds : 600;
    if (challenge !== void 0 && challenge.nonce !== "") {
      headers[HEADER_CHECK_IN] = challenge.nonce;
    }
    const relayed = state.lastRelay > 0 && Date.now() - state.lastRelay < ttl * 1e3;
    const up = Math.max(0, Math.floor((Date.now() - this.#startedAt) / 1e3));
    headers[HEADER_BEACON] = `v=${APP_VERSION};up=${up};pi=${relayed ? 1 : 0}`;
    return headers;
  }
  /** 记一次推理转发时间，供心跳的 `pi` 字段使用。 */
  markRelay() {
    if (this.#apiKey === "") return;
    this.#state(this.#apiKey).lastRelay = Date.now();
  }
  /** 从响应体里取签到挑战。成功与 403 拒绝都会带。 */
  #captureChallenge(key, body) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    const raw = parsed.check_in;
    if (raw === null || typeof raw !== "object") return;
    const candidate = raw;
    const nonce = typeof candidate.nonce === "string" ? candidate.nonce.trim() : "";
    const seconds = typeof candidate.seconds === "number" ? candidate.seconds : 0;
    if (!isValidCheckIn({ nonce, seconds })) return;
    const state = this.#state(key);
    state.challenge = { nonce, seconds };
    state.notedAt = Date.now();
  }
  /** 查一次 `/theos`，同时完成签到回传。 */
  async theos(signal) {
    const key = this.#apiKey;
    const state = this.#state(key);
    const headers = { ...this.#commonHeaders(), ...this.#checkInHeaders(state) };
    const sentNonce = headers[HEADER_CHECK_IN] ?? "";
    const response = await fetch(modelUrl(PATH_THEOS), {
      method: "GET",
      headers,
      ...signal !== void 0 ? { signal } : {},
      redirect: "manual"
    });
    const body = await response.text().catch(() => "");
    if (sentNonce !== "") state.ackedNonce = sentNonce;
    state.attemptedAt = Date.now();
    this.#captureChallenge(key, body);
    if (!response.ok) {
      const error = new UpstreamError(
        response.status,
        errorCodeOf(body),
        `\u67E5\u8BE2 Theos \u5931\u8D25\uFF08HTTP ${response.status}\uFF09\uFF1A${errorMessageOf(body)}`,
        body,
        retryAfterSeconds(response.headers.get("retry-after"))
      );
      if (error.checkInRefused) state.refusedUntil = Date.now() + CHECK_IN_REFUSED_LOCK_MS;
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("Theos \u54CD\u5E94\u4E0D\u662F JSON");
    }
    const allowance = {
      ...typeof payload.balance === "number" ? { balance: payload.balance } : {},
      ...typeof payload.granted === "number" ? { granted: payload.granted } : {},
      ...typeof (payload.refresh_at ?? payload.refreshAt) === "string" ? { refreshAt: String(payload.refresh_at ?? payload.refreshAt) } : {}
    };
    if (state.challenge !== void 0) allowance.checkIn = state.challenge;
    return allowance;
  }
  /**
   * 推理前确保签到完成。
   *
   * 这是「请求被不被接受」的关键：实测只拉 nonce 不回传 = 0/14 对齐，
   * 完整签到 = 14/14。失败一律不阻塞推理 —— 签到只影响落到真分支还是替身。
   */
  async ensureCheckIn(signal) {
    if (this.#apiKey === "") return;
    const state = this.#state(this.#apiKey);
    const now = Date.now();
    if (state.refusedUntil > 0 && now < state.refusedUntil) return;
    const challenge = state.challenge;
    const hasChallenge = isValidCheckIn(challenge);
    const needAck = hasChallenge && challenge.nonce !== state.ackedNonce;
    if (hasChallenge && !needAck && now - state.notedAt < challenge.seconds * 1e3 / 2) return;
    if (state.attemptedAt > 0 && now - state.attemptedAt < CHECK_IN_MIN_INTERVAL_MS) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_IN_TIMEOUT_MS);
    try {
      await this.theos(signal ?? controller.signal);
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * 发一次 chat 请求，返回上游 SSE 流。
   *
   * 形状兜底照 `openModel`：仍先按正常字段发；只有命中
   * `400 This request is not one DeepAI Code sends.` 时，才按桌面端字段白名单
   * 重排一次并补齐 system 消息。
   *
   * `affinity` 是会话粘性标识（上游据此做调度粘性），取自 `prompt_cache_key`；
   * 格式必须落在 `^[A-Za-z0-9._:-]{1,256}$` 内，非法值不发该请求头。
   */
  async openChat(options, model, body, signal) {
    const affinity = affinityFor(body);
    const first = await this.#postChat(body, signal, affinity);
    if (first.ok) {
      return this.#toChatResult(first, signal);
    }
    const error = await this.#toError(first, "\u8BF7\u6C42 chat");
    if (error.bodyRejected) {
      const fallback = chatBodyFallback(body, options.system);
      if (fallback !== void 0) {
        const retry = await this.#postChat(fallback, signal, affinity);
        if (retry.ok) return this.#toChatResult(retry, signal);
        throw await this.#toError(retry, "\u5F62\u72B6\u56DE\u9000\u540E\u8BF7\u6C42 chat");
      }
    }
    throw error;
  }
  /** 发一次 POST，不解析响应体。 */
  async #postChat(body, signal, affinity) {
    const headers = this.#commonHeaders();
    if (affinity !== void 0 && affinity !== "") headers[HEADER_AFFINITY] = affinity;
    this.markRelay();
    return fetch(modelUrl(PATH_CHAT), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...signal !== void 0 ? { signal } : {},
      // 上游会 302 到登录页，跟随会把鉴权失败伪装成 200
      redirect: "manual"
    });
  }
  /** 把成功的响应转成 {@link ChatResult}。 */
  #toChatResult(response, signal) {
    if (response.body === null) throw new Error("\u4E0A\u6E38\u6CA1\u6709\u8FD4\u56DE\u54CD\u5E94\u4F53");
    return {
      body: response.body,
      status: response.status,
      abort: () => {
        try {
          void response.body?.cancel();
        } catch {
        }
        void signal;
      }
    };
  }
  /**
   * 非流式 chat 请求。
   *
   * 有些客户端（以及 DSH 的部分内部调用）要完整消息而不是流。
   * 这里也走 SSE 端点，把帧拼起来，因为上游在缺省 `stream` 时本来就返回 SSE。
   */
  async completeChat(options, model, body, signal) {
    const { forEachSseFrame: forEachSseFrame2, chatChunkDelta: chatChunkDelta2, chatChunkUsage: chatChunkUsage2 } = await Promise.resolve().then(() => (init_sse(), sse_exports));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NON_STREAM_BUDGET_MS);
    const merged = signal ?? controller.signal;
    try {
      const result = await this.openChat(options, model, { ...body, stream: true }, merged);
      let text = "";
      let reasoning = "";
      let finish = "";
      let usage;
      const toolCalls = /* @__PURE__ */ new Map();
      await forEachSseFrame2(result.body, (frame) => {
        if (frame.object === void 0) return true;
        const { delta, finish: f } = chatChunkDelta2(frame.object);
        if (f !== "") finish = f;
        text += delta.content;
        reasoning += delta.reasoning;
        for (const tc of delta.toolCalls) {
          let slot = toolCalls.get(tc.index);
          if (slot === void 0) {
            slot = { id: "", name: "", args: "" };
            toolCalls.set(tc.index, slot);
          }
          if (tc.id !== "") slot.id = tc.id;
          if (tc.name !== "") slot.name = tc.name;
          slot.args += tc.args;
        }
        const u = chatChunkUsage2(frame.object);
        if (u !== void 0) usage = u;
        return true;
      }, merged);
      return {
        text,
        reasoning,
        toolCalls: [...toolCalls.values()].map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args })),
        ...usage !== void 0 ? { usage } : {},
        finish
      };
    } finally {
      clearTimeout(timer);
    }
  }
};

// src/adapter/catalog.ts
var CATALOG_TTL_MS = 6 * 60 * 60 * 1e3;
var FALLBACK_MODELS = Object.freeze([
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, theosPerRequest: "0" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, theosPerRequest: "0" },
  { id: "mimo-2.6-flash", name: "MiMo 2.6 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, theosPerRequest: "0" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 128e3, theosPerRequest: "0" }
]);
var DEFAULT_CONTEXT_WINDOW = 131072;
var DEFAULT_MAX_TOKENS = 32768;
function acceptsImage(model) {
  return Array.isArray(model.input) && model.input.includes("image");
}
var ModelCatalog = class {
  #client;
  #models = [...FALLBACK_MODELS];
  #fetchedAt = 0;
  #inflight;
  constructor(client) {
    this.#client = client;
  }
  /** 当前模型列表（同步，给选择器用）。 */
  list() {
    return this.#models;
  }
  /** 取一条模型；找不到返回 undefined。 */
  find(id) {
    return this.#models.find((model) => model.id === id);
  }
  /** 目录是否已经来自上游实测（而不是兜底快照）。 */
  get live() {
    return this.#fetchedAt > 0;
  }
  /**
   * 拉一次上游目录。
   *
   * 失败不算致命：继续用当前目录，下次再试。并发调用共享同一次请求。
   */
  async refresh(force = false) {
    if (!force && this.#fetchedAt > 0 && Date.now() - this.#fetchedAt < CATALOG_TTL_MS) return;
    if (this.#inflight !== void 0) return this.#inflight;
    this.#inflight = (async () => {
      try {
        const models = await this.#client.listModels();
        if (models.length > 0) {
          this.#models = models;
          this.#fetchedAt = Date.now();
        }
      } catch {
      } finally {
        this.#inflight = void 0;
      }
    })();
    return this.#inflight;
  }
};
function contextWindowOf(model) {
  const value = model?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}
function maxTokensOf(model) {
  const value = model?.maxTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOKENS;
}
function endpointFor(model) {
  return isResponsesApi(model?.api) ? "responses" : "chat";
}

// src/adapter/stream.ts
init_sse();
function finishReasonOf(finish, sawToolCall) {
  if (sawToolCall && (finish === "" || finish === "tool_calls" || finish === "stop")) {
    return { kind: "tool-calls" };
  }
  switch (finish) {
    case "length":
      return { kind: "max-tokens" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "content_filter":
      return { kind: "error", failure: { message: "\u5185\u5BB9\u88AB\u4E0A\u6E38\u8FC7\u6EE4", code: "CONTENT_FILTERED" } };
    default:
      return { kind: "stop" };
  }
}
async function* toStreamChunks(body, model, signal) {
  let nextIndex = 0;
  let textIndex = -1;
  let reasoningIndex = -1;
  let textOpen = false;
  let reasoningOpen = false;
  const textBuffer = /* @__PURE__ */ new Map();
  const reasoningBuffer = /* @__PURE__ */ new Map();
  const toolCalls = /* @__PURE__ */ new Map();
  const toolIndexes = /* @__PURE__ */ new Map();
  let sawToolCall = false;
  let finish = "";
  let usage;
  let upstreamError;
  const buffer = [];
  let notify;
  let producerDone = false;
  let producerError;
  const wake = () => {
    const fn = notify;
    notify = void 0;
    fn?.();
  };
  const push = (chunk) => {
    buffer.push(chunk);
    wake();
  };
  const onFrame = (frame) => {
    const object = frame.object;
    if (object === void 0) return true;
    const errObj = object.error;
    if (errObj !== null && typeof errObj === "object") {
      const e = errObj;
      upstreamError = {
        message: typeof e.message === "string" ? e.message : `${model}: \u4E0A\u6E38\u5728\u6D41\u4E2D\u62A5\u9519`,
        code: typeof e.code === "string" ? e.code : "UPSTREAM"
      };
      return false;
    }
    const { delta, finish: f } = chatChunkDelta(object);
    if (f !== "") finish = f;
    const u = chatChunkUsage(object);
    if (u !== void 0) {
      const normalized = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens
      };
      if (u.cacheReadTokens !== void 0) normalized.cacheReadTokens = u.cacheReadTokens;
      if (u.cacheWriteTokens !== void 0) normalized.cacheWriteTokens = u.cacheWriteTokens;
      usage = normalized;
    }
    if (delta.reasoning !== "") {
      if (!reasoningOpen) {
        reasoningIndex = nextIndex;
        nextIndex += 1;
        reasoningOpen = true;
        push({ type: "block-start", index: reasoningIndex, blockType: "reasoning" });
      }
      reasoningBuffer.set(reasoningIndex, (reasoningBuffer.get(reasoningIndex) ?? "") + delta.reasoning);
      push({ type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning });
    }
    if (delta.content !== "") {
      if (reasoningOpen) {
        reasoningOpen = false;
        push({
          type: "block-end",
          index: reasoningIndex,
          block: { type: "reasoning", text: reasoningBuffer.get(reasoningIndex) ?? "" }
        });
      }
      if (!textOpen) {
        textIndex = nextIndex;
        nextIndex += 1;
        textOpen = true;
        push({ type: "block-start", index: textIndex, blockType: "text" });
      }
      textBuffer.set(textIndex, (textBuffer.get(textIndex) ?? "") + delta.content);
      push({ type: "text-delta", index: textIndex, text: delta.content });
    }
    for (const tc of delta.toolCalls) {
      let slot = toolCalls.get(tc.index);
      if (slot === void 0) {
        slot = { id: "", name: "", args: "" };
        toolCalls.set(tc.index, slot);
        toolIndexes.set(tc.index, nextIndex);
        nextIndex += 1;
        sawToolCall = true;
        push({ type: "block-start", index: toolIndexes.get(tc.index) ?? 0, blockType: "tool-call" });
      }
      if (tc.id !== "") slot.id = tc.id;
      if (tc.name !== "") slot.name = tc.name;
      slot.args += tc.args;
      push({
        type: "tool-call-delta",
        index: toolIndexes.get(tc.index) ?? 0,
        id: slot.id,
        ...slot.name !== "" ? { name: slot.name } : {},
        argumentsDelta: tc.args
      });
    }
    return true;
  };
  void forEachSseFrame(body, onFrame, signal).then(() => {
    producerDone = true;
    wake();
  }).catch((error) => {
    producerError = error;
    producerDone = true;
    wake();
  });
  for (; ; ) {
    while (buffer.length > 0) {
      const chunk = buffer.shift();
      if (chunk !== void 0) yield chunk;
    }
    if (producerDone) break;
    await new Promise((resolve) => {
      notify = resolve;
    });
  }
  if (producerError !== void 0) {
    const message = producerError instanceof Error ? producerError.message : String(producerError);
    yield { type: "finish", reason: { kind: "aborted", failure: { message, code: "ABORTED" } } };
    return;
  }
  if (reasoningOpen) {
    yield {
      type: "block-end",
      index: reasoningIndex,
      block: { type: "reasoning", text: reasoningBuffer.get(reasoningIndex) ?? "" }
    };
    reasoningOpen = false;
  }
  if (textOpen) {
    yield { type: "block-end", index: textIndex, block: { type: "text", text: textBuffer.get(textIndex) ?? "" } };
    textOpen = false;
  }
  const unnamed = [...toolCalls.values()].filter((slot) => slot.name.trim() === "").length;
  const said = [...textBuffer.values()].join("") + [...reasoningBuffer.values()].join("");
  for (const [index, slot] of toolCalls) {
    yield {
      type: "block-end",
      index: toolIndexes.get(index) ?? 0,
      block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args }
    };
  }
  if (usage !== void 0) yield { type: "usage", usage };
  if (upstreamError !== void 0) {
    yield { type: "finish", reason: { kind: "error", failure: upstreamError } };
    return;
  }
  if (unnamed > 0) {
    const detail = `${model}: \u4E0A\u6E38\u8FD4\u56DE\u4E86 ${unnamed} \u4E2A\u6CA1\u6709\u540D\u5B57\u7684\u5DE5\u5177\u8C03\u7528\uFF0C\u5DF2\u4E22\u5F03`;
    yield { type: "finish", reason: { kind: "error", failure: { message: detail, code: "UNNAMED_TOOL_CALL" } } };
    return;
  }
  if (said.trim() === "" && !sawToolCall && finish !== "length") {
    yield {
      type: "finish",
      reason: { kind: "error", failure: { message: `${model}: \u4E0A\u6E38\u8FD4\u56DE\u4E86\u7A7A\u56DE\u7B54`, code: "EMPTY_RESPONSE" } }
    };
    return;
  }
  yield { type: "finish", reason: finishReasonOf(finish, sawToolCall) };
}

// src/adapter/deepai.ts
var PROVIDER_ID = "deepai";
var REASONING_EFFORTS = [
  { id: "none", name: "\u5173\u95ED" },
  { id: "low", name: "\u4F4E" },
  { id: "medium", name: "\u4E2D" },
  { id: "high", name: "\u9AD8" }
];
var DeepAIAdapter = class {
  #providerId;
  #displayName;
  #client;
  #store;
  #catalog;
  constructor(options) {
    this.#providerId = options.providerId;
    this.#displayName = options.displayName;
    this.#client = options.client;
    this.#store = options.store;
    this.#catalog = new ModelCatalog(options.client);
  }
  /** 模型目录（给设置页读）。 */
  get catalog() {
    return this.#catalog;
  }
  /** DSH 读取 provider 显示信息。 */
  providerInfo(provider) {
    return { id: provider, name: this.#displayName };
  }
  /**
   * provider 级重试策略。
   *
   * DSH 在注册时无条件调这个方法。上游的容量拒绝（409 `session_busy`）
   * 带 `Retry-After`，把静默吸收窗口拉长比让用户直接看到报错好。
   * 确定性失败（鉴权、策略拦截、车道错误）不在这里，由错误分类挡掉。
   */
  providerRetryPolicy(_provider) {
    return {
      maxRetries: 4,
      initialDelayMs: 1e3,
      maxDelayMs: 2e4,
      retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "NETWORK", "OVERLOADED"]
    };
  }
  /** 免费额度渠道不做图片计费。 */
  imageRequestPricing(_provider, _model) {
    return void 0;
  }
  /** 模型列表（DSH 的模型选择器读这个）。 */
  listModels(provider) {
    return this.#catalog.list().map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: acceptsImage(model) ? ["text", "image"] : ["text"]
    }));
  }
  /** 解析模型能力。 */
  resolveModel(provider, model) {
    const entry = this.#catalog.find(model);
    const resolved = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: acceptsImage(entry) ? ["text", "image"] : ["text"],
      context: { contextWindow: contextWindowOf(entry) },
      defaultMaxTokens: maxTokensOf(entry)
    };
    if (entry?.reasoning === true) {
      const efforts = REASONING_EFFORTS.filter(
        (effort) => endpointFor(entry) === "responses" ? effort.id !== "none" : true
      ).map((effort) => ({ id: effort.id, name: effort.name }));
      resolved.reasoning = { efforts };
    }
    return resolved;
  }
  /** DSH 在每次调用前调这个，拿模型能力与 stream 句柄。 */
  async prepareCall(provider, model, _signal) {
    if (!this.#catalog.live) await this.#catalog.refresh();
    await this.#store.load();
    const account = this.#store.get();
    if (account === void 0) {
      throw new Error("deepai: \u8FD8\u6CA1\u767B\u5F55\uFF0C\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 DeepAI Code\u300D\u5B8C\u6210\u4E00\u6B21\u6388\u6743");
    }
    this.#client.setApiKey(account.apiKey);
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.#stream(model, options)
    };
  }
  /** 发起一次流式请求。 */
  async *#stream(model, options) {
    const entry = this.#catalog.find(model);
    if (entry === void 0) {
      throw new Error(`deepai: \u672A\u77E5\u6A21\u578B "${model}"\uFF08\u53EF\u7528\uFF1A${this.#catalog.list().map((m) => m.id).join(", ")}\uFF09`);
    }
    const account = this.#store.get();
    if (account === void 0) throw new Error("deepai: \u8FD8\u6CA1\u767B\u5F55");
    this.#client.setApiKey(account.apiKey);
    await this.#client.ensureCheckIn(options.signal);
    const body = buildChatBody(options, entry.id);
    let result;
    try {
      result = await this.#client.openChat(options, entry.id, body, options.signal);
    } catch (error) {
      throw this.#describe(error);
    }
    for await (const chunk of toStreamChunks(result.body, model, options.signal)) {
      yield chunk;
    }
  }
  /**
   * 把上游错误转成用户能看懂的说法。
   *
   * 策略类错误（`social_login_required`）不是「重试一下就好」，
   * 直接说清账号要求，否则用户会以为是网络问题反复试。
   */
  #describe(error) {
    if (!(error instanceof UpstreamError)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (error.socialLoginRequired) {
      return new Error(
        "deepai: \u4E0A\u6E38\u8981\u6C42\u8BE5\u8D26\u53F7\u6539\u7528 Google \u6216 Apple \u767B\u5F55\u3002\u90AE\u7BB1\u5BC6\u7801\u6CE8\u518C\u7684\u8D26\u53F7\u5DF2\u88AB\u7981\u6B62\u63A8\u7406\uFF0C\u6362\u53F7\u6216\u91CD\u8BD5\u90FD\u65E0\u6548\uFF0C\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 DeepAI Code\u300D\u7528 Google/Apple \u91CD\u65B0\u6388\u6743\u3002"
      );
    }
    if (error.emailUnverified) {
      return new Error("deepai: \u8D26\u53F7\u90AE\u7BB1\u672A\u9A8C\u8BC1\uFF0C\u4E0A\u6E38\u62D2\u7EDD\u4E86\u8FD9\u6B21\u8BF7\u6C42\u3002\u8BF7\u5230\u4E0A\u6E38\u9A8C\u8BC1\u90AE\u7BB1\u540E\u91CD\u65B0\u6388\u6743\u3002");
    }
    if (error.authFailed) {
      return new Error("deepai: \u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5230\u300C\u8BBE\u7F6E \u2192 DeepAI Code\u300D\u91CD\u65B0\u6388\u6743\u3002");
    }
    if (error.machineRequired) {
      return new Error(
        "deepai: \u4E0A\u6E38\u8981\u6C42\u673A\u5668\u6307\u7EB9\uFF0C\u4F46\u672C\u5730\u6CA1\u8BFB\u5230\u3002\u53EF\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DEEPAI_MACHINE_ID=<\u539F\u59CB\u673A\u5668 UUID> \u540E\u91CD\u542F DSH\u3002"
      );
    }
    if (error.networkBound) {
      return new Error(
        `deepai: \u8BE5\u7F51\u7EDC\u7684\u4ECA\u65E5\u514D\u8D39\u989D\u5EA6\u5DF2\u9886\u5B8C\uFF08${error.message}\uFF09\u3002\u540C\u4E00\u51FA\u53E3 IP \u5171\u4EAB\u989D\u5EA6\uFF0C\u6362\u53F7\u901A\u5E38\u65E0\u6548\uFF0C\u7B49\u4E0A\u6E38\u7ED9\u7684\u5237\u65B0\u65F6\u95F4\u3002`
      );
    }
    if (error.capacityWaiting) {
      return new Error(`deepai: \u4E0A\u6E38\u4F1A\u8BDD\u7E41\u5FD9\uFF0C\u7A0D\u540E\u91CD\u8BD5\uFF08${error.message}\uFF09`);
    }
    if (error.laneUnsupported) {
      return new Error("deepai: \u4E0A\u6E38\u4E0D\u518D\u63A5\u53D7\u5F53\u524D\u8F66\u9053\u7248\u672C\uFF0C\u63D2\u4EF6\u9700\u8981\u66F4\u65B0\u3002");
    }
    if (error.checkInRefused) {
      return new Error("deepai: \u4ECA\u65E5\u7B7E\u5230\u6B21\u6570\u5DF2\u7528\u5C3D\uFF08\u63A8\u7406\u4ECD\u53EF\u7528\uFF0C\u4F46\u53EF\u80FD\u843D\u5230\u66FF\u8EAB\u540E\u7AEF\uFF09\u3002");
    }
    if (error.bodyRejected) {
      return new Error(`deepai: \u8BF7\u6C42\u4F53\u5F62\u72B6\u672A\u88AB\u4E0A\u6E38\u63A5\u53D7\uFF1A${error.message}`);
    }
    return new Error(`deepai: ${error.message}`);
  }
  /** 强制重拉上游模型目录。 */
  async refreshModels(force = false) {
    await this.#catalog.refresh(force);
  }
};

// src/adapter/machine.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile as readFile2 } from "node:fs/promises";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var PLACEHOLDER_UUIDS = /* @__PURE__ */ new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009"
]);
function machineFingerprint(raw) {
  const value = raw.trim().toLowerCase();
  if (value === "") return "";
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function isPlaceholderUuid(raw) {
  return PLACEHOLDER_UUIDS.has(raw.trim().toLowerCase());
}
async function windowsRawUuid() {
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID"
      ],
      { timeout: 8e3, windowsHide: true }
    );
    const uuid = stdout.trim();
    if (uuid !== "" && !isPlaceholderUuid(uuid)) return uuid;
  } catch {
  }
  try {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { timeout: 8e3, windowsHide: true }
    );
    const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout);
    if (match?.[1] !== void 0) return match[1].trim();
  } catch {
  }
  return "";
}
async function darwinRawUuid() {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      timeout: 8e3
    });
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}
async function linuxRawUuid() {
  for (const path of ["/sys/class/dmi/id/product_uuid", "/etc/machine-id"]) {
    try {
      const raw = (await readFile2(path, "utf8")).trim();
      if (raw !== "" && !isPlaceholderUuid(raw)) return raw;
    } catch {
    }
  }
  return "";
}
async function detectMachineFingerprint(env = process.env) {
  const override = (env.DEEPAI_MACHINE_ID ?? "").trim();
  if (override !== "") return machineFingerprint(override);
  let raw = "";
  switch (process.platform) {
    case "win32":
      raw = await windowsRawUuid();
      break;
    case "darwin":
      raw = await darwinRawUuid();
      break;
    default:
      raw = await linuxRawUuid();
  }
  return machineFingerprint(raw);
}

// src/index.ts
var name = "dsh-deepai-connector";
var inject = ["llm"];
var API_PREFIX = "/api/deepai";
function resolveConfig(config = {}) {
  const explicit = config.dataDir?.trim();
  const dataDir = explicit !== void 0 && explicit !== "" ? explicit : defaultDataDir();
  return {
    providerId: config.providerId?.trim() || PROVIDER_ID,
    displayName: config.displayName?.trim() || "DeepAI Code",
    dataDir
  };
}
function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const ready = Promise.resolve({ version: "adapter" });
  try {
    return start(ctx, config, logger, ready);
  } catch (error) {
    logger.error(
      `dsh-deepai-connector: \u542F\u52A8\u5931\u8D25\uFF1A${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    return { ready };
  }
}
function start(ctx, config, logger, ready) {
  const cfg = resolveConfig(config);
  if (!ctx.llm || typeof ctx.llm.registerAdapter !== "function") {
    logger.error("dsh-deepai-connector: llm \u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u9002\u914D\u5668\u65E0\u6CD5\u6CE8\u518C");
    return { ready };
  }
  const store = new AccountStore(cfg.dataDir);
  const client = new DeepAIClient();
  const machineReady = detectMachineFingerprint().then((fingerprint) => {
    if (fingerprint === "") {
      logger.warn(
        "dsh-deepai-connector: \u672A\u8BFB\u53D6\u5230\u673A\u5668\u6307\u7EB9\uFF0C\u4E0A\u6E38\u53EF\u80FD\u62D2\u7EDD\u63A8\u7406\uFF08machine_required\uFF09\u3002\u53EF\u8BBE\u7F6E DEEPAI_MACHINE_ID=<\u539F\u59CB\u673A\u5668 UUID> \u663E\u5F0F\u8986\u76D6"
      );
    } else {
      logger.info(`dsh-deepai-connector: \u673A\u5668\u6307\u7EB9 ${fingerprint.slice(0, 12)}\u2026`);
    }
    return fingerprint;
  }).catch(() => "");
  const adapter = new DeepAIAdapter({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    client,
    store
  });
  try {
    ctx.llm.registerAdapter([cfg.providerId], adapter);
    logger.info(`dsh-deepai-connector: \u5DF2\u6CE8\u518C provider "${cfg.providerId}"`);
  } catch (error) {
    logger.error(
      `dsh-deepai-connector: provider "${cfg.providerId}" \u6CE8\u518C\u5931\u8D25\uFF08\u53EF\u80FD\u4E0E\u5DF2\u88C5\u63D2\u4EF6\u540C\u540D\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
    return { ready };
  }
  void (async () => {
    await store.load();
    const account = store.get();
    if (account === void 0) {
      logger.info("dsh-deepai-connector: \u8FD8\u6CA1\u6709\u767B\u5F55\uFF0C\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 DeepAI Code\u300D\u5B8C\u6210\u6388\u6743");
      return;
    }
    logger.info(`dsh-deepai-connector: \u5DF2\u52A0\u8F7D\u8D26\u53F7 ${account.username !== "" ? account.username : "(\u65E0\u7528\u6237\u540D)"}`);
    client.setApiKey(account.apiKey);
    const fingerprint = await machineReady;
    client.setMachine(fingerprint);
    try {
      const lane = await client.probeLane();
      logger.info(`dsh-deepai-connector: \u8F66\u9053\u7248\u672C ${lane}`);
    } catch {
      logger.warn("dsh-deepai-connector: \u8F66\u9053\u63A2\u6D4B\u5931\u8D25\uFF0C\u6CBF\u7528\u9ED8\u8BA4\u503C");
    }
    await adapter.refreshModels(true).catch(() => {
    });
    logger.info(`dsh-deepai-connector: \u6A21\u578B\u76EE\u5F55 ${adapter.catalog.list().length} \u9879`);
  })().catch((error) => {
    logger.error(`dsh-deepai-connector: \u521D\u59CB\u5316\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  });
  installRoutes(ctx, cfg, store, client, adapter, logger);
  return { ready };
}
function installRoutes(ctx, cfg, store, client, adapter, logger) {
  if (typeof ctx.inject !== "function") return;
  let pending;
  try {
    ctx.inject(["connection"], (cctx) => {
      const connection = cctx.connection;
      const register = connection?.fetch?.register;
      if (typeof register !== "function") {
        logger.warn("dsh-deepai-connector: connection fetch \u6CE8\u518C\u8868\u4E0D\u53EF\u7528\uFF0C\u8BBE\u7F6E\u9875 API \u5DF2\u7981\u7528");
        return;
      }
      const json = (status, payload) => new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
      const disposers = [];
      const registerRoute = (path, methods, handler) => {
        try {
          disposers.push(
            register({
              path,
              methods,
              requestBody: "buffered",
              fetch: handler
            })
          );
        } catch (error) {
          logger.warn(
            `dsh-deepai-connector: ${path} \u6CE8\u518C\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
          );
        }
      };
      registerRoute(`${API_PREFIX}/status`, ["GET"], async () => {
        await store.load();
        const account = store.get();
        const models = adapter.catalog.list();
        return json(200, {
          ok: true,
          providerId: cfg.providerId,
          displayName: cfg.displayName,
          signedIn: account !== void 0,
          account: account !== void 0 ? {
            username: account.username,
            isPro: account.isPro,
            obtainedAt: account.obtainedAt
          } : null,
          lane: client.lane,
          machineReady: client.machine !== "",
          catalogLive: adapter.catalog.live,
          models: models.map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            free: m.theosPerRequest === "0" || m.premier !== true,
            vision: (m.input ?? []).includes("image"),
            reasoning: m.reasoning === true,
            contextWindow: m.contextWindow ?? null,
            maxTokens: m.maxTokens ?? null
          }))
        });
      });
      registerRoute(`${API_PREFIX}/login`, ["POST"], async () => {
        try {
          pending?.cancel();
          const session = startSignIn();
          pending = session;
          const url = await session.ready();
          void session.wait().then(async (account) => {
            await store.save(account);
            client.setApiKey(account.apiKey);
            logger.info(`dsh-deepai-connector: \u6388\u6743\u6210\u529F ${account.username !== "" ? account.username : ""}`);
            await adapter.refreshModels(true).catch(() => {
            });
          }).catch((error) => {
            logger.warn(
              `dsh-deepai-connector: \u6388\u6743\u672A\u5B8C\u6210\uFF1A${error instanceof Error ? error.message : String(error)}`
            );
          }).finally(() => {
            if (pending === session) pending = void 0;
          });
          return json(200, { ok: true, url, instructions: "\u5728\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210\u767B\u5F55\uFF0C\u7136\u540E\u56DE\u5230\u6B64\u5904\u5237\u65B0" });
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      registerRoute(`${API_PREFIX}/logout`, ["POST"], async () => {
        try {
          pending?.cancel();
          pending = void 0;
          await store.clear();
          client.setApiKey("");
          logger.info("dsh-deepai-connector: \u5DF2\u767B\u51FA");
          return json(200, { ok: true });
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      registerRoute(`${API_PREFIX}/models/refresh`, ["POST"], async () => {
        try {
          await adapter.refreshModels(true);
          return json(200, {
            ok: true,
            live: adapter.catalog.live,
            models: adapter.catalog.list().map((m) => ({ id: m.id, name: m.name ?? m.id }))
          });
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      logger.info(`dsh-deepai-connector: \u8BBE\u7F6E\u9875 API \u5DF2\u6302\u8F7D\u5728 ${API_PREFIX}`);
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          pending?.cancel();
          pending = void 0;
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
            }
          }
        });
      }
      return void 0;
    });
  } catch (error) {
    logger.warn(
      `dsh-deepai-connector: \u8BBE\u7F6E\u9875 API \u4E0D\u53EF\u7528\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
  }
}
export {
  AccountStore,
  DeepAIAdapter,
  DeepAIClient,
  PROVIDER_ID,
  apply,
  detectMachineFingerprint,
  inject,
  machineFingerprint,
  name,
  resolveConfig,
  startSignIn,
  toStreamChunks
};
//# sourceMappingURL=index.js.map
