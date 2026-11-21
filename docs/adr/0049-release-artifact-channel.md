# 源码装的第二条渠道：GitHub Release 挂预构建 tarball

Status: accepted

`lib/` 是构建产物且不入库，而本包没有 `prepare`——`github:` / `git:` 直装拿到的是缺 `lib/` 的半成品，宿主整树拒挂。所以补一条不需要构建工具链的路：**`V*` tag push 时由 CI 用 `prepack` 构建好，挂成 GitHub Release 资产**，用户把 `.tgz` 的 URL 交给 `dsh plugin add`。决定：资产是 `pnpm pack` 的 tarball，不是源码归档（`files` 与 `exports` 已是发布契约）；workflow 只挂 Release、不发 npm（发布权留在维护者手上，CI 不需要新 secret）；tag 与 `package.json` 版本不一致即红，带 `-` 的标 prerelease；同一份 tarball 挂版本名与稳定别名 `dsh-novel.tgz`，让 README 的安装 URL 不随版本腐烂；装不装得进由 `DSH_INSTALL_CHECK` 的 tarball 那一格量。边界：`github:` / `git:` 一行直装仍不可行；tarball 完整性归 workflow 的 `tar -tzf` 断言；`workflow_dispatch` 永远干跑。被否决：恢复 `prepare`（pnpm 在源码安装路径拦下生命周期脚本，失败被推到运行时）；把 `lib/` 提交进 git；CI 代发 npm；只保留 npm。

锚点：`.github/workflows/release.yml`；`tests/packaging-install.test.ts`；`package.json` 的 `prepack` 与 `files`；`README.md`「安装」；`docs/development.md`「发版流程」。
