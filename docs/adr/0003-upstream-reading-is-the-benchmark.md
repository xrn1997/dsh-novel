# 兼容判据是书源规则怎么读，不是标准语义或库语义；偏离逐条登记

Status: accepted

判一条写法支不支持，依据是**规则的实际读法**（含畸形名与不标准写法），不是 CSS/XPath 规范，也不是所引库的默认行为；分叉的证据只登记在矩阵行。换成标准语义，读得出的就是规范而不是书源：`[attr~=正则]` 按标准「词表包含」解会恒不命中（零命中冒充读法是最高罪），`HMacHex` 这种畸形名顺手规范化等于把输入里真实存在的 API 弄没，`java.ajax` 失败把错误文本回填正文同罪，本仓宁抛。CSS 类名与属性值维持大小写**敏感**，不做宽松匹配（放宽会让现有零命中形态变出多命中，`.0` 取位随之漂移）。偏离只在无法承接或判为更坏时允许，且**那一行要在覆盖矩阵写明理由**。被否决：按标准语义解 `~=`；把畸形名改成规范大小写；把 ajax 失败当正文交给脚本；类名/属性值改成不敏感匹配（重开条件：审计里出现第一条因大小写不一致而零命中的源）。

锚点：`src/engine/css.ts` 的 `JSOUP_ATTR_RE` 头注；`src/engine/js-utils.ts` 的 `jcaHashName`；矩阵行 `a-css-attr-regex`、`a-css-jsoup-text-pseudos`、`a-css-case-insensitive-match`、`h-digest-hmac-family`、`h-java-connect`。
