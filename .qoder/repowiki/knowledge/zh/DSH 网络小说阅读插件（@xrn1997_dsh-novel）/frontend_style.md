## 1. 采用的系统/方法

- **无 CSS 文件**：全部样式以 TypeScript 模板字符串导出（`TOKENS_CSS`、`SHELL_CSS` 等），由 `styles.tsx` 拼接为单串 `NOVEL_CSS`，通过 `<style data-novel-style>` 注入 DOM。构建产物仅一个 CSS 片段，没有 PostCSS/Sass/Less 管线。
- **React 组件库**：基于 React 18（peerDependency optional），使用 `@testing-library/react` 渲染测试；无第三方 UI 组件库（AntD、MUI 等）。
- **主题来源**：本插件不持有自己的主题引擎，而是消费宿主 `@deepseek-ai/dsh-client-ui-theme` 的 `--dsw-alias-*` 语义 token，并通过本层的 `--novel-*` 变量做一层适配与派生。
- **响应式策略**：未发现媒体查询或断点；布局依赖 Flexbox + `min-height:0` 的滚动链（`.novel-root` → `.novel-main`），由 `src/client/scrollport.ts` 探测可滚容器。

## 2. 关键文件

| 路径 | 职责 |
|---|---|
| `src/client/styles.tsx` | 单一拼装点：按固定次序 join 十个 CSS 块并暴露 `NovelStyles` 注入组件 |
| `src/client/styles/tokens.ts` | 视觉 token 层：定义所有 `--novel-*` 变量（配色、间距/字阶/圆角/阴影/层级/动效）、命名标度、缺省值与对宿主 `--dsw-alias-*` 的映射 |
| `src/client/styles/shell.ts` | 宿主壳块：全局 overflow 链、tab 导航、状态条浮层、`.novel-dark` 强制暗层重钉、`.novel-btn` 控件基类、`border-box` 守卫 |
| `src/client/styles/*.ts` | 视图专属样式块：`reader.ts`、`shelf.ts`、`sources.ts`、`search.ts`、`overlays.ts`、`city.ts`、`config-page.ts` |
| `tests/client/theme-tokens.test.ts` | 运行时守卫：扫描 client 全源码，校验 `--dsw-*` 引用均在白名单词表内、禁止视图层出现颜色字面量（hex / rgb / color-mix） |
| `tests/client/ui-system.test.tsx` | 层级顺序守卫：钉死 z-index 相对次序与 `var(--novel-*)` 自足性 |

## 3. 架构与约定

### 3.1 两层 token 模型

1. **宿主语义层** `--dsw-alias-*`：来自宿主设计系统，提供基础色、层级、按钮、状态、品牌等语义原语。
2. **本层适配层** `--novel-*`：在 `.novel-root, [data-novel-scope]` 上声明，`var(--dsw-alias-*, fallback)` 形式引用宿主 token，并提供本插件独有的派生值（如 `--novel-brand-soft/tint/line/strong`、`--novel-paper`/`--novel-paper-ink`、`--novel-z-*`、`--novel-sp-*`、`--novel-fs-*`、`--novel-r-*`、`--novel-shadow-*`、`--novel-dur`、`--novel-ease`）。

视觉规则只读 `--novel-*`，不直接引用 `--dsw-*`（除 tokens.ts 自身）。派生色统一用 `color-mix(in srgb, var(--novel-brand) X%, transparent)` 从品牌色生成，避免散写 hex。

### 3.2 样式分块与装配顺序

`NOVEL_CSS` 严格按以下顺序拼接（注释明确“次序即原单串的字符次序”，同级特异度的胜负由先后决定）：

`TOKENS_CSS` → `SHELL_CSS` → `CONTROLS_CSS` → `SOURCES_CSS` → `SEARCH_CSS` → `READER_CSS` → `SHELF_CSS` → `OVERLAYS_CSS` → `CITY_CSS` → `CONFIG_PAGE_CSS`

每个模块是一个 TS 文件，导出一个常量模板字符串，不引入其它样式块。

### 3.3 作用域与宿主隔离

- 根选择器使用 `.novel-root` 与 `[data-novel-scope]` 双入口，保证任意树挂载均可自足。
- `border-box` 守卫限定到这两棵树，不污染宿主。
- 隐藏宿主 composer 使用 `:has([data-novel-root])` 判在场性，避免吞掉对话视图里的接管组件。
- 浮层使用 `position:fixed; inset:0; pointer-events:none` + 子元素 `pointer-events:auto` 的模式，锚在右下角，避免遮挡宿主 chrome。

### 3.4 明暗主题

默认跟随宿主光/暗主题（通过 `body[data-ds-dark-theme]` 切换 `--dsw-*`）；用户可选择「控制器层跟随深色」时，`.novel-dark` 类覆盖一组 `--novel-*` 局部变量（包括派生色需重新计算 `color-mix`）。正文纸墨色（`--novel-paper`/`--novel-paper-ink`）不受此影响，属于正文层独立调色。

### 3.5 设计标度

- 间距：`--novel-sp-0..7`（2/4/6/8/12/16/24/32px）
- 字号：`--novel-fs-xs(11)..xl(19)`，中文最小可读 11px
- 圆角：`--novel-r-xs/sm/md/lg`（4/6/8/12px）
- 阴影：`shadow-1`/`shadow-2`/`shadow-pop`
- 层级：`--novel-z-status:5` → `z-mask:10` → `z-panel:11` → `z-toolbar:12` → `z-modal:30`
- 动效：`--novel-dur: .15s` + `cubic-bezier(.2,0,0,1)`

## 4. 约定与约束

### 观察到的约定（descriptive）

- 所有颜色以 `var(--novel-*)` 引用，不在视图 JSX 中内联 hex/rgb/hsla/color-mix。
- 派生色（半透明 brand、弱底等）一律在 tokens.ts 用 `color-mix` 从 `--novel-brand` 派生。
- 所有 CSS 放在 `src/client/styles/*.ts` 模板字符串中，无 `.css` 文件。
- 组件通过 `NovelStyles` 注入一次；单飞渲染（SettingsSection）自带样式，被 NovelView 挂载时让位，避免重复注入。
- 浮层统一走 `--novel-z-*` 单表，JS 侧 CTRL_Z 同名钉住 z-index，防止两处各写各的数。

### 真正被验证的规则（enforced by tests/linting）

1. **宿主 token 白名单守卫**（`tests/client/theme-tokens.test.ts`）：扫描 `src/client/` 下全部 `.ts/.tsx` 源码，正则匹配 `var(--dsw-[\w-]+)`，要求每一个引用都在内置 `HOST_TOKENS` Set 中；不存在即断言失败。该守卫还包含负断言，确认已知坑 `--dsw-alias-border-l` 与 `--dsw-alias-bg-layer-4` 不在词表中。
2. **颜色字面量守卫**（同文件）：扫描 client 源码（先剥离注释），禁止出现 hex 或 `rgba()/hsl()/hsla()/color-mix()` 字面量；白名单仅限 `styles/tokens.ts`、`styles/shell.ts`、`styles/reader.ts`、`styles/shelf.ts`、`styles/overlays.ts`、`util.ts`、`prefs-ui.ts`、`store.ts`，且后三个白名单只允许列出的具体颜色值。违反即断言失败。
3. **Token 自足守卫**（见 `tokens.ts` 注释，由 `ui-system.test.tsx` 钉）：本层每个 `var(--novel-*)` 引用都必须在同一层有定义，否则整条简写静默落 `unset`。
4. **NOVEL_CSS 组装不可随意增删规则**（`styles.tsx` 注释）：块的拼接顺序即 CSS 优先级，跨块移动规则视为行为变更，应通过重构而非直接改顺序。
5. **样式注入唯一性**（`styles.tsx` 注释）：同一棵 React 树只能注入一次 `<style data-novel-style>`，否则 58KB CSS 会进 DOM 两次。

## 5. 结论

这是一个轻量但高度纪律化的前端样式体系：用 TypeScript 模板字符串替代 CSS 文件，以 `--novel-*` 作为中间 token 层桥接宿主 `@deepseek-ai/dsh-client-ui-theme` 的 `--dsw-alias-*` 语义，并通过 Vitest 守卫强制「不内联颜色、不引用不存在宿主 token、token 自足」。项目未引入任何 CSS 预处理框架或第三方组件库，样式完全由本插件维护。