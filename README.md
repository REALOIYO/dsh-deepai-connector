# dsh-deepai-connector

把 DeepAI Code 的上游模型接入 DeepSeek Harness。**不需要安装 DeepAI Code 桌面端，也不需要跑额外的网关进程**：取 Key 走浏览器 OAuth，推理由插件进程直连上游，在「设置 → DeepAI Code」里完成一次登录即可。

结构与 `dsh-qwenwork-connector` 一致：插件自带账号存储、设置页与 REST 路由，注册成 `dsh-llm` 的 `LlmAdapter`。

## 它做的事

- 浏览器 OAuth 拿 Key（RFC 8252 本机回调，与桌面端同款流程），没有桌面端也能登录；
- 复刻上游要求的请求头形状：`Api-Key` 鉴权、车道版本、进程实例号、机器指纹、`User-Agent: node`；
- 推理前自动完成签到（`/theos` 拉 nonce 再回传），这是上游判定「真客户端」的关键；
- **自己拼请求体、自己读 SSE**，不引任何 LLM SDK：上游会以 `400 This request is not one DeepAI Code sends.` 拒绝异形请求体，命中后按桌面端字段白名单重排一次；
- 模型目录完全由上游下发，插件只做缓存。

协议细节来自 [2951461586/DeepAICode2API](https://github.com/2951461586/DeepAICode2API) 的逆向实现。

## 装法

```bash
# 在 DSH profile 目录里
cd ~/.dsh/profiles/desktop
pnpm add link:<本仓库路径>
```

或在「设置 → 插件」里从本地目录安装。装完重启 DSH。

## 首次使用

1. 打开「设置 → DeepAI Code」，点「登录」；
2. 复制授权链接到浏览器，用 **Google 或 Apple** 账号完成授权；
3. 回到设置页，状态变「已登录」后模型出现在选择器里。

## 已知限制

- **账号要求**：上游自 0.3.19 起只允许 Google/Apple 登录的账号推理。邮箱密码账号会拿到 `403 social_login_required`，重试或换出口都无效。
- **每日额度按出口 IP 发放**：同一网络下的免费额度是共享池子，领完要等上游给的刷新时间（`403 network_bound` 带 `refresh_at`）。
- **签到是有限资源**：当天重启签到次数用尽会拿 `403 check_in_refused`，之后推理仍可用，但可能落到替身后端。
- **可能落到替身分支**：即使协议全对，上游也可能把请求转到一条替身后端。判据是响应里的 `provider` 字段——等于 `"DeepAI"` 就是替身。状态码仍是 200，光看状态码发现不了。
- **协议会变**：上游每抬一次车道版本就把旧值一律回 `426`。插件内置车道探测，但大改仍需跟进。

## 关于封号

插件的设计目标是**只用自己的账号、不做批量注册、不伪造机器指纹**：

- 机器指纹读本机真实 UUID（Windows 取 `Win32_ComputerSystemProduct.UUID`，回落到 `MachineGuid`），可用 `DEEPAI_MACHINE_ID` 覆盖；
- 签到按上游给的最小间隔节流，命中 `check_in_refused` 后静默锁 6 小时，不会反复撞接口；
- 不带浏览器指纹头（`sec-ch-ua` 等），那会让请求被识别成非客户端。

这些降低的是「被判定为非客户端」的概率，不构成对封号的保证。上游的处置一贯是降级（换后端、拒绝该次请求、收窄账号资格），插件也没有绕过额度限制的逻辑。

## 开发

```bash
# esbuild 是构建期依赖，不写进 package.json
DEEPAI_ESBUILD=<esbuild 目录> node build.mjs
node --test "test/*.test.ts"        # 65 个用例
```

产物：`lib/index.js`（Host，ESM）+ `lib/client.js`（浏览器，CJS，套 `window.__ModuleLoader__.load` 外壳）。

测试直接跑 `src/` 下的 `.ts`（Node 22.18+/24 原生支持），不依赖构建产物。

## 目录

```text
src/index.ts              插件入口：注册适配器、挂 REST 路由
src/adapter/protocol.ts   上游协议常量与请求头
src/adapter/machine.ts    机器指纹（三平台）
src/adapter/auth.ts       浏览器 OAuth + 凭据落盘
src/adapter/client.ts     上游客户端：签到状态机、chat 请求、错误语义
src/adapter/body.ts       请求体构造 + 形状兜底
src/adapter/sse.ts        SSE 逐帧解析 + chat delta 提取
src/adapter/stream.ts     SSE → DSH chunk 翻译
src/adapter/catalog.ts    模型目录缓存
src/adapter/deepai.ts     LlmAdapter 实现
src/client/               设置页（slots.inject('settings.section')）
```

## License

MIT
