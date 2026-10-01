# MerMarkd 开发日志

> 本文件是面向 GitHub 的按批次开发时间线。`PROGRESS.md` 记录当前状态，`DECISIONS.md` 记录稳定的架构决定；本文件记录每一批实际做了什么、如何验证、哪里失败以及下一步。

## 使用规则

- 每个可运行批次收尾时追加一条记录，先重新检查代码、数据边界、测试和打包结果，再进入下一批。
- 记录实际命令、结果、失败原因和未完成门槛；“通过”必须说明覆盖范围，不能只写结论。
- 代码、测试或构建发生变化时，列出主要文件；纯规划批次也要记录影响的文档和未实施的内容。
- 截图、安装包、导出文件等产物写明相对仓库路径或当前已知位置；无法提交到仓库的本地产物要注明原因。
- Git commit、diff 和远端发布记录与本文件并列维护；每批完成后补充对应 commit、PR 或明确的未发布状态。

## 批次模板

后续批次按以下字段追加：

```text
## YYYY-MM-DD · 批次名称

### 目标

### 用户反馈/需求来源

### 设计决定

### 修改文件

### 测试和命令

### 产物/截图

### 失败与限制

### 下一步
```

## 2026-10-01 · Git 仓库接入与远端历史合并

### 目标

把当前已验收的 B0 工作区安全接入 `https://github.com/KLucen/MerMarked`，保留远端已有 A 阶段历史，并为后续批次建立可追溯的提交记录。

### 用户反馈/需求来源

用户要求将项目 push 到 GitHub，并要求开发过程中持续保留可供后续查看的开发记录。

### 设计决定

- 使用 SSH 远端 `git@github.com:KLucen/MerMarked.git` 完成网络操作；仓库目标仍对应用户提供的 HTTPS 地址。
- 远端 `main`（`cd8a142`）与本地 B0 提交（`43d6317`）历史无共同祖先，使用普通 `--allow-unrelated-histories` 合并，不改写或强制覆盖远端。
- 发生 add/add 冲突的共享文件保留当前 B0 工作区版本；远端历史作为合并提交的第二父提交保留。
- `.gitignore` 保留依赖、构建产物、覆盖率、事务临时文件和日志排除规则。

### 修改文件

- Git 元数据、索引和合并提交
- `docs/DEVELOPMENT_LOG.md`

### 测试和命令

```powershell
git fetch origin main
git merge origin/main --allow-unrelated-histories --no-edit
npm.cmd test
npm.cmd run typecheck
npm.cmd run package
git push --set-upstream origin main
git ls-remote git@github.com:KLucen/MerMarked.git refs/heads/main
```

合并前已确认工作区无用户未提交改动；合并冲突已逐项复核并保留 B0 版本。合并后全量单测 `210/210`、类型检查和 Electron Windows x64 生产打包均通过。普通 push 成功，远端 `main` 已核对为 `29f19c8361f70956c6bbbb9ae6c5c3707a08352f`。

### 产物/截图

- 远端目标：[KLucen/MerMarked](https://github.com/KLucen/MerMarked)
- 本地 B0 提交：`43d6317`
- 合并来源：`cd8a142`
- 合并提交及已推送远端：`29f19c8`

### 失败与限制

- GitHub HTTPS 访问曾因 443 超时，已切换 SSH 完成 fetch/push；这不改变用户提供的仓库地址。
- 当前仍未声称 P0 完成；安装残留、行数密集大文件和真实多显示器 DPI 仍按 A8.6 记录待处理。

### 下一步

合并提交 `29f19c8` 已推送；后续批次继续在每批收尾重新检查并更新本日志。

## 2026-10-02 · B1 工作区外壳与开始页

### 目标

在不扩大 Markdown、批注 YAML 和画布 JSON 写入边界的前提下，交付可以直接使用的开始页与紧凑工作区：打开、新建、最近文档、单行模式导航、可收起左右侧栏和焦点模式。

### 用户反馈/需求来源

用户要求主体阅读、编辑和卡片空间优先，打开 Markdown 作为进入软件后的开始界面；文件信息、导航和辅助操作通过左右侧栏收起，继续按批次收尾复查并上传 GitHub。

### 设计决定

- 最近文件偏好只保存绝对路径和打开时间；主进程负责存在性、扩展名和真实路径校验，渲染器不直接读写偏好文件。
- 开始页提供打开、新建和最近文档；新建通过明确的保存对话框创建空 `.md`，创建后进入同一文档会话，避免覆盖已有文件。
- 打开文档后的顶栏只保留紧凑的模式导航、状态、打开入口、侧栏和焦点按钮；完整路径、编码和状态进入文档信息侧栏。
- 左右工作区侧栏属于瞬时界面状态，不写三类内容文件；同一窗口打开一侧时自动收起另一侧，避免窄屏重叠；焦点模式同时关闭两侧并隐藏辅助栏。
- 动效只用于侧栏/按钮状态反馈，使用指定属性和短时长；`prefers-reduced-motion` 下移除过渡。正文、源码编辑和画布仍复用既有写入守卫。

### 修改文件

- `src/core/recent-documents.ts`
- `tests/core/recent-documents.test.ts`
- `src/main/main.ts`
- `src/preload/preload.ts`
- `src/types/reader-api.d.ts`
- `src/renderer/app-shell.tsx`
- `src/renderer/main.tsx`
- `src/renderer/style.css`
- `tests/e2e/b1-shell-packaged.mjs`
- `package.json`

### 测试和命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run package
npm.cmd run test:e2e:b1
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
```

结果：全量单测 `216/216`、类型检查、Electron Windows x64 生产打包、B1 打包版和 A8.4/A8.5 回归均通过。B1 覆盖开始页、新建空 Markdown、最近文档重开/移除、左右侧栏互斥、焦点模式及 `1200/800/420` CSS px 无横向溢出；A8.5 的无文档恢复入口回归也通过。首次直接执行 `npm.cmd run package` 在 Forge 复制 Electron 依赖时因 `20.205.243.166:443` 超时退出 `1`，按既有流程设置 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` 后重试退出 `0`；失败属于下载源网络问题，不是代码构建错误。

### 产物/截图

- `out/qa/b1-shell-wide.png`
- `out/qa/b1-shell-narrow.png`
- `out/qa/b1-shell-mobile.png`
- 打包应用：`out/MerMarkd-win32-x64/MerMarkd.exe`

### 失败与限制

- 新建流程在创建时先由用户选择目标路径并创建空文件，再进入文档会话；无路径临时缓冲区和首次保存另存为仍留待后续 B1.1，避免把虚拟路径带入既有三文件事务。
- 最近文件偏好写入失败只记录主进程错误，不阻断打开或保存正文；偏好不是正文恢复来源。
- 本批没有接入卡片 v2 投影、阅读富文本编辑或右键格式命令；这些仍按 B2/B4/B5 顺序推进。

### 下一步

本批代码和记录已完成复查并推送 GitHub；下一批先处理无路径新建/首次保存或进入 B2 卡片 v2 投影，仍以每批单独验证为准。

### 发布记录

- B1 提交：`aea488a14bffeacb2097291b011ec80bccfa9bca`
- 远端核验：`git ls-remote origin refs/heads/main` 返回同一 SHA（2026-10-02）。

## 2026-10-02 · B1.1 内存新建与首次保存

### 目标

把“新建 Markdown”改为打开即进入可编辑缓冲区，首次显式保存时才选择真实文件路径，同时保持恢复草稿、字节格式和三文件写入门槛。

### 用户反馈/需求来源

用户希望打开软件后直接进入可以编辑和阅读的工作区，并要求新建/打开流程减少中断；B1 收尾时将无路径新建与首次保存列为下一批。

### 设计决定

- 新建生成带 `temporary` 标记的内存文档，不创建虚拟 `.md`、最近记录或批注/画布 sidecar。
- 首次保存通过原生保存对话框选择 `.md`，独占创建空文件后换绑编辑会话，继续复用现有安全 Markdown 保存和恢复草稿流程。
- 首次保存前冻结批注、画布、章节结构和导出；取消、目标已存在或放弃编辑均保留候选内容，不覆盖已有文件。

### 修改文件

- `src/main/main.ts`
- `src/main/markdown-editor-session.ts`
- `src/types/reader-api.d.ts`
- `src/renderer/app-shell.tsx`
- `src/renderer/main.tsx`
- `tests/main/markdown-editor-session.test.ts`
- `tests/e2e/b1-shell-packaged.mjs`

### 测试和命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run package
npm.cmd run test:e2e:b1
git diff --check
```

结果：全量单测 `220/220`、类型检查、Windows x64 打包、首次保存打包版 E2E 及 `1200/800/420` CSS px 工作区验收通过。打包首次下载遇到 Electron 网络超时时使用 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` 重试通过。

### 产物/截图

- 打包应用：`out/MerMarkd-win32-x64/MerMarkd.exe`
- B1 响应式截图继续写入 `out/qa/b1-shell-wide.png`、`out/qa/b1-shell-narrow.png`、`out/qa/b1-shell-mobile.png`

### 失败与限制

- 未保存临时文档没有真实路径，关闭前仍依赖现有编辑恢复草稿；批注和画布需首次保存后使用。

### 下一步

进入 B2 画布 v2 真实投影，继续保留每批独立复查和远端发布。

## 2026-10-02 · B2 画布 v2 投影与正文显示状态

### 目标

把 B0 的 v2 画布合同接入真实加载、保存、结构事务和卡片投影，让正文折叠、后代折叠和本节卡位置开始成为可用状态。

### 用户反馈/需求来源

用户要求父章节正文可在卡片组内任意位置、正文内容可展开/收起，并要求旧内容和每批回归保持安全可恢复。

### 设计决定

- 画布读写同时支持 schema v1/v2；旧 v1 只内存迁移，v2 字段在显式画布保存时按三文件基线提交。
- `bodyDisplay` 使用 `hidden`、`preview`、`full` 三态；`descendantsCollapsed` 独立控制子章节；兼容场景用虚线组边界和独立 `contentPosition` 让本节正文不再固定在左上角。
- 三文件事务、结构预览和恢复核验按 schema 分派，保留未解析卡片和箭头端点，不把普通布局写入 Markdown。
- 固定结构投放标记暂时保留以复查 A8.4；B3 再替换为重叠比例/停留候选和拖出提升。

### 修改文件

- `src/core/canvas-state-v2.ts`
- `src/core/canvas-scene-v2.ts`
- `src/core/canvas-card-content.ts`
- `src/main/canvas-store.ts`
- `src/main/canvas-store-v2.ts`
- `src/main/document-transaction.ts`
- `src/main/section-structure-store.ts`
- `src/main/main.ts`
- `src/preload/preload.ts`
- `src/types/reader-api.d.ts`
- `src/renderer/canvas-view.tsx`
- `src/renderer/style.css`
- `tests/core/canvas-scene-v2.test.ts`

### 测试和命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run package
npm.cmd run test:e2e:b1
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
git diff --check
```

结果：全量单测 `220/220`、类型检查、Windows x64 打包、B1、A8.4 和 A8.5 打包版回归通过；v2 场景测试覆盖独立正文位置、全文状态、后代折叠和隐藏箭头端点。

- B1.1+B2 提交：`ff29709e6039b7b2181028b9ab8a9c1092847311`
- 远端核验：`git ls-remote origin refs/heads/main` 返回同一 SHA（2026-10-02）。

### 产物/截图

- `out/MerMarkd-win32-x64/MerMarkd.exe`
- B1 响应式截图及既有 A8 回归产物继续复用

### 失败与限制

- 兼容结构投放区仍存在，重叠候选、滞回、拖出提升和真正独立组节点留待 B3。
- 补回 A8.4 兼容标记后的第一次打包在 Electron 临时目录重命名时返回 `ENOENT`，无残留进程后重试成功；这是打包环境瞬时失败。

### 下一步

进入 B3：删除常驻投放区，加入重叠比例/停留高亮、拖出提升与结构预览候选；收尾前仍运行全量测试、类型检查、打包和旧回归并推送 GitHub。

## 2026-10-01 · A8.6 安装、性能与高 DPI 首轮验收

### 目标

对 Windows 测试安装包执行安装、打开、保存、导出、卸载、性能和高 DPI 首轮验收，确认 P0 的剩余风险，而不是把开发机上的启动结果当作发布验收。

### 用户反馈/需求来源

用户要求进行干净环境安装/卸载、性能与高 DPI 验收，并要求每批收尾后重新检查再继续。

### 设计决定

- 将安装器残留、极端短行解析和真实多显示器 DPI 作为独立未闭合门槛记录。
- 代表性性能样本与极端压力样本分开报告，避免把极端输入的失败掩盖在平均指标里。
- 继续保留 Squirrel 卸载后的明确残留证据，未把手动清理目录描述成卸载器自动完成。

### 修改文件

- `tests/e2e/qa-installed.mjs`
- `tests/qa-performance.mjs`
- `docs/PROGRESS.md`

### 测试和命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run package
npm.cmd run make
npm.cmd run test:e2e:a8-2
npm.cmd run test:e2e:a8-3
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
node tests/e2e/qa-installed.mjs
node --expose-gc tests/qa-performance.mjs
```

结果：单测 `202/202`，类型检查、打包、安装包生成和 A8.2/A8.3/A8.4/A8.5 打包回归通过。安装版静默安装退出码为 `0`，三档设备像素比 `1/1.25/1.5` 均完成视口内检查。

### 产物/截图

- 安装包：`out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`
- DPI 截图：`out/qa/dpi-1-installed.png`、`out/qa/dpi-125-installed.png`、`out/qa/dpi-15-installed.png`
- 性能代表样本：约 `5 MiB`、`1,000` 个标题、约 `200` 张可见卡片；解析约 `762 ms`，布局约 `133 ms`，观测峰值 RSS 约 `273 MiB`。

### 失败与限制

- `Update.exe --uninstall -s` 返回成功并删除快捷方式，但留下 `.dead`、`Update.exe` 和 `app-0.1.0`；本批确认无相关进程后才手动清理，不能称为卸载器零残留通过。
- 数十万极短行的 `5 MiB` 压力样本约 `27 s`、约 `3.4 GiB` RSS，暴露同步解析风险；这不是代表性目标样本，但必须在性能收口前处理或限制。
- 当前证据不是没有开发工具的新 Windows 环境，也没有覆盖真实多显示器物理 DPI。
- 本批不重复执行代码测试或构建；以上命令和结果沿用本批已执行证据。

### 下一步

继续保持 P0 未完成状态，先处理行数密集输入的解析边界、卸载残留策略和真实干净 Windows/多显示器 DPI 验收，再进入发布收口。

## 2026-10-01 · B0 迭代规划与体验复盘

### 目标

把用户试用后的八项反馈整理成可分批验收的产品合同，明确下一轮从编辑原型和卡片 v2 数据模型开始，避免直接在现有卡片节点上堆交互。

### 用户反馈/需求来源

- 卡片需要分别折叠正文和后代章节，父章节正文卡可在组内任意位置移动。
- 取消常驻“拖到此处设为子章节”，改为重叠比例和停留时间触发候选提示。
- 子章节能够拖出并提升为同级或移至顶层。
- 阅读模式与源码模式都能编辑 Markdown；阅读模式编辑渲染结果，源码模式编辑完整源码。
- 选中文字后的右键菜单需要覆盖复制、粘贴、剪切、删除、加粗、斜体、引用、链接、颜色高亮和便签。
- 主体阅读、编辑、卡片空间优先；打开/新建文档作为开始页，文件信息和批注等放入可收起侧栏。
- 使用 `emil-design-eng` 的动效和交互原则重新检查整体设计。

### 设计决定

- 将“本节内容卡”和“章节组边界”拆开；父级关系仍由 `SectionTree` 决定，不能由 React Flow 容器成为内容真相。
- v2 折叠状态拆为正文折叠和后代折叠；v1 的 `collapsed` 迁移为后代折叠，迁移不自动写盘。
- 父内容卡在组内允许自由定位；结构组移动和内容卡移动使用不同的交互区域与视觉层级。
- 拖入候选采用重叠与停留的可中断反馈，拖动开始冻结原父组边界；拖出松手后进入已有的源码结构预览和撤销栈。
- 阅读编辑和源码编辑共享同一文档缓冲区、revision、保存门槛和撤销历史；高亮/便签仍属于 YAML，正文格式修改才写 Markdown。
- 文件信息、批注、恢复和卡片属性进入左右侧栏；开始页负责打开/新建文档；主工作区不常驻大块品牌和文件打开区域。
- 动效优先使用可中断的 `transform`/`opacity` 反馈，支持 `prefers-reduced-motion`；重叠阈值和停留时间暂定为待验证起点，不作为最终产品承诺。

### 修改文件

- `docs/ITERATION_PLAN.md`
- `docs/PROGRESS.md`

本批未修改产品代码，未安装新依赖，也未声称 B0–B6 已实现。

### 测试和命令

本批重新阅读现有架构、模式边界、开发流程、可行性审查、进度、决策和卡片相关实现，检查了 `src/renderer/canvas-view.tsx`、`src/core/canvas-scene.ts`、`src/core/canvas-state.ts`、`src/core/canvas-card-content.ts`、`src/core/section-transform.ts`、`src/renderer/app-shell.tsx`、`src/renderer/reader-view.tsx` 和 `src/renderer/use-markdown-editor.ts`。本批只改文档，因此未重复运行源码测试或构建。

### 产物/截图

- 迭代路线：[ITERATION_PLAN.md](ITERATION_PLAN.md)
- 当前状态：[PROGRESS.md](PROGRESS.md)
- 本日志：[DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md)

### 失败与限制

- 现有 `ChapterCard` 同时承担内容、父组、折叠和投放区，不能通过小修补满足自由定位、双折叠和拖出。
- 当前正文仍是摘要，完整正文卡需要复用受控 Markdown 阅读管线并重新验收大文档和导出。
- v2 数据结构、阅读富文本编辑引擎、右键菜单和拖动阈值均未实现或未定稿。

### 下一步

进入 B0 实施前，先写出编辑原型和卡片 v2 的验收样本、字段迁移规则、撤销边界和性能基线；B0 收尾时追加实际命令、结果、失败项和下一批入口。

## 2026-10-01 · 建立 GitHub 可追溯开发记录制度

### 目标

让后续上传 GitHub 后能够按批次查看开发历程，并把“每批收尾重新检查”从口头要求变成仓库流程。

### 用户反馈/需求来源

用户明确要求在开发过程中做好开发记录，以便后续上传至 GitHub 后查看。

### 设计决定

- `PROGRESS.md` 只维护当前阶段和未完成门槛。
- `DEVELOPMENT_LOG.md` 按时间和批次记录目标、反馈、决定、文件、命令、产物、失败与下一步。
- `DECISIONS.md` 继续只记录需要长期稳定的架构和数据合同；本批新增轻量流程 ADR。

### 修改文件

- `docs/DEVELOPMENT_LOG.md`
- `docs/DEVELOPMENT_PROCESS.md`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`

### 测试和命令

本批仅做 Markdown 文档一致性检查：检查日志模板字段、相互引用、代码围栏和 A8.6/B0 状态是否一致。未运行代码测试、类型检查、打包或安装包回归。

### 产物/截图

- 本文件作为 GitHub 可读开发时间线入口。
- `PROGRESS.md` 顶部新增本文件链接。

### 失败与限制

当前工作区没有 `.git` 元数据，因此暂时没有 commit、diff 或 PR 链接可附加；恢复 Git 后需把每批对应 commit/PR 补入日志。

### 下一步

从 B0 开始按模板实时追加记录；每批结束先复查，再更新 `PROGRESS.md`、必要时更新 `DECISIONS.md`，最后才进入下一批。

## 2026-10-01 · B0 核心合同与编辑事务原型

### 目标

先证明卡片 v2 的迁移合同和共享 Markdown 局部编辑事务，再决定阅读富文本编辑引擎；保留现有 v1 应用可运行路径。

### 用户反馈/需求来源

本批依据用户要求按批推进、每批重新检查，以及阅读/源码共享编辑、正文/后代独立折叠和父内容自由定位的迭代规划。

### 设计决定

- 新增 v2 纯核心投影，不替换旧 v1 IPC；v1 打开只做内存迁移，明确保存才允许后续批次升级 JSON。
- `collapsed` 只迁移为 `descendantsCollapsed`；正文显示通过 `bodyDisplay` 区分隐藏、摘要预览和全文，默认迁移为 `preview`。
- 正文编辑使用 revision 门控的纯事务模型；局部替换保留原始周边字节，撤销/重做共享同一快照历史。
- 本批不安装富文本编辑依赖，不把核心事务测试误报为阅读视图已经可编辑。

### 修改文件

- `src/core/canvas-state.ts`
- `src/core/canvas-state-v2.ts`
- `src/core/markdown-edit-transaction.ts`
- `tests/core/canvas-state-v2.test.ts`
- `tests/core/markdown-edit-transaction.test.ts`
- `docs/B0_ACCEPTANCE.md`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`

### 测试和命令

```powershell
npm.cmd test -- --test-name-pattern="v2 migration|v2 serialization|v2 validation|local Markdown edits|stale revisions|new edit after undo"
npm.cmd run typecheck
npm.cmd test
npm.cmd run package
```

结果：B0 定向测试通过；全量单测 `210/210`，类型检查通过，Electron Windows x64 生产打包通过。打包产物为 `out/MerMarkd-win32-x64/MerMarkd.exe`。

补充：无镜像重试时 Forge 在复制 Electron 依赖阶段因 `20.205.243.166:443` 连接超时退出 `1`；按既有环境记录设置 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` 后重试退出 `0`。本次失败归因为下载源网络超时，不是 TypeScript 或应用编译错误。

### 产物/截图

- 验收样本：[B0_ACCEPTANCE.md](B0_ACCEPTANCE.md)
- v2 迁移核心：[canvas-state-v2.ts](../src/core/canvas-state-v2.ts)
- 编辑事务核心：[markdown-edit-transaction.ts](../src/core/markdown-edit-transaction.ts)
- 打包应用：`out/MerMarkd-win32-x64/MerMarkd.exe`

### 失败与限制

- 本批没有把 v2 状态接入现有 React Flow 画布，独立本节内容卡、组边界、双折叠视觉和自由位置留待 B2。
- 阅读模式仍是只读渲染；中文 IME、渲染后的直接编辑、右键剪贴板/格式菜单和富文本引擎选型没有通过 UI 验收。
- 没有新增安装包 E2E；本批打包只证明新核心未阻断现有生产构建。当前工作区仍没有 `.git` 元数据，无法附 commit/diff/PR。

### 下一步

收尾复查本批核心测试、类型、打包、文件边界和文档一致性；下一批进入 B1 工作区外壳，保持开始页、紧凑导航和左右侧栏改动不触碰 Markdown/YAML/画布保存门槛。
