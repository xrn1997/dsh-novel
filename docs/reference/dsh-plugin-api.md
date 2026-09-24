# DSH out-of-tree 插件 API 调研

- 日期：2026-09-14
- 证据来源（均为本机已安装产物，路径可复核）：
  - 官方样例插件：`C:\Users\57224\.dsh\profiles\web\node_modules\{dsh-context,dsh-better-sidebar,dsh-better-archive}\`
  - Host checkout（dsh CLI + 全部官方运行时包）：`C:\Users\57224\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`
  - 官方包类型定义：`…\@deepseek-ai\dsh\node_modules\@deepseek-ai\{dsh-host-webserver,dsh-tools,dsh-client-ui-conversation,dsh-client-ui-chat,dsh-client-ui-trajectory,dsh-client-modules}\lib\types\**\*.d.ts`
  - CLI 插件管理源码：`…\@deepseek-ai\dsh\lib\plugin-Ddi42qoW.js`
  - 上游 tsdown/tsconfig 配置（GitHub raw，作为构建形态的补充证据）：
    - https://raw.githubusercontent.com/bowenliang123/dsh-context/main/tsdown.config.ts
    - https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/tsdown.config.ts
    - https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/tsconfig.json
- 本机版本快照（**2026-09-23 复核，宿主实跑 `dsh --version` = 0.1.7-rc.1**）：host checkout `@deepseek-ai/dsh` **0.1.7-rc.1**，其内嵌官方包同号（`dsh-tools` / `dsh-client-modules` / `dsh-client-ui-*` / `dsh-jobs` / `dsh-jobs-local` / `dsh-tool-jobs` / `dsh-client-ui-jobs` / `dsh-base` 全 0.1.7-rc.1；`@deepseek-ai/cordis` 4.0.4、`@deepseek-ai/schemastery` 3.18.4）。本仓 devDependency 已对齐这批号（`@deepseek-ai/dsh-tools` 精确钉 `0.1.7-rc.1`，`tests/packaging.test.ts` 钉住「不早于 `dshReleases` 里最高宿主」）。调研当时（2026-09-14）为 host 0.1.5-rc.1 + 样例插件 0.1.5-rc.2——**下文各节的行号证据属那一代**，逐项复核结论写在对应节（§9/§10 与「风险与不确定项」各带复核戳）。
- **官方文档站（2026-09 复核补充，本节 §9/§10 的主要来源）**：`https://deepseek-harness.github.io/deepseek-harness/`，逐页读的是 `reference/subsystems/{jobs,slots,conversation,web-client,session-projection,schedule}`、`reference/api-gateway`、`reference/capability-seams`。静态 HTML，可 curl 后本地读全文。
- **本机 host checkout 路径与上文 57224 那台机器不同**：本机是 `C:\software\nodejs\node_modules\@deepseek-ai\dsh\`，官方运行时包在其 `node_modules\@deepseek-ai\` 下（`dsh-jobs`、`dsh-jobs-local`、`dsh-client-ui-jobs`、`dsh-client-ui-layout`、`dsh-cordis-client-runner` 等）。§9/§10 的证据一律给「文档站原文 + 本机包内可 grep 的符号」。

---

## 1. 插件包形态（package.json / cordis.patch.yml / 安装链路）

### 结论

一个 out-of-tree 插件是一个普通 npm 包，双面（Node 半 + 浏览器半）同包。必需/关键字段：

| 字段 | 作用 | 必需性 |
|---|---|---|
| `main: "lib/index.js"` | Node 半入口（Cordis 插件） | 必需 |
| `types` | Node 半类型（可选但推荐） | 推荐 |
| `exports["."]` | 同 main；`exports["./client"]` 指向浏览器半 bundle | 客户端面必需 |
| `dsh.client.platform: "web"` | 宣告浏览器半；非 `"web"` 的包被 client-modules 扫描忽略 | 客户端面必需 |
| `dsh.client.inject: string[]` | 浏览器半启动前需就绪的其他 client 包（信息性依赖边，参与 boot graph 排序） | 推荐 |
| `dsh.client.external: string[]`（可选）、`dsh.client.immediately: boolean`（可选） | 额外的模块表请求 / 立即加载 | 可选 |
| `dsh.bundle.patch: "./cordis.patch.yml"` | 指向随包发布的挂载层；`dsh plugin add` 靠它识别「这是一个 profile layer」 | 自动挂载必需 |
| `files` | 必须包含 `lib/**`、`cordis.patch.yml` | 发布必需 |
| `peerDependencies` | `@deepseek-ai/cordis` 等官方包 + react/react-dom | 必需（见 §2） |

**注意：规范里猜测的顶层 `dsh.bundle.patch` / `dsh.client` 平铺写法实际是嵌套对象 `dsh: { bundle: { patch }, client: { … } }`。**

### 证据 1a：dsh-context 的 package.json（`…\profiles\web\node_modules\dsh-context\package.json`）

```json
"type": "module",
"main": "lib/index.js",
"types": "lib/index.d.ts",
"exports": {
  ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
  "./client": "./lib/client.js",
  "./package.json": "./package.json"
},
"files": ["lib/client.js", "lib/index.js", "lib/index.d.ts", "cordis.patch.yml", "README.md", "LICENSE"],
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-sidebar-right"
    ],
    "platform": "web"
  },
  "compatibility": { "dshReleases": { "0.1.5-rc.1": "compatible", ... } }
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.2",
  "@deepseek-ai/dsh-client-ui-primitives": ">=0.1.2-rc.1",
  "@deepseek-ai/dsh-session": ">=0.1.2-rc.1",
  "@deepseek-ai/dsh-settings": ">=0.1.2-rc.1",
  "@deepseek-ai/schemastery": "^3.18.2",
  "react": "^18.3.1"
},
"peerDependenciesMeta": { "@deepseek-ai/dsh-client-ui-primitives": { "optional": true }, "react": { "optional": true } }
```

dsh-better-archive 的最小形态（`…\dsh-better-archive\package.json`）更精简：`main`/`exports`/`dsh.bundle.patch`/`dsh.client{inject,platform}`，peer 只有 `@deepseek-ai/dsh-client-locale` + `@deepseek-ai/cordis`。

### 证据 1b：cordis.patch.yml 真实格式

dsh-context（`…\dsh-context\cordis.patch.yml`）——顶层是 YAML **数组**，每项是 loader patch 条目，bundle patch 就是一条 `insert`：

```yaml
- insert:
    - id: dsh-context
      name: dsh-context
```

dsh-better-sidebar（`…\dsh-better-sidebar\cordis.patch.yml`）——insert 行可带 `config:`（传给 apply 的配置，经插件导出的 Config schema 校验/填默认值），还可用 `!!js` 表达式做条件禁用（防双挂载）：

```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)"
```

profile 根的 cordis.patch.yml（`…\profiles\web\cordis.patch.yml`）同样是「顶层 YAML 数组」，注释写明：`The tree is composed as patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays`。

profile 清单（`…\profiles\web\package.json`）：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-context", "dsh-better-sidebar", ...], "patchReload": "live" } }
```

### 证据 1c：`dsh plugin --profile web add <pkg>` 的行为

源码 `…\@deepseek-ai\dsh\lib\plugin-Ddi42qoW.js`（模块注释）：

> `dsh plugin --profile <name> <args...>` — profile plugin management as a thin pnpm forwarder: initialize the profile on first use, run `pnpm <args...>` in the profile directory, then reconcile the `dsh.profile.bundles` layer list against the installed state (a dependency resolving to a package that declares `dsh.bundle` joins the layer stack; a removed or bundle-less dependency leaves it).

要点：

- 它就是 **pnpm 转发器**：在 profile 目录跑 `pnpm add …`；相对路径 spec（`.`、`../plugin`、`file:`/`link:` 形式）会按调用者 cwd 锚定绝对化（`anchorPathSpec`，防 `add .` 把 profile 自链接）。
- 装完后 `reconcilePlugins`：逐个检查已安装依赖是否 `dsh.bundle.patch !== undefined`（`exportsPatch`），是则把**真实包名**追加进 `dsh.profile.bundles`；无 `dsh.bundle` 声明的包只警告「installed as a plain dependency」。
- 卸载（`remove`）后同一 reconcile 把它从 bundles 移除。
- 生效时机：下次 profile boot 合并 patch（`patchReload: "live"` 时可热重载）。
- git 托管插件 install 时 prepare 脚本需 pnpm allowBuilds 放行（错误信息有提示）。

### 对 dsh-novel 的直接含义

- package.json 照抄 dsh-context 骨架：`main: lib/index.js`、`exports["./client"]: ./lib/client.js`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client: { inject: [...], platform: "web" }`。
- `cordis.patch.yml` 两行：`- insert: [{ id: dsh-novel, name: dsh-novel }]`（name 必须等于 package.json `name`，client-modules 以包名作为 bundle id 组图）。
- 安装验证命令就是 `dsh plugin --profile web add <本地路径>`（绝对化后 pnpm link 式安装），一次到位，无手工编辑。

---

## 2. Node 半入口（Cordis 插件）

### 结论

Node 半是一个 ESM 模块，导出三件套：`name`（可选标识）、`inject`（字符串数组，挂载前必须就绪的服务名）、`apply(ctx, config)`。`ctx` 是 `@deepseek-ai/cordis` 的 `Context`；服务通过 `ctx.webServer`、`ctx.tools`、`ctx.sessions` 等属性访问（Cordis 服务注入模型）。配置由插件**导出的 Config schema**（zod 或 schemastery）校验——cordis loader 拿 `export Config` 校验 patch 行的 `config:` 并填默认值。

### 证据 2a：dsh-context 编译产物类型（`…\dsh-context\lib\index.d.ts:726-730`）

```ts
//#region src/host/index.d.ts
export declare const name = "dsh-context";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
```

其 Config 是 zod schema（同文件 26-33 行：`export declare const Config: z.ZodPreprocess<…>`，注释：「The cordis `Config` validator: strict on keys, defaults on the schema fields; tolerates `undefined` (a patch row without a `config:` block — defaults win)」）。`Context` 来自 `import { Context } from "@deepseek-ai/cordis"`。

### 证据 2b：dsh-better-sidebar 源码（`…\dsh-better-sidebar\src\index.ts:79-83, 722`）

```ts
/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-better-sidebar'
/** Services required before mounting: the webserver routes, the session store, the web runtime's trusted hosts, and the tool registry. */
export const inject = ['webServer', 'sessions', 'webRuntime', 'tools']
…
export function apply(ctx: Context, config?: SidebarConfig): void { … }
```

其 Config 用 schemastery（`src\config.ts:8`：`import z from 'schemastery'`；`SidebarConfig` 全字段可选，`resolveSidebarConfig` 为绕过 loader 的直调方填默认值）。

可选服务用 `ctx.inject(['settings'], (sctx) => {…})` 惰性挂接（`src\index.ts:801`）；`ctx.effect(() => disposer, label)` 管理生命周期；`ctx.get('sessionPersistence')` 做非侵入读取（`src\index.ts:132`）。

### 证据 2c：类型冲突的规避（`…\dsh-better-sidebar\src\context-types.ts:1-14`）

官方包已经对 `@deepseek-ai/cordis` 做 declare module 增强，且同一服务名在 host/client 两侧类型不同（`sessions: SessionStore` vs `ISessions`）；better-sidebar 的做法是「vendored cordis Context + 结构镜像接口求交集」而非 module augmentation，避免 TS2717。**直接含义**：dsh-novel 若单包双半共用类型，采用同样策略（或干脆 host/client 类型分开，client 只 import type）。

### 证据 2d：peerDependencies 惯例

三个样例全部把 `@deepseek-ai/cordis`、用到的 `@deepseek-ai/dsh-*` 服务包、`react`/`react-dom` 放 peerDependencies；npm 侧普通依赖（`ws`、`clsx`、`mermaid` 等）放 dependencies。**直接含义**：dsh-novel peer 至少声明 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-client-ui-primitives`、`react`、`react-dom`；`cheerio`/`iconv-lite` 放 dependencies。（**2026-09-24 更正**：原列表里的 `@deepseek-ai/dsh-client-ui-conversation` 已删——对话区 tab 注册 2026-09 撤出、浏览器半运行时不 import 它（§5 的那个座位已不是本插件的面），留着等于推荐声明一个用不上的包。）

---

## 3. HTTP 路由（`ctx.webServer`）

### 结论

`@deepseek-ai/dsh-host-webserver` 提供 `ctx.webServer.register(route)`：

```ts
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
    kind: WebRouteKind;                    // 'exact' 精确匹配 pathname；'prefix' 匹配 p 和 p/<anything>
    path: string;                          // 绝对路径，无尾斜杠
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;  // Node 原生 http 类型
}
register(route: WebRoute): () => void;     // 返回 disposer；重复 (kind, path) 直接 throw
```

- **req/res 就是 Node 原生 `http.IncomingMessage` / `ServerResponse`**，handler 拥有完整响应生命周期（可 SSE、可流式）。
- 读 query：`new URL(req.url ?? '/', 'http://dsh.internal').searchParams`；读 body：自己 `for await (const chunk of req)` 聚合后 `JSON.parse`（官方样例全部手写 bounded readJsonBody，无内建 body parser）。
- 返回 JSON：`res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body))`。
- 注册一律包在 `ctx.effect(() => ctx.webServer.register(…), label)` 里，卸载自动摘路由。

### 证据 3a：类型定义（`…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-webserver\lib\types\index.d.ts:30-46,85-97`）

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
…
/** Register a named route. Duplicate (kind, path) throws … @returns the disposer removing the route. */
register(route: WebRoute): () => void;
```

（同文件 `import type { IncomingMessage, ServerResponse } from 'node:http'`；`declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }`。）

### 证据 3b：prefix 路由真实用例（`…\dsh-better-sidebar\src\index.ts:884-913`）

```ts
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/sidebar/api',
  handler: async (req, res) => {
    if (!fence(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden', … } }); return }
    if (req.method !== 'POST') { writeJson(res, 405, …); return }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = pathname.startsWith('/sidebar/api/') ? pathname.slice('/sidebar/api/'.length) : undefined
    …
    const payload = await readJsonBody(req)      // for await (const chunk of req) 聚合，1MiB 上限
    writeOk(res, await handler(payload))          // { ok: true, value }
  },
}), 'dsh-better-sidebar: /sidebar/api routes')
```

`exact` 路由 + query 读法（同文件 921-954 行 `/sidebar/upload`）：`kind: 'exact'`，`url.searchParams.get('sessionId')`。JSON/body 帮手在 `src\wire.ts`：`readJsonBody`（`for await` + 1MiB 上限）、`writeJson(res, status, body)`、`writeOk`（`{ok:true,value}` 200）、`writeError`（`SidebarError(code, message, status)` → `{ok:false,error:{code,message}}`）。

### 证据 3c：最小版 exact 路由（`…\dsh-better-archive\lib\index.js:371-404`）

```js
function registerRoute(ctx, { path, method = 'POST', fields = [], run }) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== method) return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      …
      sendJson(res, 200, await run(params, body))
    },
  }), `better-archive: ${path} route`)
}
```

其信任检查是最简同源判定（55-63 行）：`new URL(req.headers.referer).host === req.headers.host`。better-sidebar 则用更严的 `webRuntime.trustedHosts` fence（`src\index.ts:736`，Host 头 loopback 或 `--trusted-host` 白名单）。

### 对 dsh-novel 的直接含义

- `/novel-api/*` 用 `kind: 'prefix', path: '/novel-api'` 一条路由 + 内部分发（或按子面拆多条 exact）。**前缀重复会 throw，整棵插件树 boot 失败——前缀命名是组合级契约**。
- query/body/JSON 全手写：拷 `wire.ts` 的 readJsonBody/writeJson 三件套即可；错误统一 `{code,message,segment?}` 信封映射到 HTTP 状态码。
- **必须加同源/信任 fence**（referer/host 判定即可起步），否则同机任意网页可 POST 你的路由。
- 注册裹 `ctx.effect`，工具注册同理（disposer 模式全插件通用）。

---

## 4. agent 工具注册（`defineTool` + `ctx.tools.register`）

### 结论

从 `@deepseek-ai/dsh-tools` import `defineTool`，`ctx.tools.register(tool)` 返回 disposer。工具定义（`DefineToolOptions<S, O>`）：

- `name: string`（唯一）、`description: string`（发给模型）
- `parameters: ParameterSchemaSpec`——**每属性一个值 schema spec**：`{ type: 'string'|'number'|'integer'|'boolean'|'null'|'array'|'object'|'json', required?: true, description?, enum?, … }`；根对象隐式开放，必填靠属性上 `required: true`（不是 JSON Schema 的 required 数组）
- `output: { schema: O（同一套值 schema DSL）, render(args, value): ContentBlock[], presentationMeta?(args, value) }`——**强制**声明规范输出 schema；`execute` 返回符合 schema 的纯 JSON 值，`render` 是纯文本投影
- `execute(args, exec: ToolRunContext): Promise<unknown>`——`args` 已校验冻结；`exec.agent`（调用 agent，可 undefined）、`exec.signal`（AbortSignal，spawn 前 `throwIfAborted()`）、`exec.deferContext()`/`exec.concludeTurn()`
- 可选 `timeoutMs`、`isConcurrencySafe`、`presentCall`/`presentResult`

### 证据 4a：类型（`…\dsh-tools\lib\types\schema.d.ts:177-193`；`…\dsh-tools\lib\types\index.d.ts:97-119,284-301`）

```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string;
    readonly description: string;
    readonly parameters: S;
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    readonly timeoutMs?: number;
    …
}
// ToolDefinition:
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
// ToolRunContext extends ToolExecution:
    readonly agent?: Agent;          // 调用方 agent（agent loop 设置）
    readonly signal: AbortSignal;    // 调用方取消
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
// Context augmentation:
    interface Context { tools: ToolRuntime }
    register(definition: ToolDefinition): () => void;   // ToolRuntime.register，index.d.ts:601
```

### 证据 4b：真实用例（`…\dsh-better-sidebar\src\tools.ts:15-16, 83-138`）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
…
const register = (tool: ReturnType<typeof defineTool>): void => { disposers.push(ctx.tools.register(tool)) }
register(defineTool({
  name: 'terminal_create',
  description: 'Open a persistent terminal in the sidebar and run a command in it. …',
  parameters: {
    title: { type: 'string', required: true, description: '…' },
    command: { type: 'string', required: true, description: '…' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      uuid: { type: 'string', required: true, description: '…' },
      title: { type: 'string', required: true, description: '…' } } },
    render: textRender((v: { uuid: string; title: string }) => `Opened terminal "${v.title}" (uuid: ${v.uuid}). …`),
  },
  execute: async (args: { title: string; command: string }, exec) => {
    exec.signal.throwIfAborted()
    const sessionId = requireAgent(exec.agent).session.id   // 绑定调用方 session，模型不传 sessionId
    …
    return { uuid, title: args.title }                       // 返回符合 output.schema 的纯 JSON
  },
}))
```

同文件注释总结了官方约定（引 plugin-development-guide.md §3）：C1 参数先校验后 execute；C4 execute 返回唯一规范 JSON，render 只做投影；C6 spawn 前 `exec.signal.throwIfAborted()`；C10 规范值不带 UI/传输词汇。`render` 返回 `ContentBlock[]`（`[{ type: 'text', text }]`，来自 `@deepseek-ai/dsh-llm`）。

### 对 dsh-novel 的直接含义

- 6 个工具（全锁 `dshnovel_` 前缀）全走 `defineTool`；**返回值是规范 JSON**（正文长就让它长，description 里说明），模型面文本由 `render` 投影。
- 工具内不要模型传 sessionId——用 `exec.agent.session.id`（better-sidebar 全部工具如此）；这正是「阅读状态进 session」的正确挂点。
- 注册函数返回 disposer：把 6 个工具的注册包一个 `registerTools(ctx, service)` 返回 `() => void`，apply 里 `ctx.effect(() => registerTools(…))`。
- 输出 schema 用同一套 spec DSL（`oneOf` 也支持，见 terminal_wait_for 的四分支输出）。

---

## 5. 对话视图环注册（浏览器半）

### 结论

设计规格里猜的 `ctx.uiConversation.views.register({ target: 'novel', … })` **部分正确但不完整**——对话区顶部 tab 的注册走的是 **slots 系统**，不是 uiConversation。完整拼图（第一方 Chat/Trajectory 的做法，两步都在浏览器半 client 入口里做）：

**第 1 步（tab + 组件挂载）**：`ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id, order, label, locale?, children?, store?, inject: (sessionId) => ({ hooks, …props }) }, ViewComponent))`。tab 列表就是 `slots.entries('conversation.view')` 各 entry 的 `{ id, label }` 投影；壳层 `renderSlot("conversation.view", { viewRequest, openView, completeViewRequest }, { only: active.id })` 渲染当前激活 tab 的组件。

**第 2 步（会话事件 → 快照投影，可选）**：如果 view 要消费会话事件流，注册 `ctx.uiConversation.events.register(nodeDefinition)`（事件→节点状态机）和 `ctx.uiConversation.views.register({ target, create: () => builder })`（per-session 增量快照 builder：`{ empty, replace({nodes, timeline}), apply({upserts, timeline}) }`）。数据经 `ctx.uiConversation.binding(sessionId).target(target)` 的 `ObservableSnapshot` 读取。**若 novel view 是独立应用（数据来自 /novel-api，不投影会话事件），第 2 步可整体跳过**——`activateTarget` 对未注册 target 宽容（见证据 5c）。

### 证据 5a：Trajectory 的两步注册（`…\dsh-client-ui-trajectory\lib\client.js:1522-1533, 8224-8251`）

```js
// 第 2 步：快照 builder
const trajectoryViewDefinition = { target: "trajectory", create: () => new TrajectorySnapshotBuilder() };
function registerTrajectoryConversationView(ctx) { ctx.uiConversation.views.register(trajectoryViewDefinition); }

// 第 1 步：tab + 组件
ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "trajectory",
    order: 10,
    locale: NS,
    label: () => t("view.trajectory"),
    children: { "conversation.trajectory.images": { kind: "single", scope: "session" } },
    inject: (sessionId) => {
        const session = ctx.sessions.binding(sessionId)?.session;
        const trajectory = ctx.uiConversation.binding(sessionId).target("trajectory");
        return { hooks: { duration }, loadOlder: async () => {…}, loadImage: …, setActualDuration: … };
    }
}, TrajectoryView));
```

Chat 同构（`…\dsh-client-ui-chat\lib\client.js:8288-8312`：`id: "chat", order: 0`）；Chat 另注册十几条 `ctx.uiConversation.events.register(…)` 事件定义（4630-6675 行）。

### 证据 5b：类型（`…\dsh-client-ui-conversation\lib\types\client\index.d.ts:28-35`；`…\conversation\assembly.d.ts:31-49`；`…\contract\conversation.d.ts:215-247`）

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        conversation: IConversation;             // send/cancel/loadOlder 等会话动作
        uiConversation: UiConversation;          // { events: ConversationEventRegistry, views: ConversationViewRegistry, binding(sessionId) }
    }
}
class UiConversation extends Service {
    readonly events: ConversationEventRegistry;
    readonly views: ConversationViewRegistry;    // views.register(def) → disposer
    binding(source): ConversationBinding;        // { snapshot, activate(target), target(target) }
}
interface ConversationViewDefinition<Node, Snapshot> {
    readonly target: string;
    create(): ConversationViewBuilder<Node, Snapshot>;   // { empty, replace({nodes,timeline}), apply({upserts,timeline}) }
    isActive?(snapshot: Snapshot): boolean;
}
```

组件 props：`ConvViewProps = PropsRuntime<'conversation.view'>`（`…\contract\slots.d.ts:290-297`，含 `viewRequest: ConversationViewRequest | null`、`openView: (view, focus) => void`、`completeViewRequest`）。

### 证据 5c：壳层如何消费 tab（`…\dsh-client-ui-conversation\lib\client.js:15085-15129, 16542-16557, 1731-1739`）

```js
// tab 列表 = conversation.view slot entries
for (const entry of slots.entries("conversation.view")) { tabs.push({ id: entry.options.id, label: resolveSlotLabel(entry.options.label) ?? entry.options.id }) }
// 选中时激活 target（未注册 views 定义的 target 也被容忍：view === undefined 直接返回）
activateView = (sessionId, preferred) => { const active = resolveActiveView(viewTabs(), preferred); if (active !== void 0) uiConversation.binding(sessionId).activate(active.id) }
// 渲染当前 tab 的组件
children: active !== void 0 && renderSlot("conversation.view", { viewRequest, openView, completeViewRequest }, { only: active.id })
```

`activateTarget(target)`（1731-1739 行）：`const view = this.views.get(target); … if (view === void 0) return published;`——**只注册 slot、不注册 views 定义完全合法**。

### 对 dsh-novel 的直接含义

- ~~「小说」tab = client 入口里 `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'novel', order: 20, label: () => '小说' }, NovelView))`~~ **已废止（2026-09）**：小说视图迁到全局面板（`sidebar.panellist` + `main`，见 §10 证据 10c），`conversation.view` 注册已撤除。此条保留作**宿主契约参考**——若将来还要在对话区开自己的 tab，形态仍是上面这句；`label` 可以是函数（走 locale）也可以直接字符串。
- **不需要** `uiConversation.views.register` / `events.register`——novel view 是独立应用，从 `/novel-api` 拉数据；`activateTarget` 对无定义 target 宽容已被第一方代码证实。规范 §10 的「snapshot builder 空投影」开放问题可以关掉：走 slot-only 路线。
- 从 view 内部发起会话动作用 `ctx.conversation.send(text)`（`IConversation`，`…\service.d.ts:38`）——「阅读状态进 session」如需反向注入可用它或 agent 工具面。
- 全局阅读进度不随 session 切换：view 组件自持 store，slot 的 `inject: (sessionId) => …` 只在需要 session-scoped 数据时用。

---

## 6. 浏览器半入口（加载机制与可用模块）

### 结论

- 客户端 bundle（`lib/client.js`）是 **CJS closure-factory 单文件脚本**，首行 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {…} })`，尾部 `return module.exports; } });`。bundle 内所有 `require('…')` 由宿主冻结模块表解答。
- 运行时链路（`@deepseek-ai/dsh-client-modules`，host 侧服务 `clientModules`）：扫描 Loader 里所有声明 `dsh.client` 且 `platform === 'web'` 的包 → 读 `exports['./client']` 拿 bundle 路径（**声明了 dsh.client 但 exports 没有 './client' 直接 throw**）→ 组 `window.__DSH_BOOT__` 图（按 `dsh.client.inject` 拓扑排序）→ 在 webserver 注册 `kind:'prefix', path:'/plugins'` 路由供浏览器拉 bundle（immutable 缓存 + 12 位 hash 版本）→ index-inject 注入 boot 脚本。
- 浏览器半入口同样导出 `apply(ctx)`（+ 可选 `inject` 字符串数组），以浏览器 Cordis 插件身份运行；可用服务即客户端运行时提供的：`slots`、`sessions`、`locale`、`modules`、`connection`、`conversation`、`uiConversation`、`settings` 等。
- **可 import 的运行时值被「纯度门」限制**：模块表种子 = `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`（或 `cordis`）、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`（+ 本包 `dsh.client.external` 声明）。其余 `@deepseek-ai/*` 值 import 是**构建错误**（跨插件协作走 cordis 服务，type-only import 可自由用）；白名单内少数 wire 层（`dsh-session`/`dsh-llm`/`dsh-tools`/`dsh-brand`/`dsh-file-reference`/`util-workspace-path` 等）允许 inline。npm 依赖（clsx、marked、xterm…）一律 inline 进 bundle。

### 证据 6a：client-modules 扫描与校验（`…\dsh-client-modules\lib\index.js:139-166, 481-491, 649-655`）

```js
function parseDshClient(pkgName, value) {
    if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
    …
}
…
const decl = parseDshClient(packageName, dsh?.client);
if (decl === void 0 || decl.platform !== "web") { …return null }
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
…
webCtx.webServer.register({ kind: "prefix", path: "/plugins", handler: this.serveBundle })
ctx.on("webserver/index-inject", (table) => { table.push(...bootInjections(this.composed)) })
```

### 证据 6b：bundle 形态与模块表（`…\dsh-better-sidebar\lib\client.js:1-33`）

```js
window.__ModuleLoader__.load({
	id: "dsh-better-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		…
		let react = require("react");
		let react_dom_client = require("react-dom/client");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
```

（tsdown 配置确认 banner/intro/footer 三段式与 external 名单，见上游 tsdown.config.ts；注释明言 PLATFORM_MODULES「Mirrors packages/client/web/src/platform.ts in deepseek-harness: the shell seeds these specifiers into the frozen browser module table」。）

### 证据 6c：client 入口的 inject 与 apply（`…\dsh-better-sidebar\src\client\index.tsx:44, 57`）

```ts
export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection']
…
export function apply(ctx: Context): void {
  ctx.effect(() => { const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh); … return () => { offZh(); offEn() } }, 'dsh-better-sidebar: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: "settings.section", id: … }, Component))
```

### 对 dsh-novel 的直接含义

- client 入口 `src/client/index.tsx` 导出 `apply(ctx)`（本插件不碰 locale/connection 可只 inject `['slots','sessions']`）。
- React 组件直接 `import { … } from '@deepseek-ai/dsh-client-ui-primitives'`（模块表解答）；**不要**从任何第三方 dsh 插件包 import 运行时值——纯度门会拒绝，且这是设计红线。
- 自己的 npm 依赖（若有浏览器端用的）会被 inline，无需声明。
- tsdown 配置必须复刻三段式 banner/footer；照抄 dsh-context/tsdown.config.ts 是最稳路线（含 CSS 通道与 define 注入）。

---

## 7. 构建形态

### 结论

- **构建工具：tsdown**（rolldown 内核），三件套：
  1. host 半：`entry: { index: 'src/index.ts' }`，`format: ['esm']`，`platform: 'node'`，`target: 'es2024'`，`dts: true`（dsh-context）——产物 `lib/index.js`（+ `lib/index.d.ts`）。
  2. client 半：`entry: { client: 'src/client/index.tsx' }`，`format: 'cjs'`，`platform: 'browser'`，`dts: false`，`sourcemap: true`，banner/footer 包成 `__ModuleLoader__.load` 工厂，`codeSplitting: false`，`define` 注入 `process.env.NODE_ENV`/`import.meta.env`，external=PLATFORM_MODULES 其余全 inline——产物 `lib/client.js`。
  3. （可选）懒 chunk：`lib/client-<name>.js`，`globalThis.__dshChunks__[name] = (require) => {…}` 形态，经插件自己的 bundle 路由按需 fetch（better-sidebar 的 terminal/editor/mermaid/locale 四个 chunk）。
- 类型产物：dsh-context 用 tsdown `dts: true` 直出；better-sidebar 用 `tsc -p tsconfig.build.json` 出 `lib/types/**/*.d.ts`（types 字段指过去），再 tsdown。
- **tsconfig 基线**（better-sidebar，GitHub raw）：`target ES2023, module esnext, moduleResolution bundler, jsx react-jsx, strict, noUncheckedIndexedAccess, verbatimModuleSyntax, allowImportingTsExtensions, noEmit, types: ["node"]`。源码 import 一律写全扩展名（`./config.ts`）。
- 脚本惯例：`build: tsdown`（better-sidebar 为 `rm lib && tsc -p tsconfig.build.json && tsdown`）、`watch: tsdown --watch`、`typecheck: tsc --noEmit`、`test: vitest run`。

### 证据 7a：dsh-context package.json scripts

```json
"scripts": { "build": "tsdown", "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.tests.json", "test": "pnpm run typecheck && vitest run --coverage" },
"devDependencies": { "tsdown": "^0.23.0", "typescript": "^7.0.2", "vitest": "^4.1.11", … }
```

### 证据 7b：产物文件名（`…\dsh-context\` 目录清单）

```
lib\client.js   lib\index.d.ts   lib\index.js   cordis.patch.yml
```

better-sidebar 产物：`lib\index.js` + `lib\client.js` + `lib\client-{editor,mermaid,registry,terminal}.js` + `lib\types\**\*.d.ts`。

### 对 dsh-novel 的直接含义

- 规范定的「tsdown 构建，lib/index.js + client.js」与官方一致；tsdown 配置直接抄 dsh-context 的（它的 purity gate/PLATFORM_MODULES/define 注释就是官方 preset 的镜像）。
- `pnpm run build` 必须在 `dsh web` 启动前跑——client-modules 找不到 `lib/client.js` 会聚合报错「client bundle not found; run `pnpm run build` before launch」（`…\dsh-client-modules\lib\index.js:91-104`）。

---

## 8. 运行时注入：浏览器半如何知道 API base

### 结论

**不需要知道任何 base——同源根相对路径直接 fetch。** web GUI 与插件路由同属一个 webServer（同一 origin），浏览器半直接 `fetch('/novel-api/sources')` 即可。没有 API base 注入机制，也没有前缀发现 API：前缀是插件与自己 client 半之间的**代码级约定**（双方都写死 `/novel-api`）。CORS 不存在（同源）。宿主对你的 HTTP 面唯一做的是 client-modules 把 client bundle 挂在 `/plugins/*`；插件自己的路由挂在自己声明的前缀下。

### 证据 8a：better-sidebar client 直接 fetch 根相对路径（`…\dsh-better-sidebar\src\client\api.ts:1-7, 154`）

```ts
/** Typed fetch wrapper over the /sidebar JSON API. Every call posts to `/sidebar/api/<method>` … */
response = await fetch(`/sidebar/api/${method}`, { … })
```

### 证据 8b：better-archive client 同样（`…\dsh-better-archive\lib\client.js:373, 610`）

```js
return fetch('/archived/unarchive', { … })
return fetch('/archived/pending')
```

Node 半头注释（`…\dsh-better-archive\lib\index.js:30-32`）：「The browser half (lib/client.js) is discovered by client-modules through the `dsh.client` declaration in package.json and calls these routes with plain fetch (same origin as the web app).」

### 对 dsh-novel 的直接含义

- client 侧写一个 `api.ts`：`fetch('/novel-api/' + path, …)` + 统一错误信封解析，照抄 better-sidebar `src/client/api.ts` 的形态。
- 无需读取任何运行时配置；唯一约定是前缀字符串两边一致。若担心前缀冲突，`/novel-api` 已足够独特。

---

## 9. 后台任务与进度投递（ctx.jobs 与三条通道）

### 结论

宿主有**一等公民的后台任务运行时**：`ctx.jobs`（Service Definition 在 `@deepseek-ai/dsh-jobs`，进程内实现是 `@deepseek-ai/dsh-jobs-local` 的 `LocalJobRegistry`）。它管身份、访问权与生命周期，生产方保留执行资源——正是本插件 `services/import-job.ts` 里 `SourceJobs` 自造的那一套的官方版。

但它**没有连续进度通道**。官方 `reference/subsystems/jobs` 页与本仓实测一致：`JobSnapshot.detail` 注释「usually terminal」，`onJobsChanged` 只在「注册 / stopping 转换 / 结算 / owner-disposal 移除 / 服务卸载清空」时触发。面向模型的消费方是 `dsh-tool-jobs`（list / read / kill）。

进度要进浏览器，规范给了三条通道，**它们不是一条路的不同写法，是三种不同归属语义**（对照见证据 9c）。

### 证据 9a：`ctx.jobs` 的公开面与准入

抽象 `JobRegistry`：`start(spec): JobId`、`list(caller?)`、`get(id, caller?)`、`read(id, caller?)`、`kill(id, caller?, reason?)`、`wait(id, timeoutMs, caller?, signal?)`、`onJobDone(listener)`、`onJobsChanged(listener)`、`attachController(name)`。

- `JobStart = { kind, label, outputLimitBytes?, owner?: Agent, run(): JobHooks }`；`JobHooks = { cancel(reason?), done: Promise<JobOutcome>, readOutput?() }`。`done` 的口径是「在生产方**释放资源**后 resolve，而不是仅在工作完成时」。
- `JobKindMap` 原文：「Plugins extend this map by **declaration merging**; the registry treats every value as an opaque id namespace」——插件加 kind 是设计内动作，id 形如 `<kind>-N`。
- `owner` 省略 = 无主任务，「open to any caller until service disposal」；有 owner 则访问按会话 id 栅栏（`dsh-jobs-local` 的 `assertAccess`：「an unowned job is open, and a no-agent caller can never match an owned one」）。
- **准入闸**：`start refuses work while no attached job controller serves the spec's owner`。出路写在同页：从**非 scoped 上下文**注册的 controller 进 global layer，服务所有 owner（`dsh-jobs-local` 的 `servesOwner` 首行 `if (!this.layers.global.controllers.isEmpty()) return true`）。拒绝时报错原文「background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)」。
- **并发配额**：`LocalJobRegistry` 的 `maxConcurrentJobsPerOwner` 缺省 **10**，按确切 owner 统计 `running`+`stopping`，「所有无 owner 任务共享一个服务级桶」。**这与本插件的「单任务槽」不是同一语义**——用 `ctx.jobs` 不等于拿到互斥，自有单槽策略仍要自己持有。
- 存活口径：「Registrations outlive producer and controller fibers」，但 owner 或服务 dispose 会 cancel 并等待合规生产方；任务态不跨 DSH 重启（本插件既有 YAGNI 决策同向）。

### 证据 9b：浏览器怎么知道 job 在跑（第一方实现）

`dsh-client-ui-jobs` 的浏览器半只做一件事：`ctx.slots.inject("conversation.session.header.actions", …)` 注册一个会话头部动作，组件 `JobListAction({ sessionId, useSessions, t })` 里 `useSessions((state) => state.jobsBySession[sessionId])`。其包注释原文：「The data arrives entirely through the `jobsBySession` list mirror, so the plugin issues no RPC and holds no state of its own beyond popover visibility」，且「renders nothing at all until the session has at least one job」。

镜像的来源是 Session control 流：`SessionControlFrame` 的 `{ type: 'jobs', sessionId, jobs: SessionJob[] }` 帧 + 每代一次 baseline（`reference/subsystems/session` 口径：「瞬态 control stream 每代以完整 baseline 开始，随后应用 queue、job 与 projection update」）。`SessionJob = { id, kind, label, status, detail?, startedAt, finishedAt? }`——**再次确认没有百分比字段**。

### 证据 9c：三条进度投递通道对照

| 通道 | 官方依据 | 语义与代价 |
|---|---|---|
| **自有精确路由（SSE / 轮询）** | §3 的 `webServer` handler「Owns the full response lifecycle (may hold the response open, e.g. SSE)」；`reference/api-gateway` 边界节「需要流式或浏览器原生响应的功能注册精确的 Connection Fetch 路由，而不定义 Remote 方法」 | 任务与应用同生命周期、与会话无关。**代价是重连语义自己兜**：`reference/subsystems/web-client` 写死「普通 forwarded notification 不会 replay。需要可靠恢复的 stateful domain 必须提供 baseline、cursor 或显式 query」→ 推送只能当加速器，必须另有一条显式快照查询口 |
| **Session 事件 + Session projection** | `reference/subsystems/session-projection`：「领域 host 插件经由它向客户端载体供给按会话的**日志派生状态的当前全量值**」；`ctx.sessionProjections.register({ key, stateSchema, init(header, inheritedEventCount), apply(state, event), wire?: { viewSchema, view(state) }, stateVersion })`；客户端在 `session` 作用域的 slot 里收 `useProjection` 标准 prop | 白拿：按会话水位、重连 baseline、历史可回放、last-wins 全量值。硬约束：折叠函数**必须同步**（「an async unit would tear the carriers' consistency cut」）、`state` 必须是纯 JSON、**携带状态的日志事件必须携带变更后的完整状态而非裸增量**。归属约束：事件要 `Session.append()`（`ctx.sessions`「拥有仅追加的 Session 实例，并发出持久的会话事件流」），冷会话不投递是宿主既定口径（`reference/subsystems/schedule`：「cold Session 不执行任何工作」） |
| **只挂 `ctx.jobs`** | 证据 9b 的第一方 UI | 最省事、与模型侧天然一致；但只有存在性与终态，**无百分比**（面板实测：一行 `kind` + `label` + 终态 `detail` + 相对时间，条目**不可点**）。原推断「无主任务没有会话可挂 ⇒ 任何会话里都不出现」**已被真机推翻**（2026-09-19）：我们的 `novel-search` 与四条 `novel-probe` 都出现在会话头部的任务面板里（头部计数一路涨到「8 个后台任务」）。`jobsBySession` 的按会话键控约束的是**授权与归属**（`list(caller)` 原文「List caller-owned and unowned jobs」），不是可见性——无主任务对每个会话都呈现 |

`reference/subsystems/conversation` 整页范例就是一个「带 progress 的后台 job」怎么写：`review/start | review/progress | review/end` 三条持久事件 + `ConversationNodeDefinition` 折叠成 Chat 节点，`publication` 对高频 delta 用 `'animation-frame'`。那是**时间线呈现**这条路（进度出现在对话流里，不在我们的视图内）。

### 证据 9d：out-of-tree 插件用不上 Typert Remote（推断，标注为推断）

`reference/api-gateway`：Remote 方法由宿主根构建的 `@deepseek-ai/dsh-typert-generator` 从宿主 `ts.Program` 严格分析生成（产物写进业务包自己的 `lib/typert.*`），Client 侧由 `@deepseek-ai/dsh-api-remotes` 「以运行时值导入被选业务包的 /remote 子路径」挂载，且「增加一个 Host Remote 包是 **Client 组合所有者**的显式选择」。三处都锚在宿主仓库的构建与装配上，未见外部 npm 插件的贡献路径 → 本插件的合规传输面就是 §3 的 `ctx.webServer` 自有前缀路由。**这是推论不是官方禁令**，若将来出现外部贡献 Remote 的先例，本节要改。

### 对 dsh-novel 的直接含义

- `SourceJobs` 的正解是**变成 `ctx.jobs` 的生产方**（kind 走 declaration merging，`run()` 返回 `{cancel, done}`，`readOutput` 可选），生命周期/取消/隔离白拿；**单槽互斥与 counts/issues 仍是本插件的私有口径**，不因接入宿主而消失。
- Node 半要 `attachController`（自己的非 scoped 上下文），否则 `start` 直接拒。第一方唯一的 `attachController` 调用点在 `dsh-tool-jobs`（agent 组合侧，`attachController("tool-jobs")`），不替我们挂——而本机 profile 把 `tool-jobs` 关着（见「风险与不确定项」第 10 条），这一句更必须由生产方自己来。
- **kind 是自由字符串**：`dsh-jobs-local` 对 spec.kind 的唯一校验是「非空字符串」（`invalid job kind: expected a non-empty string`），随后直接拼 `<kind>-N` 当 id。所以自定义 kind 不需要宿主的 `JobKindMap` 合并，也就不需要装类型包。
- **本仓已落地（2026-09）**：`services/import-job.ts` 的 `SourceJobs` 接 `host?: JobHost`（本地窄面），`src/index.ts` 里 `attachController('dsh-novel')` 挂在 effect 上、`inject` 加 `jobs`；`kind` 用 `novel-import` / `novel-probe`，`label` 写清工作量（`导入书源 N 个文件` / `批量验证书源 N 家`）。取消是**协作式**（宿主 cancel 只拦「取下一条」，在途探针/入库不打断），终态映射 `completed|killed|failed → done|failed|failed`，wire 的 `phase` 不加 `killed`（对 UI 判据 `phase !== running` 无区别，加一态要动契约与三处判据）。
- **聚合搜索这一路同样已落地（2026-09 同轮）**：kind `novel-search` 走**独立的读槽**（`services/search-job.ts`，与两个写任务分开——读不该挡住写）。进度投递**两条都用**：地基是显式快照查询（`GET /novel-api/search/job-status?since=N` → `{added, next}`），加速器是本表的第 1 行——自有 SSE 路由（`GET /novel-api/search/job-stream`，帧体就是同一份 `{ job }` 快照）。客户端规则是「流在就不问、流断或无流才回落到 600ms 轮询」，任一时刻只有一条通道推进游标。用户的「停止」走 `POST /novel-api/search/job-cancel` → 同一个 `SearchJobs.cancel()`（宿主 kill 亦通向它）：本轮立即终态、已搜出的结果全留，读面另出 `cancelled: boolean` 让 UI 分清「用户停的」与「搜挂了」——判据在契约上，不寄在错误文案里。**通道选自有 SSE 而不选 Session 事件 + projection**，理由是被 ② 逼出来的：常驻呈现位在 `shell.overlay`（root 作用域、会话无关），projection 的读面按会话作用域走，挂上去正好与「在任何界面都说得出口」冲突；且 projection 那条路仍需一条同样的显式快照查询兜底（通知不 replay），等于两条都要写。**也刻意不用 `EventSource`**：它自带重连与 `Last-Event-ID`，把游标交给浏览器，与本仓「游标握在客户端、两条通道同源」的口径相反——故走 `fetch` + 流读取。
- **任务刻意注册成「无 owner」**（2026-09 决策，三类 kind 同一口径）：`JobStart.owner` 的官方语义是「拥有者是活 agent，其析构会 cancel 并等待该任务」，Service Definition 同向（「Owner and service disposal cancel live work」）。本插件的任务由**浏览器的 HTTP 请求**触发，手里没有 live agent 实例；硬凑一个 agent 当 owner，等于把「切走界面就完蛋」换个形式请回来——切会话 / 关窗口 → agent 析构 → 任务被杀。代价是宿主面向模型的那块 UI 不显示我们（`dsh-tool-jobs` 在本机 profile 里 `disabled: true`）；会话头部那块**实测是显示的**（见 9c 第 3 行被推翻的那条推断）。所以常驻层的独有价值不是「让任务被看见」——存在性与终态宿主白送——而是**数字进度与一键跳回现场**，这两样宿主面板都没有。所以**可见性与取消由本插件自己提供**（`shell.overlay` 常驻状态层 + `POST /novel-api/search/job-cancel`），`ctx.jobs` 在这里拿的是身份、生命周期与「随服务卸载而终止」，不是呈现。`attachController('dsh-novel')` 从我们自己的非 scoped 上下文挂 = 证据 9a 准入闸那条官方出路（global layer 服务所有 owner），不是绕路。
- **类型不可从 npm 拿**（2026-09 实测）：`npm view @deepseek-ai/dsh-jobs version` → `0.0.1-rc.3`，而本机宿主带的是 `dsh-jobs / dsh-jobs-local / dsh-tool-jobs / dsh-client-ui-jobs` 全部 `0.1.5-rc.1`，且该包在本仓 `require.resolve` 失败（`MODULE_NOT_FOUND`，只存在于宿主的嵌套 `node_modules`）。引 npm 版本 = 拿一套与运行中宿主不同代的契约。正解沿用本仓既有先例：`src/index.ts` 的 `interface NovelContext { webServer: WebServerLike; tools: ToolsRuntimeLike }` + `ctx as unknown as NovelContext`——**再加一个本地窄面镜像**（`JobsRuntimeLike`：只声明我们用到的 `start / list / kill / attachController` 子集），版本差异在运行时暴露而不是类型层假装对齐。
- 连续进度只能走三条通道之一。**通道选择的真正上游问题是「任务归属谁」**：应用级（→ 自有路由 + 常驻呈现位）还是会话级（→ projection + 会话头部）。选错的一侧要改回来代价是整条投递链。
- 常驻呈现位的核实结论见 §10（`shell.overlay` 是 `list` + `root` 作用域，会话无关，成立）。

---

## 10. Slot 层级与常驻呈现位（为什么视图环里的东西活不过切 tab）

### 结论

`slots` 是类型化的 React 组合系统，每个座位有 `kind`（cardinality）与 `scope` 两个维度。本插件「离开界面就看不见任务进度」的根因是纯粹结构性的：**我们的状态条住在 `conversation.view` 里，而该座位官方语义是「一次只渲染一个」**。视图环之外的常驻位另有其人。

### 证据 10a：三个座位的确切声明（本机生成的 Client inspect catalog）

`dsh-cordis-client-runner/lib/client.js` 内嵌着由 `SlotMap` 声明生成的 catalog（`reference/subsystems/slots` 称之为「每个 key 的完整参考，包含 cardinality、scope、owner props、标准 props、当前 occupant、声明 owner 与替换风险」；运行时可用 `cordis_inspect what:"client"` 查同一棵树）：

- `conversation.view`：`kind: "list"`, `scope: "session"`，summary 原文「Registered Conversation target Views, **rendered one at a time**」。壳层侧对应 `renderSlot("conversation.view", …, { only: active.id })`（§5 证据 5c）→ 切 tab / 切会话即卸载我们整棵 `NovelView`。
- `shell.overlay`：`kind: 'list'`, `scope: 'root'`。声明处 JSDoc 原文（`dsh-client-ui-layout` 的 `AppFrame` 声明的四个 root 子级之一，与 `sidebar` / `main` / `rightbar` 并列）：「Frame-wide floating layer, **above every column and outside their scroll containers**. Deliberately generic and unowned by any feature: a badge, a toast stack or a status pill all belong here… The layer itself is **click-through** — entries opt back into pointer events… This is **the additive seat for a frame-wide surface of your own**: a fresh `id` is added beside the shipped entries instead of replacing them.」注册范例（catalog 内原文）：`ctx.slots.register({ name: 'shell.overlay', id: 'my-entry', order: 100, label: 'My entry' }, Comp)`。
- `conversation.session.header.actions`：`kind: "list"`, `scope: "session"`，「Title-adjacent Session actions in ascending order」→ 拿得到 `sessionId` / `useSession` / `useProjection` 标准 prop，但**要求可解析的 Session**（`session` scope 定义）。第一方 jobs UI 就住这里。
- 反例存档：`root` 是 `single`——catalog 明写「DO NOT register here… a second entry does not sit beside the frame — it shadows it」。

### 证据 10b：状态该住哪（官方扩展规则原文）

`reference/subsystems/slots` 扩展规则四条与本插件直接相关的：

1. 「另一个功能包只能通过 `import type` 引入声明；绝不导入或转发它的运行时值」——= 本仓构建期纯度门，同一条红线。
2. 「**业务与传输状态留在所属 Cordis service 或 Client model 中。Slot store 只承载共享的视图与交互状态**」。
3. 「需要跨 entry 共享或**跨重新挂载保留**的可变视图状态走**声明的 store**」（注册项 `store` 选项 → 组件收 `PropsStore<H>`）——这是"切走再回来现场还在"的正规机制。
4. 「组件绝不会收到 `ctx`」；父组件已知的值走 owner props，单 entry 的 callback 与私有 observable 走注册项 `inject`，`inject` 返回值里的 `hooks` 对象由 renderer 绑成 `useXxx(selector)`。

`reference/subsystems/web-client` 分层表配套：Host 应用「拥有权威状态、持久化、mutation 顺序、访问策略与 stream 生产」；Client model「维护不依赖 React 的 Host 状态镜像……保持 object identity」；「UI 包消费这些 Client service，**不在 component store 中复制 transport state**」。

### 证据 10c：全局面板双座位（2026-09 迁移采信，本机 host checkout 实证）

dsh-novel 的小说视图 2026-09 从 `conversation.view` 迁到全局面板，采信的座位契约：

- `sidebar.panellist`：`kind: 'list'`, `scope: 'root'`（`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`；runner catalog `dsh-cordis-client-runner/lib/client.js` 同名条目）。注册项 `{ id（必填；自有 id 并列于 shipped entries，复用 shipped id = 替换该格）, order?, label?（string | thunk）}`；占用者组件收 owner props `SidebarPanelIconOwnerProps { size, active }`——**行本体归宿主**：`ui-sidebar` 的 `PanelRow` 自带按钮、`aria-label`、`aria-current`、Tooltip 与点击 `ctx.layout.selectPanel(id)`，插件只出图标（无障碍名取注册项 label）。README 原文：「With no registrations, neither the list nor spacing for it is rendered. The shipped composition registers no example panel.」
- `main`：`kind: 'keyed'`, `scope: 'root'`，summary「Central panel selected by sidebar entry id」，注册项 `{ key }`（runner catalog；声明在 `dsh-client-ui-layout`——AppFrame 的四个 root 子级 `sidebar`/`main`/`rightbar`/`shell.overlay` 之一）。keyDomain 原文：「open: any string the owner dispatches …, already taken: conversation」；占用者 `client-ui-conversation ConversationPanel key 'conversation'`；**其余 key 无 Session 绑定**（doc 原文「The reserved `conversation` key hosts the Conversation; other keys receive no Session binding」）。
- 选中态与抛错口径：布局服务 `ctx.layout`（`dsh-client-ui-layout/lib/types/client/service.d.ts`：`activePanelId: MainPanelId | null`、`selectPanel(panelId)`、`hasMainPanel(id)`；`MainPanelId = Branded<'MainPanelId'>`）。ui-sidebar README 原文：「The same id addresses the component registered in the layout's root-scoped `main` keyed slot; **selecting a missing main entry throws without changing the current selection**」⇒ `sidebar.panellist` 与 `main` 必须同批注册（dsh-novel 在 `apply` 内同步双注册，无半注册窗口）。
- 运行时（`dsh-client-ui-sidebar/lib/client.js`）：`entriesOfSlot('sidebar.panellist')` 投影成行元数据 `{id, order, label}`（order 升序、label 缺省回落 id），每行 `renderSlot('sidebar.panellist', { size, active }, { only: id })` 取图标；`usePanelInfo((info) => info.activePanelId === id)` 每行只订阅自己的选中态。

### 对 dsh-novel 的直接含义

- **2026-09 迁移落地（用户拍板）**：小说视图从 `conversation.view` 迁到全局面板——`sidebar.panellist` 图标行 + `main` keyed 槽同 id（`'novel'`）双注册（`src/client/index.tsx`；注册面钉子 `tests/client/panel-registration.test.tsx`）。`conversation.view` 注册撤除；`shell.overlay` 常驻层不动（任务读数与面板选中正交）。真机验证（重启宿主后侧栏出现「小说」行、点击在中央面板渲染视图）属用户实盘动作，自动化只证注册面。两个必须付的代价：层级在**所有列之上**，且**默认 click-through**——我们的状态条要自己声明 `pointer-events`，`z` 序也要重新判一次（现 `--novel-z-status` 是在小说视图内部的相对层级，overlay 里等于换了坐标系）。
- 会话头部 `conversation.session.header.actions` 是次选：与第一方 jobs UI 同位、天然带 `sessionId`，代价是 `session` scope——无会话时那个座位整体不存在。
- 视图环内的 `useState` 只准留渲染期派生；跨卸载要活的**业务**状态归 Host service（真相）+ 一份 Client model 镜像，跨卸载要活的**交互**状态归注册项声明的 `store`。本仓 `client.md`「业务数据不进 store / 组件内 useState 持有」那条口径与此冲突，需要重新定性（动机不变：不留第二真相；手段要换：一份镜像 ≠ 每组件一份且卸载即清零）。



---

## 风险与不确定项

1. **版本漂移**（**2026-09-23 本仓这一半已收敛**：devDependency 对齐宿主 0.1.7-rc.1 —— `@deepseek-ai/dsh-tools` 精确钉 `0.1.7-rc.1`、`@deepseek-ai/cordis` `^4.0.4`、`@deepseek-ai/schemastery` `^3.18.4`，同代类型面下 `pnpm typecheck` + `pnpm test` 全绿；并由 `tests/packaging.test.ts` 钉住「devDep 不早于 `dsh.compatibility.dshReleases` 里最高宿主 + 必须被 peer 区间放行」，逐位比到预发布序号（不截断到 minor），下次漂移直接变红。以下为调研当时读数 + 复核）：host checkout 是 0.1.5-rc.1，样例插件编译于 0.1.5-rc.2；`ui-slots`/`slots` 服务的包体未在本机两个 node_modules 中找到独立目录（`@deepseek-ai/dsh-client-ui-slots` 在 host `@deepseek-ai\` 清单中缺席，推断已被并入 web shell 平台基线、只以模块表种子存在——dsh-context tsdown.config 注释「Since dsh 0.1.2 the preloaded-client-externals channel is gone … dsh-client-store joined the platform baseline」支持该推断）。若 dsh-novel 的 client 要 `import { … } from '@deepseek-ai/dsh-client-ui-slots'` 的类型，需从 devDependency 装同版本包拿 d.ts。**2026-09-24 复核（宿主 0.1.7-rc.1）**：这三个目录**都在**（`dsh-client-ui-slots` / `dsh-client-store` / `dsh-client-ui-primitives` 均为 `0.1.7-rc.1`，就装在宿主自己的 `node_modules/@deepseek-ai/` 下）——上面「已并入 web shell 平台基线、只以模块表种子存在」的推断**被证伪**（0.1.5-rc.1 那代的读数不作数了）；但 `SlotMap` 的**声明**散在功能包里，经 declaration merging 写入——例如 `shell.overlay` 与 `rightbar` 的 `kind`/`scope` 就住在 `dsh-client-ui-layout/lib/types/client/index.d.ts`。所以核查某个座位的基数与作用域，正确动作是在 host 各包里 grep 座位名的**引号字面量**（`'shell.overlay'`），而不是找 slots 包。
    **2026-09-24 复核（peer 区间与 semver 预发布规则）**：`peerDependencies['@deepseek-ai/dsh-tools']` 原写 `>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-rc.1 <0.2.0-0`，看着覆盖到 0.2.0 之前，实则**只放行 3 个已发宿主**（`0.1.5-rc.1` / `-rc.2` / `-rc.3`）——连当时正在跑的 `0.1.7-rc.1` 都挡在外面。原因是 semver 的预发布规则：带预发布标签的版本，只有在某个比较符与它**同 major.minor.patch**、且该比较符自己也带预发布时才算满足，于是每个分支只开「最低那一段」一层，「>=0.1.6-rc.1 <0.2.0-0」并不等于「0.1.6 到 0.2.0 之间全放行」。**不存在免维护写法**：试过 `*`，它同样挡掉全部 27 个（`*` 默认不放行预发布），所以只能逐代显式开口。现行区间按「该代最低已发预发布 → 下一代 `<0.1.N+1-0`」列 8 段，覆盖 `0.0.1-rc.5` 起的 24 个已发宿主（`@deepseek-ai/dsh` 共 26 版，只除外 `0.0.1-rc.1`/`-rc.2`）。下限由三个硬 inject 里唯一有下限的那个定：`webServer`（补丁 id 写的是 `webserver`，按 camelCase grep 会漏）在 dsh-web-app 每个已发版本里都在、`tools` 连 `0.0.1-rc.1` 就有，只有 `jobs` 有下限——该行在 dsh-base 侧从 `0.0.1-rc.3` 起就有，但**那一版只有组件侧发过**（`@deepseek-ai/dsh` 与 dsh-web-app 都没有这版），所以按可安装宿主算，最低带 jobs 的是 `0.0.1-rc.5`（同版 `attachController` 签名已与今天一致）。被挡的两版缺 `jobs` 行、插进去整树拒绝挂载。**版本面读数一律按宿主（`@deepseek-ai/dsh`）口径数**：组件包各自的版本序列并不相同（dsh-base / dsh-tools / dsh-jobs 有 `0.0.1-rc.3`，CLI 与 dsh-web-app 没有），混用会数出不存在的那一版。判据落成 `tests/packaging.test.ts` 里三条断言（devDep 必须被放行 / 下一代 `0.2.0-rc.1` 必须被挡 / 最老两版必须被挡），走 `semver.satisfies` 真解析器而**不查字符串形状**——正则能证明「写了预发布」，证明不了「放行了这一代」。
2. **`conversation.view` slot 的确切 props 运行时形状**只从 d.ts（`PropsRuntime<'conversation.view'>`）与编译产物反推；`ConvViewProps` 的完整展开（hooks 注入面）没逐字段展开。实施时先写最小组件（忽略 props）验证 tab 出现，再按需取 `viewRequest`/`openView`。**2026-09 收敛一半**：该座位的 `kind: "list"` / `scope: "session"` / 「rendered one at a time」已从本机生成的 Client inspect catalog 直接读到（见 §10 证据 10a），"切 tab 是否卸载"这一问不再是悬念；剩余悬念只有 owner props 的逐字段形状——**2026-09 关掉**：本插件已迁出该座位（§10 证据 10c），它不再是本插件的悬念；留在档里只为将来要在对话区开 tab 时少反推一遍。
3. **order 语义**：chat=0、trajectory=10，order 小者在前（推断）；novel 用 20 排最后。未在源码中找到 order 相同值时的次序保证。
4. **信任 fence**：样例插件全部自带同源/trustedHosts 检查，但没有官方统一 helper 包；dsh-novel 需自写（better-archive 的 referer/host 判定 6 行足够起步）。若 API 只服务自己的 client 半，这是必须项而非可选项。
5. **`dsh.bundle.patch` 与手工 cordis.patch.yml 双挂载**：better-sidebar 的 `disabled: !!js` 守卫表明「同一包被 aggregate bundle 与自身 bundle 双挂载 = 整树 boot 失败（duplicate prefix route）」。dsh-novel 单包单挂载无此风险，但如果将来进 aggregate 需加同款守卫。
6. **`webRuntime` 服务**（trustedHosts 提供者）类型面只从 better-sidebar 的结构镜像看到（`src\context-types.ts:100+`），未读其实现包；dsh-novel 若不用它的 fence 可不 inject 该服务。
7. **apply 的 config 校验**：loader 拿插件 `export Config` 校验 patch 行 `config:`；dsh-novel 用 zod（dsh-context 式）或 schemastery（better-sidebar 式）皆可，但必须真的导出——否则 loader 无 schema 可校（推断：未找到「无 Config 导出时行为」的直接证据，样例两族都导出了）。
8. **Windows 本地路径安装**：`dsh plugin add` 的 anchorPathSpec 处理了相对路径；**已实测**（2026-09-16 起本机 web profile 的 `node_modules/@xrn1997/dsh-novel` 就是指向仓库目录的 link，`dsh profile.bundles` 含本插件）——link 语义意味着 `lib/` 不入库也不由对端构建，改完源码必须 `pnpm build`（AGENTS.md「环境坑」第一条）。门控 `DSH_INSTALL_CHECK` 另用一次性 profile `novel-smoke` 跑 add/remove，不碰日常 web profile。
9. **`patchReload: "live"`** 的热重载语义（web profile 现配）意味着改 cordis.patch.yml/插件版本后可能免重启，但 client bundle 变更仍需浏览器刷新 + 服务端 rebuild（DSH 自身 system prompt 亦提示 client 插件 HMR 的限制）。
10. **`ctx.jobs` 在本机 web 组合里在册——已判定（2026-09）**：判定路径不是 grep 宿主 bundle（官方包都并进聚合产物，`dsh plugin list` 只列 11 个外部包，两条路都是死胡同），而是**读 profile 自己的组合声明**：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 列出层（首位 `@deepseek-ai/dsh-base`），而 `dsh-base/cordis.patch.yml` 里有 `- id: jobs / name: '@deepseek-ai/dsh-jobs-local'`，故注册表常带。**同时钉住一个反直觉事实**：同文件里的 `- id: tool-jobs` 在 `dsh-web-app/cordis.patch.yml` 被 `- id: tool-jobs / disabled: true` 关掉（宿主注释：注册表留在 host plane，搬走的只是模型侧控件）——两点后果：① 唯一的 `attachController` 调用点随 tool-jobs 一起没了，**生产方必须自己挂 controller**；② 「AI 助手能看见/终止我们的任务」这条白拿的收益在本机 profile 下不成立，要等 tool-jobs 启用。
    **2026-09-19 复核（逐字 + 最小 profile）**：`@deepseek-ai/dsh-base@0.1.5-rc.1` 的 `cordis.patch.yml` 第 81-82 行就是裸的 `- id: jobs` / `name: '@deepseek-ai/dsh-jobs-local'`（无 `disabled:`、无注释），与 `webServer`、`tools` 同档常带；而 `DSH_INSTALL_CHECK=1` 用的一次性 profile `novel-smoke` 的 `dsh.profile.bundles` **只有 `@deepseek-ai/dsh-base` 一项**也照样具备——所以把 `jobs` 加进 `inject` 不缩窄兼容面（凡有 dsh-base 即有 jobs）。**代价写清**：`jobs` 是硬 inject，宿主若不带该条，整棵插件树会因缺依赖拒绝挂载（AGENTS.md 的 `plugin tree failed to load` 形态），而不是降级运行。**2026-09-24 穷举复核（把 dsh-base 已发的每一版 `cordis.patch.yml` 逐个取下来比对）**：该行的下限在 dsh-base 侧是 `0.0.1-rc.3`，不是 0.1.5-rc 系——只有 `0.0.1-rc.1` / `0.0.1-rc.2` 两版缺，`0.0.1-rc.3` 起到 `0.1.7-rc.1` 全部具备，且形态与今天一致（裸 `- id: jobs` / `name: '@deepseek-ai/dsh-jobs-local'`）；我们真正调用的 `attachController` 在 `0.0.1-rc.3` 已与今天同签名。故「早于 0.1.5-rc 系就挂不上」这句把下限写大了。**注意「版本面按宿主口径数」**：`0.0.1-rc.3` 只有组件侧发过（CLI 与 dsh-web-app 都没有），按可安装宿主算下限是 `0.0.1-rc.5`——两个口径的差别与结论见风险第 1 条。同日 `DSH_INSTALL_CHECK=1` 在 `novel-smoke` 上跑绿（build → add → bundles 与 `lib/client.js`/`cordis.patch.yml` 在场 → remove 摘除）。
    **2026-09-23 复核（宿主 0.1.7-rc.1）**：`dsh-base@0.1.7-rc.1` 的 `cordis.patch.yml` 里 jobs 行**仍是裸的**（`- id: jobs / name: '@deepseek-ai/dsh-jobs-local'`，无 `disabled:`），上面这条结论跨代不变；`DSH_INSTALL_CHECK=1` 当日再跑绿，`dsh --profile web --dump-config` 组合树含 `id: dsh-novel`。**运行时两件事已结一件**：宿主接受我们的 `attachController('dsh-novel')` —— 判据不是日志而是形态：`ctx.effect` 同步执行回调，`attachController` 若抛、或 `jobs` 服务缺席导致 `inject` 不满足，整树都不会 load、六个 `dshnovel_` 工具不会出现在会话里；本轮工具真调用通过（`dshnovel_source` 214 源读出、`dshnovel_search` 真返回命中）。**仍未验证的只剩** `shell.overlay` 里那条状态条的实际落位（层级 / 指针事件）。
