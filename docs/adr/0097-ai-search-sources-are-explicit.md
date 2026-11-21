# AI 搜索源独立于启停：工具面只搜用户显式标记的源

Status: accepted

AI 搜索工具此前与界面聚合搜索共用「启用 ∧ 文本」这一条参与集，源一多就必须靠逐个停用来收窄，而停用同时会砍掉界面搜索。决定：书源上加一个**用户显式标记**的 AI 搜索位，工具面只搜「启用 ∧ 文本 ∧ 已标记」的源；界面搜索与发现面不吃这一位。

## 背景

启停开关原本是「参不参与聚合搜索」的唯一轴，界面搜索与 AI 工具共用它，于是两类使用场景被绑在一起：用户导入一整个书源包，希望界面里仍能全量搜索，但 AI 工具每次只问少数几家可信源；反过来把源停用，界面搜索也没了。AI 工具是同步等待的一轮请求，候选源数直接变成延迟与失败面；界面搜索有进度、可停止，痛点不同。

## 决定

1. **`aiSearch` 是书源上的用户偏好，不是书源格式字段**：与 `enabled` 正交。新导入的源缺省 **false**，重导入（replace）保留原值；存量缺键由 `SourceRegistry.load` 的迁移收敛为 false 并落盘。默认关闭是刻意的：导入一整个包不等于把整包交给 AI。
2. **AI 工具面的参与集 = 启用 ∧ 文本 ∧ `aiSearch === true`**。判据单点是 `participation.ts` 的 `aiParticipates`；界面搜索与发现面仍只读 `participates` / `exploreParticipates`。
3. **`sourceIds` 只在 AI 集合内收窄**：显式点名一个未标记的源不会让它参搜；空集合直接返回 `eligible: 0` 与零请求，不落回「未限定」语义。
4. **回执如实披露候选数**：`dshnovel_search` 的 `eligible` 是本轮 AI 候选源数；render 在 0 时给出「去书源管理标记」的行动指引。
5. **控制面住在书源管理**：行内 AI 勾选逐源切换，批量条成批改，状态下拉与状态带各有一个 AI 维度；停用源的勾保留但整格灰化。`dshnovel_source` 的 `list` 投影 `aiSearch`，并提供 `ai-enable` / `ai-disable`。
6. **落盘与 HTTP 写口分两份**：`sources/:id/ai-search` 与 `sources/batch-ai-search` 各自持有 `{ aiSearch: boolean }` body，不复用启停路由的 `enabled` 字段。

## 边界

- AI 标记不是第二个启停轴：停用对两种搜索同时生效；标记不改变界面搜索、发现面、探针与试跑。
- 标记不等于质量判断：坏源也可以被标记，搜索会在 `failed` 里如实点名。
- 不做「未标记时回退到全部启用源」；不做「只搜已验证源」的隐式收窄。

## 代价

- 升级后 AI 搜索可能从「能搜到一些」变成 `eligible: 0`，直到用户标记源；回执与界面都给出明确指引。
- 新导入的源不会自动参搜，用户多一步配置；换来的是导入大包时 AI 工具不被拖慢。
- 书源管理多一个维度（行内勾选、批量动作、筛选与计数），界面更密。

## 被否方案

- 全局数量上限：N 取几都是猜，且「哪 N 个」仍要系统替用户做选择。
- 只搜 `verified` 源：已验证源的数量仍可能远超合适规模，且验证状态会过期。
- 按 legado 分组选源：分组是书源包作者给的标签，不是用户意图。
- 复用启停开关：界面搜索与 AI 工具的痛苦不同，共用一个轴必然让一边让步。
- 让 AI 自己先列源再挑：多一轮工具调用，弱模型不保证照做。

锚点：`src/services/types.ts` 的 `NovelSource.aiSearch`；`src/services/participation.ts` 的 `aiParticipates`；`src/services/sources.ts` 的 `setAiSearch` / `toPublic`；`src/services/reading.ts` 的 `setAiSearch` / `setAiSearchMany` / `searchForAi`；`src/shared/wire.ts` 的 `SourcePublic.aiSearch` / `paramOps.sourceAiSearch` / `ROUTES.sourcesBatchAiSearch`；`src/tools/tools.ts` 的 `dshnovel_search` 与 `dshnovel_source`；`src/client/views/SettingsSourceList.tsx`；`src/client/source-list-view.ts` 的 `SourceStats.ai`；`tests/services/participation.test.ts`；`tests/services/reading.test.ts`；`tests/services/sources.test.ts`；`tests/tools/tools.test.ts`；`tests/client/settings-toggle.test.tsx`；`tests/client/source-list-batch.test.tsx`；`tests/api/dispatch-sources.test.ts`；`docs/ui-spec.md` §3.3；`README.md` 的「首次使用」与「AI 助手工具」。
