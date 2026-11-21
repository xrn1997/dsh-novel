# 配置页走宿主设置面（`remote.settings`），不引宿主 client 包

Status: accepted

插件页的「运行参数」保留，但读写改走宿主编目的设置服务（`settingsController` 的 `describe` / `mutate`，客户端面是 `ctx.remote.settings`）；页面自己持有草稿与保存态，不再 import 任何宿主 client 包——页面/面板的校验清单明确禁止后者。背景：配置页原先靠宿主表单原语的 `SettingsForm` / `SettingsFormModel`，整个浏览器半在 factory 求值期就 require 了它；模块一旦缺席或改名，侧栏、主面板、常驻状态层会一起装不上。

## 决定

- **读写只经 `ctx.remote.settings`**：`describe()` 读 `{ writable, namespaces[{ ns, value, user, revision }] }`，`mutate(ns, ops, revision)` 一次原子写；恢复默认 = 单字段 `unset`。
- **页面拥有呈现与草稿**：字段清单与类型判据住 `config-fields.ts`，草稿、脏标记与保存态住 `config-draft.ts`，分区索引住 `config-index.ts`；`config-page.tsx` 只做呈现与卡片版式，`NovelConfigPageView` 保持纯呈现。
- **值域仍归 schema**：本页只判类型错（数字位非负整数；文本位首尾空白归一后不含内部空白），上下界与代理形状由宿主在 `mutate` 时裁决，拒绝时原样显示理由并保留草稿。
- **冲突不让页面进死路**：`mutate` 回 `settings/conflict` 时保留草稿并重读修订号；不订阅外部变更，展示值要重开页面才刷新。
- **能力缺席即退让**：`ctx.inject(['remote', 'remote.settings'], …)` 可选注册；宿主没有设置面时这一页不出现，其余座位照常。
- **平台模块表回到两条**：`react` / `react/jsx-runtime`。

## 被否方案

- 继续用宿主表单原语：直接违反页面校验清单；静态 import 在 CJS 闭合工厂里无法懒加载。
- 删掉配置页：活配置就没有编辑面，只能改 patch 重启。
- 直接用 `configForms` 服务：该服务不在检查器的 Service 目录里，无法按「先确认再依赖」落字。

## 代价

- 每次打开/保存多一次远程往返；外部改配置后要重开页面才刷新。
- 宿主拒绝只回一条理由，不再有逐字段的 schema 级提示；本页只兜类型错，取舍是「不抄第二份值域」。

锚点：`src/client/config-page.tsx` 的 `registerConfigPage` / `NovelConfigCard` / `NovelConfigPageView`；`src/client/index.tsx` 的可选 `ctx.inject(['remote', 'remote.settings'], …)`；`tsdown.config.ts` 的 `PLATFORM_MODULES`；`tests/packaging-build.test.ts`；`tests/client/config-page.test.tsx`；`tests/browser/config-page-layout.test.tsx`；`ADR-0035`、`ADR-0066`。
