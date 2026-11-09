window.__ModuleLoader__.load({
  id: "dsh-deepai-connector",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  NS: () => NS,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/i18n.ts
var import_react = require("react");
var NS = "dsh-deepai-connector";
var ZH = {
  nav: "DeepAI Code",
  title: "DeepAI Code",
  intro: "\u7528\u4F60\u7684 DeepAI Code \u8D26\u53F7\uFF0C\u5728 DSH \u91CC\u76F4\u63A5\u8C03\u7528\u5B83\u7684\u6A21\u578B\u3002\u6D4F\u89C8\u5668\u767B\u5F55\u4E00\u6B21\u5373\u53EF\uFF0C\u4E0D\u9700\u8981\u5B89\u88C5 DeepAI Code \u684C\u9762\u5BA2\u6237\u7AEF\uFF0C\u4E5F\u4E0D\u9700\u8981\u989D\u5916\u7684\u7F51\u5173\u7A0B\u5E8F\u3002",
  accountSection: "\u8D26\u53F7",
  login: "\u767B\u5F55",
  loggingIn: "\u7B49\u5F85\u6388\u6743\u2026",
  loginPending: "\u6388\u6743\u94FE\u63A5\u5DF2\u751F\u6210\uFF0C\u8BF7\u5728\u6D4F\u89C8\u5668\u91CC\u5B8C\u6210\u767B\u5F55\u5E76\u6388\u6743\u3002",
  openLink: "\u6253\u5F00\u6388\u6743\u9875\u9762",
  copyLink: "\u590D\u5236\u94FE\u63A5",
  copied: "\u5DF2\u590D\u5236",
  loginWaiting: "\u6B63\u5728\u7B49\u5F85\u6D4F\u89C8\u5668\u6388\u6743\uFF08\u6700\u591A 10 \u5206\u949F\uFF09\u2026",
  loginSuccess: "\u767B\u5F55\u6210\u529F",
  loginFailed: "\u767B\u5F55\u5931\u8D25",
  noAccount: "\u8FD8\u6CA1\u6709\u767B\u5F55\u8D26\u53F7\u3002",
  noAccountHint: "\u70B9\u300C\u767B\u5F55\u300D\u4F1A\u751F\u6210\u4E00\u4E2A\u6388\u6743\u94FE\u63A5\uFF0C\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00\u5E76\u6388\u6743\u5373\u53EF\u3002\u8BF7\u7528 Google \u6216 Apple \u8D26\u53F7\u767B\u5F55\u3002",
  logout: "\u79FB\u9664",
  logoutConfirm: "\u786E\u5B9A\u8981\u79FB\u9664\u8FD9\u4E2A\u8D26\u53F7\u5417\uFF1F",
  refresh: "\u5237\u65B0",
  signedInAs: "\u5DF2\u767B\u5F55",
  proPlan: "Pro",
  obtainedAt: "\u6388\u6743\u4E8E",
  statusSection: "\u8FDE\u63A5\u72B6\u6001",
  lane: "\u8F66\u9053\u7248\u672C",
  machineReady: "\u673A\u5668\u6307\u7EB9",
  machineMissing: "\u672A\u8BFB\u53D6",
  known: "\u5DF2\u5C31\u7EEA",
  yes: "\u662F",
  no: "\u5426",
  modelSection: "\u53EF\u7528\u6A21\u578B",
  modelHint: "\u8FD9\u4E9B\u662F\u4E0A\u6E38\u5F53\u524D\u63D0\u4F9B\u7684\u6A21\u578B\uFF0C\u767B\u5F55\u540E\u5373\u53EF\u5728\u6A21\u578B\u9009\u62E9\u5668\u91CC\u9009\u5230\u3002\u6BCF\u4E2A\u8BF7\u6C42\u6D88\u8017\u7684 Theos \u4E3A 0 \u5373\u514D\u8D39\u3002",
  free: "\u514D\u8D39",
  paid: "\u4ED8\u8D39",
  vision: "\u53EF\u770B\u56FE",
  thinking: "\u4F1A\u601D\u8003",
  contextWindow: "\u4E0A\u4E0B\u6587",
  maxTokens: "\u6700\u5927\u8F93\u51FA",
  catalogLive: "\u76EE\u5F55\u6765\u6E90",
  fromUpstream: "\u4E0A\u6E38\u5B9E\u6D4B",
  fromFallback: "\u5185\u7F6E\u5FEB\u7167",
  cancel: "\u53D6\u6D88",
  error: "\u51FA\u9519\u4E86",
  retry: "\u91CD\u8BD5",
  loading: "\u52A0\u8F7D\u4E2D\u2026"
};
var EN = {
  nav: "DeepAI Code",
  title: "DeepAI Code",
  intro: "Use your DeepAI Code account to call its models from DSH. Sign in once in the browser \u2014 no DeepAI Code desktop app and no gateway process needed.",
  accountSection: "Account",
  login: "Sign in",
  loggingIn: "Waiting for authorization\u2026",
  loginPending: "Authorization link created. Finish signing in in your browser.",
  openLink: "Open authorization page",
  copyLink: "Copy link",
  copied: "Copied",
  loginWaiting: "Waiting for browser authorization (up to 10 minutes)\u2026",
  loginSuccess: "Signed in",
  loginFailed: "Sign-in failed",
  noAccount: "No account signed in yet.",
  noAccountHint: 'Press "Sign in" to get an authorization link, then open it in your browser. Use a Google or Apple account.',
  logout: "Remove",
  logoutConfirm: "Remove this account?",
  refresh: "Refresh",
  signedInAs: "Signed in as",
  proPlan: "Pro",
  obtainedAt: "Authorized",
  statusSection: "Connection",
  lane: "Lane version",
  machineReady: "Machine fingerprint",
  machineMissing: "not detected",
  known: "ready",
  yes: "yes",
  no: "no",
  modelSection: "Available models",
  modelHint: "Models the upstream offers right now. A Theos cost of 0 per request means free.",
  free: "free",
  paid: "paid",
  vision: "vision",
  thinking: "thinking",
  contextWindow: "Context",
  maxTokens: "Max output",
  catalogLive: "Catalog source",
  fromUpstream: "live",
  fromFallback: "built-in snapshot",
  cancel: "Cancel",
  error: "Error",
  retry: "Retry",
  loading: "Loading\u2026"
};
var runtime;
function setLocaleRuntime(next) {
  runtime = next;
}
function isZh() {
  try {
    const active = runtime?.getSnapshot?.()?.active ?? "";
    if (active === "") return true;
    return /^zh/i.test(active);
  } catch {
    return true;
  }
}
function text(key, params) {
  const dict = isZh() ? ZH : EN;
  let value = dict[key] ?? ZH[key] ?? key;
  if (params !== void 0) {
    for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v));
  }
  return value;
}
function useLocaleRevision() {
  return (0, import_react.useSyncExternalStore)(
    (listener) => {
      try {
        return runtime?.subscribe?.(listener) ?? (() => {
        });
      } catch {
        return () => {
        };
      }
    },
    () => {
      try {
        return runtime?.getSnapshot?.()?.revision ?? 0;
      } catch {
        return 0;
      }
    },
    () => 0
  );
}

// src/client/page.tsx
var import_react2 = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var REQUEST_TIMEOUT_MS = 15e3;
var POLL_INTERVAL_MS = 1500;
var LOGIN_WAIT_MS = 11 * 60 * 1e3;
var styles = {
  wrap: { display: "flex", flexDirection: "column", gap: 20 },
  section: { display: "flex", flexDirection: "column", gap: 10 },
  h2: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", margin: 0 },
  muted: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0, lineHeight: 1.6 },
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  card: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2)",
    display: "flex",
    flexDirection: "column",
    gap: 6
  },
  code: {
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--dsw-alias-label-secondary)",
    wordBreak: "break-all"
  },
  link: {
    fontSize: 12,
    color: "var(--dsw-alias-label-primary)",
    textDecoration: "underline",
    wordBreak: "break-all"
  },
  list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
  item: {
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2)",
    display: "flex",
    flexDirection: "column",
    gap: 3
  },
  itemHead: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  name: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
  tag: {
    padding: "1px 7px",
    borderRadius: 999,
    fontSize: 11,
    border: "1px solid var(--dsw-alias-border-l2)",
    color: "var(--dsw-alias-label-secondary)"
  },
  tagFree: {
    padding: "1px 7px",
    borderRadius: 999,
    fontSize: 11,
    border: "1px solid var(--dsw-alias-border-l2)",
    color: "var(--dsw-alias-label-primary)"
  },
  err: { fontSize: 12, color: "var(--dsw-alias-label-warning, #d9534f)", margin: 0 }
};
async function request(path, method = "GET", body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      headers: body === void 0 ? void 0 : { "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: controller.signal,
      credentials: "same-origin"
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(raw?.error ?? `HTTP ${res.status}`);
    return raw;
  } finally {
    clearTimeout(timer);
  }
}
function Btn(props) {
  const { children, onClick, disabled, primary } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      onClick,
      disabled,
      style: {
        padding: "6px 14px",
        borderRadius: 8,
        fontSize: 13,
        cursor: disabled === true ? "not-allowed" : "pointer",
        opacity: disabled === true ? 0.5 : 1,
        border: primary === true ? "none" : "1px solid var(--dsw-alias-border-l2)",
        background: primary === true ? "var(--dsw-alias-label-primary)" : "transparent",
        color: primary === true ? "var(--dsw-alias-bg-layer-1)" : "var(--dsw-alias-label-primary)"
      },
      children
    }
  );
}
function formatTokens(tokens) {
  if (tokens === null || tokens === void 0 || tokens <= 0) return "\u2014";
  if (tokens >= 1e6) return `${Number((tokens / 1e6).toFixed(1))}M`;
  if (tokens >= 1e3) return `${Number((tokens / 1e3).toFixed(1))}K`;
  return String(tokens);
}
function DeepAISettings() {
  useLocaleRevision();
  const [status, setStatus] = (0, import_react2.useState)(null);
  const [error, setError] = (0, import_react2.useState)("");
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [loginUrl, setLoginUrl] = (0, import_react2.useState)("");
  const [waiting, setWaiting] = (0, import_react2.useState)(false);
  const [copied, setCopied] = (0, import_react2.useState)(false);
  const pollTimer = (0, import_react2.useRef)(null);
  const loginDeadline = (0, import_react2.useRef)(0);
  const load = (0, import_react2.useCallback)(async () => {
    try {
      const data = await request("/api/deepai/status");
      setStatus(data);
      setError("");
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);
  (0, import_react2.useEffect)(() => {
    void load();
  }, [load]);
  const stopPolling = (0, import_react2.useCallback)(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setWaiting(false);
  }, []);
  (0, import_react2.useEffect)(() => stopPolling, [stopPolling]);
  const startLogin = (0, import_react2.useCallback)(async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const data = await request("/api/deepai/login", "POST");
      if (data.ok !== true || data.url === void 0 || data.url === "") {
        throw new Error(data.error ?? text("loginFailed"));
      }
      setLoginUrl(data.url);
      setWaiting(true);
      loginDeadline.current = Date.now() + LOGIN_WAIT_MS;
      if (pollTimer.current !== null) clearInterval(pollTimer.current);
      pollTimer.current = setInterval(async () => {
        if (Date.now() > loginDeadline.current) {
          stopPolling();
          setError(text("loginFailed"));
          return;
        }
        const next = await load();
        if (next?.signedIn === true) {
          stopPolling();
          setLoginUrl("");
          setBusy(false);
        }
      }, POLL_INTERVAL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [load, stopPolling]);
  const copyUrl = (0, import_react2.useCallback)(async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [loginUrl]);
  const logout = (0, import_react2.useCallback)(async () => {
    if (!window.confirm(text("logoutConfirm"))) return;
    setBusy(true);
    try {
      await request("/api/deepai/logout", "POST");
      setLoginUrl("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load]);
  const refreshModels = (0, import_react2.useCallback)(async () => {
    setBusy(true);
    try {
      await request("/api/deepai/models/refresh", "POST");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load]);
  const account = status?.account ?? null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.wrap, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: styles.h2, children: text("title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: text("intro") })
    ] }),
    error !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.err, children: `${text("error")}: ${error}` }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: styles.h2, children: text("accountSection") }),
      account === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: text("noAccount") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: text("noAccountHint") })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.itemHead, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.name, children: `${text("signedInAs")} ${account.username !== "" ? account.username : "\u2014"}` }),
          account.isPro && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.tagFree, children: text("proPlan") })
        ] }),
        account.obtainedAt !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.code, children: `${text("obtainedAt")} ${account.obtainedAt}` })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
        account === null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { primary: true, disabled: busy, onClick: () => void startLogin(), children: waiting ? text("loggingIn") : text("login") }),
        account !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { disabled: busy, onClick: () => void refreshModels(), children: text("refresh") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { disabled: busy, onClick: () => void logout(), children: text("logout") })
        ] })
      ] }),
      loginUrl !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: text("loginPending") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { href: loginUrl, target: "_blank", rel: "noreferrer", style: styles.link, children: text("openLink") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: () => void copyUrl(), children: copied ? text("copied") : text("copyLink") }),
          waiting && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.muted, children: text("loginWaiting") })
        ] })
      ] })
    ] }),
    status !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: styles.h2, children: text("statusSection") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.tag, children: `${text("lane")}: ${status.lane}` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.tag, children: `${text("machineReady")}: ${status.machineReady ? text("known") : text("machineMissing")}` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.tag, children: `${text("catalogLive")}: ${status.catalogLive ? text("fromUpstream") : text("fromFallback")}` })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: styles.h2, children: text("modelSection") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: text("modelHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", { style: styles.list, children: [
        (status?.models ?? []).map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: styles.item, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.itemHead, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.name, children: model.name }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: model.free === true ? styles.tagFree : styles.tag, children: model.free === true ? text("free") : text("paid") }),
            model.vision === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.tag, children: text("vision") }),
            model.reasoning === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.tag, children: text("thinking") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.code, children: `${model.id} \xB7 ${text("contextWindow")} ${formatTokens(model.contextWindow)} \xB7 ${text("maxTokens")} ${formatTokens(model.maxTokens)}` })
        ] }, model.id)),
        status !== null && (status.models ?? []).length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: text("loading") })
      ] })
    ] })
  ] });
}

// src/client/index.ts
function registerDictionaries(ctx) {
  try {
    ctx.locale.register(NS, { zh: ZH, en: EN });
    return;
  } catch {
  }
  try {
    ctx.locale.register(NS, "zh", ZH);
    ctx.locale.register(NS, "en", EN);
  } catch {
  }
}
function apply(ctx) {
  setLocaleRuntime(ctx.locale);
  if (typeof ctx.effect === "function") {
    try {
      ctx.effect(
        () => {
          registerDictionaries(ctx);
          return () => {
            setLocaleRuntime(void 0);
          };
        },
        "dsh-deepai-connector: locale dictionaries"
      );
    } catch {
      registerDictionaries(ctx);
    }
  } else {
    registerDictionaries(ctx);
  }
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "dsh-deepai-connector",
        order: 14,
        locale: NS,
        label: () => text("nav")
      },
      DeepAISettings
    )
  );
}
var inject = ["slots", "locale"];

    return module.exports;
  }
});
//# sourceMappingURL=client.js.map
