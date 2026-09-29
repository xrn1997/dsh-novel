# compat：真实源回放与跑通率报告

**compat 跑通率是 v1 的验收标准本身**——本目录把「率」变成可一键复算的数字（验收口径与三条真链路门控的承诺边界见 [`docs/design/services.md`](../docs/design/services.md) 的「构建、装载与验收」节）。

> **分母口径（别误读）**：`compat/report.md` 的「跑通率」分母是 `compat/fixtures/` 下的 fixture。
> 当前树只有 **1 条手写合成 fixture**（`demo-site`，域名 `demo.local` 不存在）——它是**规则引擎离线
> 回放的回归基线**，**不代表任何真实站点兼容率**（不覆盖真实 HTTP/重定向、GBK、超时、反爬、@js 真实宿主）。
> `compat/sources/` 目前为空；站点可用率请用真机重探（`DSH_REPROBE=1`）或投放真实源后走下面三步闭环。
>
> **空壳目录不算 case**：`loadCases` 只认同时具备 `source.json` 与 `manifest.json` 的目录，采集半途失败或被清空的
> 残骸会静默数成零条。所以**报告头按各 case manifest 的采集时刻自述「真站 / 合成」条数**，别看目录名数分母。

## 三步闭环

1. **投放源**：把 legado 书源 JSON 放进 `compat/sources/*.json`（一源一文件）。
2. **采集**（会真联网；每条源耗时 = 站点响应速度）：

   ```powershell
   $env:COMPAT_CAPTURE='1'
   pnpm vitest run --config vitest.compat.config.ts tests/compat/capture.test.ts
   Remove-Item Env:\COMPAT_CAPTURE
   ```

   关键词用 `$env:COMPAT_KEYWORD='剑来'` 覆盖（默认「书」）；**采集与回放必须同关键词**（manifest 已记）。
   **落盘的是生产解码链读到的文本**：`tests/compat/record.ts` 的 `recordBodyOf` 走 `decodeBody`（声明 charset
   → content-type → `<meta>` 嗅探），GBK 等非 utf-8 页存成真中文。此前是 `buf.toString('utf8')`，GBK 页存成
   乱码——采集侧断言跑在**真**解码链上、回放侧一律以 utf-8 供文本，于是**采集能过、回放必红**（又一种
   「采集与回放断的不是同一批」）。

   **采集三条实践口径（2026-09-28 首次真采后补）**：
   - **出站与生产同口径**：采集走 `resolveProxyUrl`（config > 环境变量 > 系统代理 > 直连）。缺这条会直连——
     只有代理能到的站点返回反爬壳页，采集在「正文为空」处报红，看着像源的问题（本仓实测：直连时若夏的
     正文接口取回壳页）。
   - **manifest 的键是「请求 URL」**，不是跟随重定向后的落地地址：搜索类源常是「POST 出去、302 落到结果页」，
     用落地地址当键会让回放在 `fixture 缺失` 处红（九九藏书实证，已修）。
   - **站点会抖，别删已采好的 fixture**：重采会覆盖，删除只会让你重新赌一次站点脸色（同一源十分钟内
     一次成功一次 `fetch failed` 是常态）。采到的源记住它跑通的时刻，回放是离线的、不再受站点影响。
   - **`fetch failed` 不总是源的错**：出站链路自身也会抖。2026-09-28 实证——同一代理下 `http://站点根`
     能 200、而 `/search/` 报 `UND_ERR_SOCKET`（qiexs）。见一次失败就给源记一笔「站点挂了」会误判，
     先打根路径对照再归因。
   - 采集**逐源断言五步**（导入 → 探针 → 搜索命中 → 详情面声明即须到货 → 目录非空 → 首章正文非空），任一失败即整轮红。
     首章需登录/付费的源采不了（实测：若夏的首章接口返回 `{"code":1,"nologin":true}`）——别投这类源。
   - **五步覆盖哪些面**：回放 = `import → search → detail → toc → chapter`（`tests/compat/harness.ts` 的
     `faceOrder`），即**搜索面 / 详情面 / 目录面 / 正文面**的规则都在内。`detail` 这一步是 2026-09-28 补的：
     在此之前四步整个漏掉 `ruleBookInfo.*`，而库里大量源的 kind/lastChapter/intro 只在详情面——
     漏了它，这类规则改坏了 fixture 也不会红（实例：九九藏书 的 `[property~=…]` 就在 `ruleBookInfo.kind`）。
   - **详情面的断言是「声明即须到货」**（`declaresDetail`，与正文链路审计的字段到货口径一致）：只在该源**自己
     声明了**对应规则时才要求非空（书名只认详情面专属声明 `ruleBookInfo.name`/平铺 `ruleDetailName`，不把
     搜索面的 `ruleBookName` 回退算进来）——**纯 API 源没有详情面**（米读看书：书名只在搜索条目上给，
     详情页是章节表 JSON），拿搜索面规则去要求详情面等于给源加它没声明的义务。
   - **采集与回放必须断同一批**：采集侧此前只断四步、回放侧断五步，于是能采出「采集绿、回放红」的 fixture
     （米读看书 实证）。现在两侧共用 `declaresDetail` 同一份判据——**采得下来就一定回放得出来**。

3. **复算跑通率**（离线）：`pnpm test:compat` → 逐源断言 + 生成 `compat/report.md`（总计/失败原因分布/逐源明细）。

三步闭环均已实现（采集侧门控测试 `tests/compat/capture.test.ts`）。数字从第一条采集的源开始才有意义——`compat/sources/` 当前为空。

## 目录结构

```
compat/
├── sources/                 # 投放的源 JSON（不强制入库）
├── fixtures/<caseName>/     # 采集产物：source.json 快照 + manifest.json + pages/
└── report.md                # test:compat 生成（覆盖写）
```

## 脱敏规程（入库门禁）

自动三刀（`tests/compat/sanitize.ts`，capture 写盘前执行）：
1. `<input type="password" … value="…">` 的 value → `[REDACTED]`；
2. **带引号值**的凭据形态（键两侧引号可有可无）：`"token": "…"`、`token: '…'` → 值 `[REDACTED]`；
3. **无引号值**的形态（HTTP 头 / env 行）：`Authorization: Bearer eyJ…`、`token=abcdefghijklmnop` → 值 `[REDACTED]`。

键名单：`cookie|token|password|passwd|secret|authorization|api[_-]?key`。**2026-09-28 修过一次**：原先第 2 条
要求键后**紧跟** `:`/`=`，于是真页面上最常见的 **JSON 带引号键**（`"token":"68d2…"`，企鹅小说的
Cloudflare beacon 就是这形态）与 `Authorization: Bearer …` **整条不触发**——门禁对机器可读形态是瞎的。
现在两形态都收，并且**这道门禁第一次有了测试**（`tests/compat/sanitize.test.ts`，含「正文提到 token 但不像
凭据就别动」的负向钉）。

**已知代价**：无引号那条会连正文里「token: xxxxxxxx」这种句子一起脱敏——宁可多脱不可漏脱（fixture 是测试数据）。

**规则改了就重洗已采 fixture**（不要重新采集——那要赌站点脸色）：

```powershell
$env:COMPAT_RESANITIZE='1'; pnpm vitest run --config vitest.compat.config.ts tests/compat/resanitize.test.ts
```

它就地重放新规则并自检幂等（再洗一遍零改动）；洗完记得跑 `pnpm test:compat` 确认回放仍绿。

**自动脱敏是兜底不是证明**：入库前人工过目；禁止提交含真实 cookie 的 fixture。
