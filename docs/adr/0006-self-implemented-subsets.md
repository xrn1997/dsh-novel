# JSONPath 与 XPath 自实现子集，不引库；子集边界是裁决不是疏忽

两个求值器都是手写的，只收在册子集，越界在解析期抛带段定位的错；XPath 直接在 domhandler 的节点树上求值，轴、谓词、函数走白名单。

为什么不用现成库：① 真实书源里的形态（`$.data.*` 属性通配、`.[*]` 冗余点、负数从尾数、`//text()`、谓词按父分组）不在任何轻量库的子集里；② **完整的库会带进我们明确不想支持的语义**（过滤器 `[?()]`、脚本表达式 `[()]`）——自实现才能把「不支持的语法」变成带段定位的抛错，而不是静默错值；③ XPath 靠 HTML→XML 重解析求值会错位。

被否决的方案：① 引 npm 的 JSONPath / XPath 库；② 补全 XPath 轴（ancestor 等）与聚合函数（`count` / `sum`）——白名单是按真实规则普查量出来的，实测需求只有父步 `..`，其余没有需求方；③ 父步越界时「把文档根当 html 用」的特判——那是猜，会让 `//x/../../..` 这类越界规则静默出数；节点测试用 `*`，文档根不是元素，自然零命中 → Miss。

锚点：`src/engine/jsonpath.ts`（`reject` / `tokenize`）；`src/engine/xpath.ts`（`AXIS_NAMES` 与头注）；`tests/engine/jsonpath.test.ts`、`tests/engine/xpath.test.ts`；矩阵行 `a-json-path-subset`、`a-json-path-filter`、`a-xpath-subset`、`a-xpath-parent-step`、`a-xpath-other-axes`。
