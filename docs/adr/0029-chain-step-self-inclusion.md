# 链式选择步的命中集含当前元素自身

Status: accepted

default 方言的 class / id / tag 三种选择步，与隐式及显式 CSS 步，命中集**含当前元素自己**（若它自己就匹配），并且自身排在它的全部后代之前；`child` / `children` 维持只取子节点。唯一实现是 `src/engine/select.ts` 的 `selectStepWithSelf`，四处步共用。**为什么**：兼容判据是「书源规则读得出的，我们也得读得出」；若收成纯后代语义，「类名和标签长在同一个元素上」的写法整条链读空——`<a class="page-link" href="…">` 配 `.page-link@a@href`，一条分页地址都取不到，症状不出在选择步上，而出在下游脚本把 `undefined` 拼成下一页地址、一次 404 把整本目录带走。**这件事必须现在裁**：这一族共用模板的书源形状需要一个判据层面的不变量——现库需求数不能判做不做（探测判据太粗会造假负），该不变量现由 `ADR-0099` 承接。被否决：在 URL 层或翻页层拦脏产物（给「不像地址的串」列一张列不全的清单）；判成「这族源写得 sloppy」；只补裸词那一支。**代价**：含自身改变取位顺序——`.0` / `[0]` 从「第一个后代」变成「自身」，靠后代语义才碰对的写法可能被挪到容器上；真机侧改前/改后逐源读数按 `DSH_REPROBE`、`DSH_CONTENT_AUDIT` 重取并写进矩阵行 `note`。

锚点：`src/engine/select.ts` 的 `selectStepWithSelf`、`evalDefault` 的 class / id / tag 三支；`src/engine/css.ts` 的 `evalCss`；`tests/engine/select.test.ts`、`tests/engine/css.test.ts`；矩阵行 `a-default-step-self-inclusion`、`a-class-multi-token-arg`。
