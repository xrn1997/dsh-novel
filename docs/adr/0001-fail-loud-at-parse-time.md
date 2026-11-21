# 认不出的规则语法在解析期抛错，不用空结果冒充失败

Status: accepted

白名单之外、又构不成选择器语法的段，一律在 `parseRule` 阶段抛 `UnsupportedRuleError`（带面 + 段序 + 段原文），不留给求值期兜底：判「哪些语法没被认出来」的普查与导入预检都按真入口跑全库规则串，透传会让整族漏掉，错误阶段与错误类也全错。`词.词`、非 ASCII 标签名与含选择器特征字符的写法本就是 CSS 选择器，零命中即 Miss；同一条链混用 `||` / `&&` / `%%` 时生效者不可判定，判语义冲突、解析期拒。被否决：裸词透传到求值期再炸、静默跳过或宽容猜测、把「认不出」外扩到一切未知串。空结果冒充失败是本仓定的最高罪。

锚点：`src/engine/parse.ts` 的 `KNOWN_MODES` / `isImplicitCss` / `isCssWordChain`；`tests/engine/parse.test.ts`；矩阵行 `a-unknown-segment-throws`、`a-css-implicit`、`a-combining-mixed`。
