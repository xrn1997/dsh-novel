# 源码装的第二条渠道：GitHub Release 挂预构建 tarball

Status: accepted

`lib/` 是构建产物且不入库，而本包没有 `prepare`——pnpm ≥10 会在源码安装时拦下依赖的生命周期脚本，`github:` / `git:` 直装拿到的是缺 `lib/` 的半成品，宿主整树拒挂。于是「从 GitHub 装」过去只有一条路：克隆、自己 `pnpm install && pnpm build`、再 `link:`。现在补一条不需要构建工具链的路：**`V*` tag push 时由 CI 用 `prepack` 构建好，挂成 GitHub Release 资产**，用户把 `.tgz` 的 URL 直接交给 `dsh plugin add`。

## 决定

1. **资产是 `pnpm pack` 的 tarball，不是源码归档**。`files` 白名单与 `exports` 已经是发布契约，pack 出来的就是宿主认的那棵树；源码归档里没有 `lib/`，挂上去等于把同一个坑换个包装再卖一次。
2. **workflow 只挂 Release 资产，不发 npm**。`npm publish` 的归属留在维护者手上（`CONTRIBUTING.md`「发版边界」），CI 因此不需要任何新 secret；两条渠道靠同一个 tag 对齐。
3. **tag 与 `package.json` 版本不一致即红**。宿主按 peer 区间放行之后读到的就是这个 tarball，挂错版本比不挂更坏。带 `-` 的 tag 标成 prerelease，不抢 `latest`。
4. **同一份 tarball 挂两个名字**：版本名 `xrn1997-dsh-novel-<版本>.tgz` 供钉版本，稳定别名 `dsh-novel.tgz` 供 `releases/latest/download`，让 README 的安装 URL 不随版本腐烂。
5. **装不装得进由门控量，不由文档声称**。`DSH_INSTALL_CHECK` 的 tarball 那一格用真 `dsh` CLI 装入本地 `pnpm pack` 的产物；下载 URL 只是同一份 tarball 的传输形态。

## 边界

- `github:` / `git:` 一行直装仍然不做，也不会因这条渠道变可行：`lib/` 不在 git 树里，宿主侧也没有构建机会。
- tarball 内容完整性归 workflow 里的 `tar -tzf` 断言；本地 `pnpm test:pack` 只验 `lib/` 构建产物形状，不打包。
- npm 渠道自身的事实（`files`、`exports`、peer 安装闸）仍归 `package.json` 与 `ADR-0020`。
- `workflow_dispatch` 永远干跑，不上传 Release。

## 被否方案

- **恢复 `prepare`**：正是 0.8.1 把它换成 `prepack` 的那条理由——pnpm ≥10 拦下源码安装的生命周期脚本，`prepare` 根本不跑，装出来依旧是缺 `lib/` 的半成品，比现在这种「明确拒挂」更坏，因为它把失败推到运行时才炸。
- **把 `lib/` 提交进 git**：产物入树后每次构建都留一份 diff，且与「`files` 是精确清单、构建每多一个产物就同步加进去」的发版纪律相冲。
- **CI 代发 npm**：要存 `NPM_TOKEN`、把不可逆的发布决定交给机器，还要改写发版边界。本次要的是一条更多人装得上的渠道，不是换掉发布权的归属。
- **只保留 npm**：GitHub 侧用户要么得配 registry，要么得自备构建工具链；Release 资产是 GitHub 原生的一条路。

锚点：`.github/workflows/release.yml`；`tests/packaging-install.test.ts`（pack → `add` tarball 那一格）；`package.json` 的 `prepack` 与 `files`；`README.md`「安装」；`docs/development.md`「发版流程」。
