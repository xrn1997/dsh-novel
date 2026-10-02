## 1. 使用的体系

- **无外部 CSS 框架**：仓库没有 Tailwind、styled-components、@emotion、Sass/SCSS、CSS Modules 或任何 `.css` 文件。所有样式以 JavaScript 模板字符串 `NOVEL_CSS`（导出自 `src/client/styles.tsx`）集中声明，通过 `<style data-novel-style>` 注入 DOM。
- **React + JSX**：视图组件位于 `src/client/views/*.tsx`，仅负责 `className` 与少量行内 `style` 值槽；不写 CSS。
- **宿主主题契约**：颜色、语义 token 全部走宿主 `@deepseek-ai/dsh-client-ui-theme` 暴露的 `--dsw-alias-*` / `--dsw-specific-*` / `--dsw-static-*` CSS 自定义属性；本插件只读这些 token，自身不维护主题色表。
- **Dark mode 策略**：依赖宿主在 `body[data-ds-dark-theme]` 上切换 token；插件侧额外提供 `.novel-dark` 类以「强制控制器层暗」——这是用户显式选择而非主题推导，所以允许字面量覆盖。

## 2. 关键文件

| 文件 | 职责 |
|---|---|
| `src/client/styles.tsx` | 唯一样式源：导出 `NOVEL_CSS` 模板字符串，定义 `--novel-*` 设计 token、标度、布局、组件类 |
| `tests/client/theme-tokens.test.ts` | 守卫：扫描 `src/client/**/*.{ts,tsx}` 校验所有 `var(--dsw-*)` 引用均在冻结词表中，并禁止非白名单的颜色字面量 |
| `tests/client/ui-system.test.tsx` | 守卫：断言每个 `var(--novel-*)` 引用都有定义、z-index 相对次序稳定 |
| `src/client/views/bits.tsx` | 基础构件（badge、error banner、progress bar、run card、warn list），仅消费 `--novel-*` 变量 |
| `src/client/views/ChapterBody.tsx` | 正文渲染器，把图片宽高比等动态值写入 `--novel-fig-ratio` 等值槽 |
| `src/client/index.tsx` | 挂载 `<NovelStyles />`（即注入 `NOVEL_CSS`） |

## 3. 架构约定

### 3.1 Token 分层

`styles.tsx` 顶层 `.novel-root, [data-novel-scope]` 块把宿主 token 映射到本层 `--novel-*` 变量，再派生派生色（`color-mix(in srgb, var(--novel-brand) 8%, transparent)` 等 soft/tint/line/strong）。规则层只读 `--novel-*`，形成两层边界：

```
宿主 --dsw-alias-* ──→ 本层 --novel-* ──→ 组件 class 使用
```

这使宿主换品牌色时，派生色自动跟随；同时保留 fallback 硬编码值保证光/暗两态均可见。

### 3.2 命名空间与 scope

- 所有类名以 `novel-` 前缀（如 `novel-view`、`novel-tabs`、`novel-btn`、`novel-toolbar`、`novel-shell-status`、`novel-status-bar`、`novel-badge-pill`、`novel-run-card`、`novel-body` 等）。
- 作用域由 `.novel-root` 和 `[data-novel-scope]` 双重锚定——注释说明「设置区块曾在独立 React 树，现虽已同树，组件在哪棵树渲染都应成立」。
- 行为状态用 `data-*` 属性表达（如 `data-novel="error"`、`data-novel-view="city"`、`data-novel-run-card`、`data-novel-node`），CSS 通过属性选择器命中。

### 3.3 标度系统

间距 (`--novel-sp-0..7`)、字号 (`--novel-fs-xs..xl`)、圆角 (`--novel-r-xs..lg`)、阴影 (`--novel-shadow-1/2/pop`)、层级 (`--novel-z-*`)、动效 (`--novel-dur`, `--novel-ease`) 均以 named 变量形式集中在 token 层，规则中不得散写像素值。

### 3.4 值槽 (value slot)

仅少数需要运行时赋值的量作为 CSS 变量写在行内 style 中，但必须在 token 层有默认值，否则 token 自足守卫会报未定义引用：
- `--novel-pct`：进度条（`bits.tsx` 的 ProgressBar 按 `pct/100` 写入）
- `--novel-measure`：正文栏宽度（`prefs.measure` 经 `em` 缩放）
- `--novel-fig-ratio`：插图宽高比（`ChapterBody.tsx` 从 wire 的可信 width/height 写入）

### 3.5 构建与注入

`NOVEL_CSS` 是模板字符串，由 `renderToString` 友好地整体替换；HMR 重载随 bundle 整段替换，无需逐节点 patch。

## 4. 约定与约束

- **视觉规则只读 `--novel-*`**：组件类中不得出现 hex/rgb/hsl/color-mix 字面量；颜色必须来自 token 层（`tests/client/theme-tokens.test.ts` 通过正则扫描全源码实现，白名单仅限 `styles.tsx`、`util.ts`、`prefs-ui.ts`、`store.ts` 中的正文层色值）。
- **`--dsw-*` 必须是宿主真名**：测试冻结了宿主的 design-platform token 词表，任何不在词表内的 `var(--dsw-*)` 引用都会让 CI 失败（历史坑包括 `--dsw-alias-border-l`、`--dsw-alias-bg-layer-4` 等）。
- **派生色只能写在 token 层**：`color-mix(in srgb, ...)` 等函数形态同样被守卫捕获，防止视图层自行派生 brand 色。
- **z-index 单表管理**：`--novel-z-status:5`、`--novel-z-mask:10`、`--novel-z-panel:11`、`--novel-z-toolbar:12`、`--novel-z-modal:30`，由 `ui-system.test.tsx` 钉死相对次序；控制器层的 `CTRL_Z` 同名 z-index 与之对齐。
- **box-sizing 局部 reset**：仅 `.novel-root` 与 `[data-novel-scope]` 两棵树加 `border-box`，不碰宿主全局，避免影响宿主 chrome。
- **滚动链固定**：`.novel-root { overflow:hidden }` → `.novel-main { flex:1; overflow-y:auto }`，注释明确禁止放开，因为阅读器 scrollport 探测依赖这条链；scrollport 逻辑见 `src/client/scrollport.ts`。
- **浮层定位策略**：状态条用 `position:fixed` + `pointer-events:none` 容器包裹实际条目，右下角定位，z-index 取自 `--novel-z-status`，避免参与文档流造成 layout-shift。
- **暗黑模式双路径**：宿主 theme 切换 `body[data-ds-dark-theme]` 时通过 `--dsw-*` 生效；插件额外支持 `.novel-dark` 类「强制控制器层暗」，需重钉 `--novel-brand` 派生色与 ring。
- **中文最小可读字号**：token 层 `--novel-fs-xs: 11px`，注释写明「中文最小可读字阶 11px」。
- **CSS 方法约束**：由于 `NOVEL_CSS` 是 JS 模板字符串，文件中注释明确禁止在注释里写反引号，否则会截断字符串。