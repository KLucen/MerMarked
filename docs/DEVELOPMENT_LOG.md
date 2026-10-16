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

## 2026-10-02 · B3 重叠候选与拖出提升

### 目标

把卡片结构手势从固定投放区改为可中断的重叠候选，同时让子章节可以拖出父组并进入独立章节预览。

### 用户反馈/需求来源

- 不显示“拖到此处设为子章节”，两张卡片重叠达到比例后再高亮提示。
- 子章节应能拖出父章节并独立，且结构修改必须继续经过预览、确认、取消和撤销安全门槛。

### 设计决定

- 新增纯核心 `canvas-structure-candidates`：交叠按较小卡片覆盖率计算，`35%` 产生候选，`50% + 280 ms` 进入可移入态。
- 拖出直接父组使用 `35%/70%` 逃逸比例和同样的停留时间；就绪后生成顶层 `promote` 预览，拖入候选优先。
- React Flow 只更新候选卡片的视觉数据，不重建拖动节点；松开时按最新停留时间补算就绪状态，避免用户在提示出现后立即释放却被当成普通布局拖动。
- 使用短时边框、背景和脉冲反馈，并在 `prefers-reduced-motion` 下关闭动画；移除固定投放区和相关命中逻辑。

### 修改文件

- `src/core/canvas-structure-candidates.ts`
- `tests/core/canvas-structure-candidates.test.ts`
- `src/renderer/canvas-view.tsx`
- `src/renderer/style.css`
- `tests/e2e/a8-4-packaged.mjs`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`

### 测试和命令

```powershell
node --test tests/core/canvas-structure-candidates.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run package
npm.cmd run test:e2e:b1
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
git diff --check
```

结果：核心测试 `7/7`、全量单测 `227/227`、类型检查、Windows x64 打包、B1、A8.4 和 A8.5 打包版回归通过。A8.4 现在从实际卡片重叠触发预览，并继续验证取消恢复布局、三份文件独立过期门槛、确认零写入、撤销/重做、BOM/CRLF 与重开。

### 失败与修复

- 首次 UI 接入中，候选状态更新会重建 React Flow 节点并重置拖动位置；改为只更新节点数据后重新打包通过。
- 首次释放测试在停留计时刚好结束后仍被判为普通拖动；松开事件补算最后一次候选的停留时间后通过。

### 限制与下一步

- 拖出当前默认预览移至文档顶层；“提升为原父章节同级”的细分键盘入口和真正独立组节点拆分留待后续迭代。
- 真实多显示器物理 DPI、卸载器零残留和行数密集大文件解析仍是 P0 未闭合门槛。
- B3 提交：`8131b90a32866a28247c2fa35562b1fcef780736`；远端 `origin/main` 已核对为同一 SHA。

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
- `package.json`（补充可复现的 QA npm scripts）
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

同样的安装与性能检查也可分别使用 `npm.cmd run test:e2e:qa-installed` 和 `npm.cmd run test:qa:performance`。

结果：单测 `202/202`，类型检查、打包、安装包生成和 A8.2/A8.3/A8.4/A8.5 打包回归通过。安装版静默安装退出码为 `0`；在重建打包版上补测 `1/1.25/1.5/2` 四档设备像素比，四档均完成视口内检查、模式切换和卡片控件验收，DPR 与目标值一致，1× 导出 PNG 成功。

### 产物/截图

- 安装包：`out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`
- DPI 截图：`out/qa/dpi-1-installed.png`、`out/qa/dpi-125-installed.png`、`out/qa/dpi-15-installed.png`、`out/qa/dpi-2-installed.png`
- 性能代表样本：约 `5 MiB`、`1,000` 个标题、约 `200` 张可见卡片；解析约 `762 ms`，布局约 `133 ms`，观测峰值 RSS 约 `273 MiB`。

### 失败与限制

- `Update.exe --uninstall -s` 返回成功并删除快捷方式，但留下 `.dead`、`Update.exe` 和 `app-0.1.0`；本批确认无相关进程后才手动清理，不能称为卸载器零残留通过。
- 数十万极短行的 `5 MiB` 压力样本约 `27 s`、约 `3.4 GiB` RSS，暴露同步解析风险；这不是代表性目标样本，但必须在性能收口前处理或限制。
- 当前证据不是没有开发工具的新 Windows 环境，也没有覆盖真实多显示器物理 DPI。
- 本次补测只扩展安装验收脚本的 2× DPI 档位，未改变应用运行时逻辑；代码测试和构建证据沿用本批已执行结果。

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

## 2026-10-02 · B4 共同选区命令与右键菜单

### 目标

把用户要求的源码选区操作和阅读正文选区操作推进为一个可验证的小批次：复制、剪切、粘贴、删除、加粗、斜体、引用，以及不污染 Markdown 的颜色高亮和批注入口。先固定选区、revision、异步剪贴板和 sidecar 边界，再进入阅读模式直接编辑。

### 用户反馈/需求来源

用户要求选中文字后右键提供复制、粘贴、剪切、删除、加粗、斜体、引用和不同颜色高亮；阅读模式与源码模式都要服务于同一份 Markdown，同时保留 Markdown、批注 YAML 和画布 JSON 的独立可恢复合同。

### 设计决定

- 新增纯核心 `markdown-selection-commands`：源码命令使用 `MarkdownEditSession` 的局部替换、revision 和 UTF-16 代理对边界校验；复制读取原始 Markdown，引用扩展到完整受影响源码行并保留 CRLF/无尾换行形态。
- 阅读模式右键复制使用渲染后的可见正文；高亮和批注只把冻结的、已映射选区交给 annotation intent，不写入 `==...==`、HTML 或其他 Markdown 标记。
- 右键菜单保存文档 epoch/source hash/revision，并在剪贴板异步返回后再次验证；菜单在文档、模式或选区清理时关闭。源码右键命令结果复用现有编辑器 history 入口，当前仍未把 session 提升为跨模式共享 hook。

### 修改文件

- `src/core/markdown-selection-commands.ts`
- `tests/core/markdown-selection-commands.test.ts`
- `src/renderer/editor-view.tsx`
- `src/renderer/main.tsx`
- `src/renderer/style.css`
- `tests/e2e/a7-3b-packaged.mjs`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`

### 测试和命令

```powershell
node --test tests/core/markdown-selection-commands.test.ts
npm.cmd test
npm.cmd run typecheck
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run package
npm.cmd run test:e2e:a7-3b
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
git diff --check
```

结果：核心测试 `6/6`；全量单测 `233/233`；类型检查、Windows x64 生产打包、A7.3b 源码右键加粗/撤销、A8.4 结构事务和 A8.5 恢复回归全部通过。打包过程中没有残留 Electron 进程。Node 的 `MODULE_TYPELESS_PACKAGE_JSON` 仅是既有警告，不影响退出码。

### 产物/截图

- 打包应用：`out/MerMarkd-win32-x64/MerMarkd.exe`
- 本批没有新增截图；既有 A8.4/A8.5 QA 截图继续作为结构和恢复回归证据。
- 代码提交：`043bf22d97b430dea85fc389e3859330d7698b6f`
- 远端核对：`origin/main` 已指向同一 SHA；仓库地址为 `https://github.com/KLucen/MerMarked`。

### 失败与限制

- `MarkdownEditSession` 尚未真正由 `useMarkdownEditor` 持有，当前菜单结果写入现有源码组件 history，不能宣称阅读/源码跨模式共享同一撤销栈。
- 阅读模式暂时只提供复制、四色高亮和批注；加粗、斜体、引用要等 B5 完成保守 DOM 到 Markdown 的映射后再开放。
- 菜单完成 Escape/指针关闭，Shift+F10、方向键、Enter 和完整焦点管理仍待后续切片。

### 下一步

进入 B5 前先以本批远端提交为基线重新检查工作区；下一批把编辑 session 提升到共享 hook，随后实现阅读模式最小可编辑正文、输入法处理和单步撤销边界，再按同样流程测试、复查、提交和推送。

## 2026-10-02 · B5 共享编辑会话与纯文本阅读编辑

### 目标

落实 B4 留下的两个关键缺口：让源码编辑器真正消费 renderer 侧共享的 Markdown 撤销会话，并让阅读模式在可证明安全的范围内直接编辑渲染后的正文，同时保持 Markdown 字节、批注锚点和画布 sidecar 的边界。

### 用户反馈/需求来源

用户要求阅读模式像 Typora/Obsidian 一样编辑 Markdown 渲染内容，也要求阅读、编辑和卡片围绕同一文档状态工作；此前 B4 已明确不能把 DOM 全文反向生成 Markdown，需先完成共享事务和保守映射。

### 设计决定

- `useMarkdownEditor` 持有 LF 规范化的 `MarkdownEditSession`，源码输入、右键命令、查找替换、结构确认和阅读块编辑都进同一 past/future；主进程 revision、异步队列和恢复草稿合同保持不变，历史上限为 500 项。
- 新增 `reader-edit` 核心映射。只有一个 paragraph 或 ATX heading 在源码中去除标题标记后与可见文字完全相同、且为单行纯文本时，才允许替换；UTF-8 字节边界转 UTF-16 位置后再局部写入，保留 BOM/CRLF/标题标记。实体、内联 Markdown、Setext、跨行和不明确位置全部拒绝。
- 新增块级 `contenteditable`，支持输入法组合、纯文本粘贴、Enter/格式输入拦截和 Escape 恢复。失焦只提交该块的文本，不序列化整个渲染树；进入 dirty 预览后阅读编辑关闭，必须切到源码显式保存。
- 按 Emil Kowalski 规范加入克制的焦点/悬停状态：仅在精确指针设备启用 hover，过渡限定颜色/轮廓且支持 reduced motion 的全局策略，不用持续运动装饰正文。

### 修改文件

- `src/renderer/use-markdown-editor.ts`
- `src/renderer/editor-view.tsx`
- `src/renderer/main.tsx`
- `src/renderer/style.css`
- `src/core/selection-map.ts`
- `src/core/reader-edit.ts`
- `src/renderer/reader-editable-block.tsx`
- `tests/core/reader-edit.test.ts`
- `tests/e2e/a7-3b-packaged.mjs`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`

### 测试和命令

```powershell
node --test tests/core/reader-edit.test.ts tests/core/markdown-edit-transaction.test.ts
npm.cmd test
npm.cmd run typecheck
git diff --check
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run package
npm.cmd run test:e2e:a7-3b
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
```

结果：核心阅读编辑/事务测试 `6/6`；全量单测 `236/236`；类型检查、Windows x64 生产打包、A7.3b（新增阅读编辑与跨模式 undo/redo）、A8.4 和 A8.5 打包回归全部通过。第一次 A7.3b 复跑在模式切换后没有聚焦源码文本框，导致测试脚本误报撤销超时；补回真实焦点后复跑通过，未改变产品断言。打包与回归结束后没有残留 Electron、MerMarkd、Setup 或 Update 进程。

### 产物/截图

- 打包应用：`out/MerMarkd-win32-x64/MerMarkd.exe`
- 本批新增临时阅读编辑验收样本由 `tests/e2e/a7-3b-packaged.mjs` 创建并在 `finally` 清理，没有提交用户文档或 sidecar。
- B5 实现提交：`f933b34`；已推送到 `origin/main`。开发记录提交：`52405dc183ca77b72945d9baedd2f7a815dea9dd`；推送后 `git ls-remote origin refs/heads/main` 已返回同一 SHA。

### 失败与限制

- 阅读编辑暂只支持单行纯文本段落和 ATX 标题；含粗体、斜体、链接、实体、引用、列表、表格、代码、Setext 或跨行内容的块仍只读。
- 尚未完成真实中文 IME 设备验收、阅读模式内联格式编辑、跨块编辑和右键菜单 Shift+F10/方向键/Enter 的完整键盘导航。
- 共享 session 是 renderer 侧历史投影，主进程持有的 source revision/保存恢复合同仍是最终真相；不宣称任意第三方编辑器级别的全文协同历史。

### 下一步

本批收尾重新检查了源映射、dirty/sidecar 冻结、共享撤销边界、打包产物和三项回归；下一批优先推进干净环境安装/卸载、性能基线和高 DPI 验收，再回到阅读 inline 映射与右键菜单键盘可达性。

## 2026-10-02 · B5 收尾修正与 A8.6 安装/性能/DPI 复测

### 复查发现

提交前复核发现阅读块旧 blur 只比较正文内容，可能在切换到同内容文档后写入错误会话；旧 block 起点也可能命中新的段落。IME 组合期间的 Enter/Escape 会被普通键盘处理拦截，Ctrl+Enter 分支不可达；恢复草稿/备份的元数据操作会清空正文撤销历史；主进程拒绝 optimistic revision 后 renderer 仍会沿用无效 revision。

### 修正

- 阅读块提交携带并核验原可见文本、文档 epoch、路径、source hash、当前模式和编辑器 dirty 状态。
- 组合输入期间放行确认键，失焦在 compositionend 后再提交；Ctrl+Enter 先于普通 Enter 处理。
- 恢复操作只有正文实际变化时才重建共享 session；编辑 IPC 失败会使后续 optimistic 请求失效，并重新读取主进程确认版本。
- 新增 stale block 核心回归，保留 BOM/CRLF 与安全单块映射边界。

### 验证

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run package
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run make
npm.cmd run test:e2e:a7-3b
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
npm.cmd run test:qa:performance
```

全量单测 `237/237`、类型检查、打包和 A7.3b/A8.4/A8.5 打包回归通过。性能样本为 `5,242,880` 字节、`1,000` 标题和 `200` 张可见卡片：`extractSections 883.10 ms`、`buildCanvasScene 2.28 ms`、`arrangeCanvas 155.32 ms`、峰值 RSS `273 MiB`。

最新安装包为 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`，SHA-256 `EFFB5CEF8FD4425DDFBAC31A95EA4F8A11E7407E0629E2F31A83924F90571457`，大小 `154,898,944` 字节。干净 `%LOCALAPPDATA%\\MerMarkd` 静默安装退出码 `0`、耗时 `15,457 ms`，安装版四档 `1/1.25/1.5/2×` DPR 均通过模式切换、视口和 PNG 导出检查；1× PNG 为 `844 × 522`，卡片就绪约 `912–1,120 ms`。卸载退出码 `0`、耗时 `952 ms`，快捷方式和进程清除；Squirrel 仍留下 `.dead`、`Update.exe` 和 `app-0.1.0`，确认无进程后已清理测试安装目录。真实多显示器物理 DPI、自动零残留卸载和数十万短行压力仍未宣称通过。

本次修正和验收代码提交：`2f29f33`，已推送到 `origin/main`；日志提交随后补入远端核验结果。下一批继续处理阅读 inline 映射与右键菜单键盘可达性，并保持每批单独复查和推送。

## 2026-10-02 · B5.2 右键菜单键盘可达性

### 目标

补齐 B4/B5 留下的菜单交互缺口，使源码和阅读正文的选区右键菜单不依赖鼠标：可由 `Shift+F10` 打开，键盘可移动、执行和关闭，并保持现有选区身份校验。

### 修改

- `src/renderer/editor-view.tsx`：源码菜单打开后聚焦第一个可用项；支持方向键、Home/End、Enter/Space、Escape；源码编辑器支持 `Shift+F10` 从当前选区打开菜单。
- `src/renderer/main.tsx`：阅读菜单复用同样的键盘行为，并支持阅读模式 `Shift+F10`；菜单打开后焦点进入第一个可用操作。
- `tests/e2e/a7-3b-packaged.mjs`：新增打包版源码菜单键盘打开、焦点移动和关闭断言。

### 验证

```powershell
npm.cmd run typecheck
git diff --check
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run package
npm.cmd run test:e2e:a7-3b
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
```

结果：类型检查、diff 检查、镜像打包、A7.3b/A8.4/A8.5 打包回归全部通过；A7.3b 的键盘断言覆盖 `Shift+F10`、第一个菜单项焦点、ArrowDown 到下一项和 Escape 关闭。阅读 inline Markdown 映射、跨块编辑和真实中文 IME 设备验收仍未完成。

本批代码提交：`56e2d0b`，已推送到 `origin/main`；日志核验提交随后补入远端结果，再进入阅读 inline 映射批次。

## 2026-10-02 · B5.3 阅读 inline 映射与模式焦点

### 目标

让阅读模式在不反序列化整篇 DOM 的前提下编辑可证明安全的 inline Markdown 文本，并修复切换回源码模式后共享撤销快捷键失去焦点的问题。

### 修改

- `src/core/selection-map.ts`：为已解析的选择结果保留 BOM 去除源码中的 UTF-16 `sourceStart/sourceEnd`。
- `src/core/reader-edit.ts`：新增 exact text leaf 判断和局部映射编辑；只改动同一 inline leaf 内的可见文字，保留强调、链接目标等源码语法，实体/转义、跨 leaf、代码和跨行继续拒绝。
- `src/renderer/main.tsx`：阅读可编辑块从纯文本扩展到可逆 inline block，并继续绑定当前文档身份与 dirty/源摘要门槛。
- `src/renderer/editor-view.tsx`：源码模式从阅读或卡片模式激活时，把焦点交给 textarea，确保 Ctrl+Z/重做进入共享会话。
- `src/renderer/use-markdown-editor.ts`：`open()` 对已有 renderer 编辑会话幂等，避免陈旧模式回调重建 shared history。
- `tests/core/reader-edit.test.ts`、`tests/e2e/a7-3b-packaged.mjs`：新增粗体/链接源码保留、实体/跨 leaf 拒绝、阅读 inline 编辑和跨模式撤销回归；E2E 明确等待源码 textarea 获得焦点。

### 验证

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run package
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run make
npm.cmd run test:e2e:a7-3b
npm.cmd run test:e2e:a8-4
npm.cmd run test:e2e:a8-5
```

全量测试 `239/239`、类型检查、diff 检查、镜像生产打包和 Squirrel 安装包生成通过。A7.3b 通过 inline 映射、格式保留、跨模式 undo/redo、阅读右键菜单的 Shift+F10/方向键/Escape；A8.4/A8.5 回归通过。最新 Setup.exe 为 `154,900,480` 字节，SHA-256 为 `5FF3FF634A20DF892CF3DB5A2C734DDED202967DBF77D44C8605F869CE6D2BB0`。

### 失败与边界

首次 A7.3b 复跑曾在 inline undo 超时，诊断确认是测试在切换模式后焦点停留在 `BODY`；产品补上激活焦点，测试同时等待真实 textarea 焦点后通过。普通阅读块和单 inline leaf 已支持安全编辑，跨块、复杂 inline、实体/转义和完整中文 IME 真机验收仍未开放。真实安装器卸载、四档 DPR 和性能基线沿用上一批已核验结果，本批只重新生成安装包，未重复执行安装/卸载。

本批代码和日志将在收尾复查后独立提交并推送；下一步评估单 inline leaf 的加粗/斜体/引用命令是否能继续保持源码和 sidecar 边界。

## 2026-10-02 · B5.4 阅读单 leaf 安全格式命令

### 目标

让阅读模式在可证明的单个 exact inline leaf 上提供加粗、斜体和引用，同时继续把复杂 Markdown 留在源码编辑模式，并沿用现有 Markdown 选区命令与共享编辑缓冲区。

### 设计决定

- `SelectionResolution` 记录解析块和可见 UTF-16 范围，格式命令可以复核原始 DOM 选区的身份，不依赖再次搜索同名文字。
- `resolveReaderInlineFormatSelection` 只接受一个 exact text leaf；实体、转义、代码、跨 leaf、跨块和无法重建的边界直接返回不可编辑。引用只作用于普通段落，避免把标题变成引用中的章节；带 BOM 文档的首段也保守禁用引用。
- renderer 将 BOM/CRLF 源偏移转换为共享 session 的 LF 偏移，复用 `applyMarkdownSelectionCommand` 的加粗、斜体和引用语义，再调用 `changeEditorText` 写入已有撤销历史。所有操作仍停留在内存 dirty 缓冲区。
- 阅读右键菜单对复杂选区保留复制/批注能力，格式按钮 disabled 并提示切换源码视图；格式命令成功后可以切回源码逐步撤销，sidecar 和画布不参与写入。

### 修改文件

- `src/core/selection-map.ts`
- `src/core/markdown-selection-commands.ts`
- `src/core/reader-edit.ts`
- `src/renderer/main.tsx`
- `tests/core/markdown-selection-commands.test.ts`
- `tests/core/reader-edit.test.ts`
- `tests/e2e/a7-3b-packaged.mjs`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`

### 验证

```powershell
node --test tests/core/reader-edit.test.ts
npm.cmd test
npm.cmd run typecheck
git diff --check
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run package
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm.cmd run make
node tests/e2e/a7-3b-packaged.mjs
node tests/e2e/a8-4-packaged.mjs
node tests/e2e/a8-5-packaged.mjs
```

结果：reader-edit 核心测试 `8/8` 通过，全量单测 `242/242`，类型检查和 diff 检查通过；镜像 `package` 与 `make` 通过。A7.3b 打包版覆盖阅读上下文菜单、单 exact leaf 加粗/斜体/引用、切回源码核对和逐步撤销并通过；A8.4/A8.5 回归通过。最终 Setup.exe 大小 `154,900,992` 字节，SHA-256 `019AF4D77E8412D3A4FB8EFD4D954E900207391D405146B4135E08EFB2635F84`。

### 边界与下一步

这批没有开放跨多个 inline leaf 的结构化格式、列表/表格/代码/Setext、跨块编辑或中文 IME 真机验收。带 BOM 文档首段引用禁用是为避免破坏 BOM 首字节的保守门槛。收尾重新检查了 CRLF/BOM 偏移、菜单 disabled 状态、dirty/文档身份和共享 undo/redo，打包版复核后再提交推送。

## 2026-10-02 · B5.5 阅读正文剪切、删除与粘贴

### 目标

把阅读模式右键菜单补齐到剪切正文、删除正文和粘贴正文，同时保持 Markdown 字节、批注 YAML、画布 JSON 的独立保存边界，并处理新增菜单在低高度窗口中的可用性。

### 设计决定

- `resolveReaderMappedSelection` 统一核对当前 exact inline leaf、可见范围和源码范围；剪切、删除、粘贴都转换为共享编辑器的 LF 选区后调用 `applyMarkdownSelectionCommand`。
- 剪切在写入系统剪贴板后再次检查 epoch/source hash、当前正文和 editor dirty 状态；任一身份变化都放弃源码修改。阅读粘贴只接受非空单行文本，空剪贴板不会退化为删除。
- 菜单高度采用 520 px 保守预算，CSS 增加 `max-height` 和滚动；选区监听在菜单取得焦点时保留已验证 probe，避免原生选区因焦点移动导致菜单关闭。
- A7.3b 的第三份 fixture 现在带有效 annotations/canvas sidecar，三项阅读命令前后均比较 Markdown、YAML、canvas 的字节和 mtime。

### 修改文件

- `src/core/markdown-selection-commands.ts`
- `src/core/reader-edit.ts`
- `src/renderer/main.tsx`
- `src/renderer/style.css`
- `tests/core/markdown-selection-commands.test.ts`
- `tests/core/reader-edit.test.ts`
- `tests/e2e/a7-3b-packaged.mjs`
- `docs/PROGRESS.md`
- `docs/DEVELOPMENT_LOG.md`
- `docs/DECISIONS.md`

### 验证

命令：`npm.cmd test`、`npm.cmd run typecheck`、`git diff --check`、镜像 `package/make`、`npm.cmd run test:e2e:a7-3b`、`npm.cmd run test:e2e:a8-4`、`npm.cmd run test:e2e:a8-5`、`npm.cmd run test:e2e:qa-installed`、`npm.cmd run test:qa:performance`。

当前验证结果：核心全量测试 `243/243`、类型检查和 diff 检查通过；A7.3b、A8.4、A8.5 通过。A7.3b 输出 `exactCrLfBomRoundTrip=true`、`dirtyPreviewSidecarsFrozen=true`、`recoveryDrafts=1`；A8.4 输出 `structuralSave=true`、`reopen=true`；A8.5 输出 `dirtyOwnTransactionRecovery=true`。四档 DPR `1/1.25/1.5/2` 均通过，1× PNG 为 `844 × 522`；性能样本为 `extractSections 813.64 ms`、`buildCanvasScene 1.97 ms`、`arrangeCanvas 142.77 ms`、峰值 RSS `269.04 MiB`。

本批 Setup.exe 为 `154,901,504` 字节，SHA-256 为 `775867EB76FADB6CBFA4D0F37D76433DFA4F7F4F3CCBBAE3E4AE1B4372EFDC8F`。干净安装退出码 `0`、约 `9,750 ms`，79 个文件、`527,580,699` 字节；官方卸载退出码 `0`、约 `741 ms`，无残留进程。Squirrel 卸载瞬间留下 `app-0.1.0`、`.dead` 和 `Update.exe`，已在确认无进程后清理测试安装目录；既有 `%APPDATA%\MerMarkd` 未删除。

### 边界与下一步

跨多个 inline leaf 的结构化格式、多行/跨块编辑、列表/表格/代码/Setext 和完整中文 IME 仍保持保守限制。真实多显示器物理 DPI、数十万短行压力和卸载器自动零残留不作为本批通过项。下一批优先评估跨 leaf 结构化编辑的可逆补丁合同，再决定是否扩大阅读编辑范围。

## 2026-10-02 · B5.6 阅读模式严格纯文本粘贴

### 目标

修正阅读模式粘贴会把用户输入的 Markdown 标记当成语法的问题，使“编辑渲染结果”的粘贴行为保持纯文本语义；源码模式继续允许原始 Markdown 粘贴。

### 设计决定

- 新增 `escapeReaderPlainText`，只在阅读模式使用。它保护反斜杠、强调、链接、代码、删除线、HTML/表格标记、实体起始符，以及行首标题、列表、分隔线和有序列表标记。
- 转义后用现有 `SelectionMap` 做可见文字往返测试，未建立新的 DOM 反向序列化路径；编辑会话仍复用 B5.5 的共享撤销和文档身份核验。
- 空文本、多行文本和无法证明的复杂块继续拒绝，用户可以切到源码模式进行结构化 Markdown 粘贴。

### 修改文件

- `src/core/reader-edit.ts`
- `src/core/markdown-selection-commands.ts`
- `src/renderer/main.tsx`
- `tests/core/reader-edit.test.ts`
- `tests/core/markdown-selection-commands.test.ts`
- `docs/PROGRESS.md`
- `docs/DEVELOPMENT_LOG.md`
- `docs/DECISIONS.md`

### 当前验证

核心新增测试覆盖 `**...**`、实体、链接、标题、列表、thematic break、前导空白拒绝和 quote 空选区拒绝；完整单测 `244/244`、类型检查、打包版 A7.3b/A8.4/A8.5 均通过。最终 Setup.exe 为 `154,901,504` 字节，SHA-256 为 `12324CA007418F3143EA00BEDAAF66D5095730BF2ACB88A0242A64759942046D`。

安装版 QA 四档 DPR `1/1.25/1.5/2` 通过，1× 导出尺寸 `844 × 522`；5 MiB/1,000 标题/200 卡片性能样本为 `extractSections 794.31 ms`、`buildCanvasScene 2.01 ms`、`arrangeCanvas 136.28 ms`、峰值 RSS `272.89 MiB`。

### 边界与下一步

本批不扩大跨多个 inline leaf 的格式化、跨块/多行粘贴、列表/表格/代码结构编辑或中文 IME 真机范围；下一步仍先评估可逆结构化补丁，再决定是否开放更复杂阅读编辑。

## 2026-10-02 · B5.7 连续 dirty 编辑、冻结选区与卡片尺寸

### 触发问题

真实操作中，右键菜单抢走焦点会让浏览器折叠原生选区，随后批注入口退化为“请先在正文中选择”；第一次正文修改进入 dirty 后，阅读模式的后续编辑也被整体冻结；卡片布局缺少可持久化的尺寸调节入口。

### 实现

- 右键菜单打开时同步记录 pending guard，直到菜单关闭才允许 `selectionchange` 清理选区；冻结记录绑定建立时的正文快照，正文再次变化后旧菜单安全失效。
- 阅读映射和右键正文命令改用当前 `readerDocument`，因此多个编辑命令可以在同一个内存缓冲区连续执行。批注 YAML 与画布写入继续受 dirty gate 保护，不把 sidecar 锚定到旧源版本。
- `SelectionMap` 为 GFM `tableCell` 增加源码块，并允许完整选择单个行内代码叶；转义/实体内部和不完整代码范围仍拒绝。renderer 的 `td/th` 组件带上对应源码块起点。
- `CanvasStateV2.cards[].size` 采用兼容旧文件的可选字段，侧栏使用受限数值输入更新宽高，场景组边界和卡片正文同步采用该尺寸，导出只传递场景几何。

### 验证

`npm.cmd test` 通过 `248/248`；`npm.cmd run typecheck` 和 `git diff --check` 通过；新增 selection-map 表格/行内代码、连续 dirty 编辑以及 canvas v2 尺寸往返测试。A7.3b、A8.4、A8.5 打包回归通过。安装版四档 DPR `1/1.25/1.5/2` 均通过，1× 导出 `844 × 564`；性能样本为 `extractSections 1511.41 ms`、`buildCanvasScene 3.62 ms`、`arrangeCanvas 283.36 ms`，峰值 RSS `247.09 MiB`。`npm.cmd run make` 通过；Setup.exe `154,902,528` 字节，SHA-256 `84128DAE7AFB9E843594CE60E154E3D34455F50782428BC921454548C2A183B2`。

### 后续边界

跨多个 inline leaf 的结构化格式、多行/跨块编辑、列表紧凑项无段落映射、复杂 HTML 和真实中文 IME 设备仍保持保守限制；本批不改变三文件保存事务，也不把 dirty 期间的批注/画布候选直接写盘。

## 2026-10-04 · B1.2 工作区级保存与阅读位置连续性

### 触发问题

试用反馈显示，阅读模式进入 dirty 后缺少明显的保存入口，用户需要猜测应切到源码模式完成保存；三种模式切换时也容易丢失阅读附近位置，导致同一份文档像被打开了多个互不关联的页面。

### 实现

- `AppShell` 在 dirty 状态下显示工作区级保存、放弃和二次确认控件，并注册统一的 `Ctrl+S`。保存状态复用 `useMarkdownEditor` 的主进程事务，未新增文件写入路径。
- 移除源码视图自身的保存快捷键监听，避免与工作区级快捷键重复触发；源码视图仍保留显式保存按钮。
- `main.tsx` 在离开阅读模式时记录当前文档路径和 `window.scrollY`，返回同一文档时恢复滚动位置；从卡片编辑指定章节时清除旧位置并按章节重新定位。
- 顶栏保存动作采用短时按压反馈和明确文字，未加入键盘触发动画；放弃确认保留在工作区内，避免浏览器原生确认框打断上下文。

### 修改文件

- `src/renderer/app-shell.tsx`
- `src/renderer/main.tsx`
- `src/renderer/editor-view.tsx`
- `src/renderer/style.css`
- `docs/PROGRESS.md`
- `docs/DEVELOPMENT_LOG.md`

### 验证

命令：`npm.cmd test`、`npm.cmd run typecheck`、`git diff --check`、`npm.cmd run start`。

结果：全量单测 `248/248`、类型检查和 diff 检查通过。开发服务器完成 Vite renderer、main 和 preload 构建；随后 Electron 运行时下载因本机网络 `fetch failed` 退出，因此本批没有新增真实窗口截图或打包版 E2E 证据。

### 边界与下一步

保存、放弃和位置恢复仍需在 Electron 运行时缓存可用后执行打包版回归，特别是 420 CSS px 下顶栏布局。下一批优先收敛窄窗口工作区抽屉、焦点返回和卡片工具栏密度；批注草稿与跨块阅读编辑不在本批放宽。

## 2026-10-04 · B1.3 窄窗口抽屉与画布工具栏收敛

### 目标

收敛窄窗口工作区侧栏和卡片画布工具栏，降低遮挡、焦点丢失和图标密度带来的使用成本，同时保持现有数据写入边界与自动化选择器稳定。

### 用户反馈/需求来源

继续迭代时优先处理窄窗口侧栏缺少模态边界、Escape/焦点行为不完整，以及画布工具栏连续图标难以识别的问题。

### 设计决定

- 左右工作区侧栏在窄屏采用遮罩抽屉；Escape、遮罩和关闭按钮共用关闭路径，关闭后把焦点还给对应顶栏入口。窄屏 Tab 只在当前抽屉内循环。
- 抽屉使用 `100dvh`、安全区底部间距和 `overscroll-behavior: contain`；全局控件使用触控友好的 `touch-action` 与 tap highlight 设置，并保留 coarse pointer 的 16px 表单字体。
- 画布工具栏将导航与缩放保留在前排，整理/折叠/撤销重做进入“更多”，保存和导出改为带文字的明确入口；原 `data-canvas-*` 选择器全部保留，避免已有回归脚本失效。

### 修改文件

- `src/renderer/app-shell.tsx`
- `src/renderer/canvas-view.tsx`
- `src/renderer/style.css`
- `docs/PROGRESS.md`
- `docs/DEVELOPMENT_LOG.md`

### 测试和命令

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check -- src/renderer/app-shell.tsx src/renderer/canvas-view.tsx src/renderer/style.css
npm.cmd run package
```

全量单测 `248/248`、类型检查和改动文件 diff 检查通过；`npm.cmd run package` 的 Vite renderer、main 和 preload 构建通过，但 Forge 在复制 Electron/native 依赖时因外网 `ETIMEDOUT` 失败。

### 产物/截图

本批没有新增打包版截图或安装包；Electron 运行时下载失败，无法进行真实窗口和硬件触控验收。

### 失败与限制

尚未在真实手机或触控设备验证抽屉手势，也未新增打包版 B1.2 保存/放弃/阅读位置回归。桌面开发环境只能证明 CSS/键盘实现与生产构建，不足以宣称移动硬件通过。

### 下一步

Electron 运行时缓存恢复后补跑 B1.2 与本批窄屏抽屉键盘流程，并检查 420 CSS px 顶栏与画布工具栏截图；随后再评估批注草稿和跨块阅读编辑。

## 2026-10-04 · B1.4 工作区状态、选区能力提示与画布结构可发现性

### 触发问题

上一批虽然把保存和窄屏抽屉放进工作区，但保存入口仍只在 dirty 时出现；阅读模式的复杂选区只能看到失败提示，不能直接跳到对应源码；画布的结构变更入口与普通布局操作混在一起，卡片也缺少章节路径和快捷结构动作。

### 实现

- 顶栏始终保留保存、放弃和另存为入口，并新增正文/批注/画布三段状态摘要。`Ctrl+S` 与 `Ctrl+Shift+S` 统一由 `AppShell` 处理；新建临时文档的后者进入首次路径选择，已有文档则给出明确的三文件事务未开放提示，未绕过现有保存安全门槛。
- 阅读选区显示“可直接编辑”或“需要源码模式”。可取得源码块起点时，按钮会切换到源码并将编辑器焦点定位到对应的 BOM/换行归一化偏移；可证明选区另有“进入编辑”入口。
- 模式快照增加阅读章节：切入卡片/编辑时仍回到各自顶部，返回阅读时恢复原滚动位置和章节；卡片显示标题路径并提供卡片级提升一级命令。
- 画布属性面板明确分成“结构操作”和“布局与关系”，层级选择显示深度；窄屏属性区限制高度并允许独立滚动，避免压缩或裁切画布。
- `src/renderer/index.html` 与镜像入口补充 `viewport-fit=cover`、`interactive-widget=resizes-content`，与既有 `100dvh`、安全区和 `overscroll-behavior` 配套；未把桌面模拟当作手机硬件验收。

### 修改文件

- `src/renderer/app-shell.tsx`
- `src/renderer/main.tsx`
- `src/renderer/canvas-view.tsx`
- `src/renderer/style.css`
- `docs/PROGRESS.md`
- `docs/DEVELOPMENT_LOG.md`

### 验证

`npm.cmd test` 通过 `248/248`；`npm.cmd run typecheck` 通过。`git diff --check` 仅保留已有用户 fixture 的 EOF 空行提示。`npm.cmd run package` 的 renderer/main/preload 生产构建通过，但 Forge 在复制 Electron/native 依赖时因网络 `ETIMEDOUT` 失败，未新增安装器或真实窗口截图。

### 后续边界

另存为三文件事务、dirty 批注草稿、Worker/虚拟化、大文档性能预算、多文档会话、外部文件 watcher、扩展语义渲染和真实多显示器 DPI/卸载残留仍未闭合；本批不把这些能力标成已完成。

## 2026-10-04 · B1.5 卡片画布布局恢复与可调空间

### 触发问题

卡片模式中父章节经常停在画布左上角；画布容器高度固定，卡片可移动空间受限；`mixed-layout.md` 的旧 sidecar 还保存了脱离当前场景的极端视口，载入后卡片实际存在但用户看到空白画布。

### 实现

- `arrangeCanvas` 为顶层组增加 80px 画布边距。渲染器在检测到新卡片、源结构未匹配变化、未初始化坐标或根卡片仍位于默认角落时重新布局，子卡片仍保留相对父组坐标。
- `canvas-scene-v2` 增加嵌套场景边界计算和视口相交核验；视口完全在场景外时自动调用 `fitView`，避免无条件恢复 stale viewport。
- `fitView` 完成后把 React Flow 的实际 viewport 回写到内存模型，后续拖动或显式保存不会重新提交旧的脱离场景视口。
- sidecar 解析失败时保留原文件，回退到当前 Markdown 的内存模型并显示信息提示，而不是把错误状态当作空画布。无法构造当前场景时仍进入原有安全错误路径。
- 画布工作区增加底部指针拖拽条，调整高度范围为 `360–1200px`；窄窗口把同一高度应用到 React Flow 区域，属性面板仍独立滚动。

### 验证

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check -- src/core/canvas-scene.ts src/core/canvas-scene-v2.ts src/renderer/canvas-view.tsx src/renderer/style.css tests/core/canvas-scene.test.ts tests/core/canvas-scene-v2.test.ts
```

结果：全量单测 `249/249`、类型检查通过；核心画布测试覆盖顶层边距和过期视口回退。Electron 窗口拖拽和 `mixed-layout.md` 实机回归待运行时缓存可用后补跑。

## 2026-10-11 · 简约性与实用性设计评审（仅规划）

### 目标与需求来源

用户要求检查当前项目与简约、实用的成熟产品体验之间的差距，并列出下一步改进方案。

### 评审与设计建议

基于当前源码、较新的进度/ADR 和历史打包截图，识别重复工具栏、状态与行为冲突、分散侧栏、专注模式覆盖不完整、受限编辑反馈和画布表单密度等问题。使用 `emil-design-eng` 技能，并核对 Microsoft 命令栏与 Obsidian 面板/模式官方说明。形成 UX1–UX5 顺序，优先统一入口和能力提示，再推进共享面板、连续任务、画布和视觉质量。所有建议仍待实施，未形成新的架构决定。

### 修改文件

新增 `docs/DESIGN_REVIEW_2026-10-11.md`；更新 `docs/PROGRESS.md` 和本日志。产品源文件与用户既有修改未由本轮改动。

### 检查、产物与限制

执行源码搜索/读取，查看 `out/qa/dpi-1-installed.png`、`out/qa/a8-4-wide.png`、`out/qa/b1-shell-wide.png`，并运行 `git diff --check -- docs/DESIGN_REVIEW_2026-10-11.md docs/PROGRESS.md docs/DEVELOPMENT_LOG.md`。截图来自历史构建，本轮未生成最新窗口截图，未进行用户实测或重新执行单测、类型检查、打包；不把旧界面截图当作最新切片验收。文档产物留在本地，未提交或上传 GitHub。

### 下一步

实施 UX1：统一模式/能力文案、合并正文保存入口、收起正常状态下的维护和结构表单，并用当前构建验证 clean/dirty/冲突/临时文档与窄窗口状态。

## 2026-10-11 · UX1 统一入口、能力承诺和默认首屏

### 目标与需求来源

按设计评审开始第一批开发，并同步上传 GitHub。范围为 UX1：减少默认辅助控件、合并正文保存、如实显示选区能力和三类状态。

### 实现与设计理由

顶栏保留单一正文保存；文件名只在外壳显示，阅读中的文档自身标题照常渲染。放弃、恢复、首次选择路径及文档信息进入文档菜单；不存在的已有文件另存为不再展示。批注详细检查入口移入文档状态，源码结构表单默认关闭。弹层使用原生 Tab 顺序，支持外部点击关闭、Escape 和焦点归还；窄窗口保留阅读查找。

状态分为正文/批注/画布，由实际控制器提供；聚合优先显示失败，再显示警告和处理中。画布结果按路径和源码摘要绑定，重新打开文档清空旧结果。阅读段落的本地草稿状态连接全局保存，Ctrl+S 或顶栏保存先提交该段，再沿既有源码事务落盘。Escape 重新生成原有 React 语义内容，保留格式和链接行为。没有扩大可编辑语法范围，没有新增依赖或数据模型/IPC；无需新 ADR。

### 排查与修复

初次打包回归发现，编辑控制器的状态回调和整个控制器对象依赖使阅读组件类型在状态刷新时变化，导致选区 Range 与冻结高亮失效。改为稳定状态回调和精确的会话/方法依赖，A7.3b 及 UX1 选区验证通过。

旧 E2E 的文件名、保存、结构工具和批注状态定位随新入口更新；A7.1 删除针对已移除的常驻选择提示的重复测试，仍验证目录选区不能作为正文批注。画布测试等待实际 draggable 状态和渲染帧，拖动按帧节奏发送指针；普通拖动等待落盘内容改变，避免误把上一次“已保存”状态当作本次保存完成。先前的失败及其原因已由对应回归复测。

### 检查与结果

`npm.cmd run typecheck`、`npm.cmd test`（252/252）和相关路径 `git diff --check` 通过。通过 `MERMARKD_ELECTRON_ZIP_DIR` 使用本机缓存的 Electron 44.4.1，`npm.cmd run package` 与 `npm.cmd run make` 均通过，生成 Windows x64 应用及 Squirrel Setup。

以下打包版脚本均通过：

`npm.cmd run test:e2e:ux1`、`test:e2e:b1`、`test:e2e:a6`、`test:e2e:a7-1`、`test:e2e:a7-2`、`test:e2e:a7-3b`、`test:e2e:a7-4`、`test:e2e:a7-5`、`test:e2e:a8-2`、`test:e2e:a8-4`、`test:e2e:a8-5`（各名称均由 npm run 执行）。

专项验证包括阅读中未失焦输入的快捷键/按钮保存、Escape 保留强调语义、跨强调选区准确显示能力、首屏结构表单隐藏、状态弹层 Escape 归还焦点、模式切换不改正文 bytes/mtime 且不新建 sidecar，以及画布外部冲突在正文已保存时仍显示失败。截图见 `out/qa/ux1-*`；人工检查宽/窄阅读与源码截图。

### 提交与剩余边界

分支 `codex/ux1-workspace-simplification`。先用 `445efe0` 保存工作区原有 B1.2–B1.5 前置实现与设计评审，再单独提交 UX1 代码、测试和日志；个人试读 fixture 与 hash 命名副本保留本地不提交。安装包仅本地生成，本轮不执行公开发行，也不声称已经过安装/卸载、真实中文 IME、多显示器 DPI 或大文档性能验收。下一批推进 UX2 共享面板与专注模式。

GitHub 同步结果：实现提交 `51d9fa7` 已推送至 `origin/codex/ux1-workspace-simplification`，前置提交 `445efe0` 一并上传。尝试通过 GitHub 连接器创建 PR 时返回 403 `Resource not accessible by integration`，未创建 PR、未合并 main；源码分支上传成功，不受该连接器权限影响。

## 2026-10-12 · UX2 共享面板、专注模式和视口布局

### 目标与需求来源

用户要求继续设计方案的下一批开发，并延续 GitHub 同步。以 UX1 已合并的 PR #1 / `71b96a7` 为基线，创建 `codex/ux2-shared-panels`，实现设计评审中的 UX2。

### 实现与界面复核

使用 `emil-design-eng` 复核层级、键盘和操作一致性，修改多份 TSX 后按 `vercel:react-best-practices` 检查状态、精确依赖、全局监听和可访问性。复核当前打包窗口截图，结果如下：

| Before | After | 用户收益 |
| --- | --- | --- |
| 外壳、阅读和画布分别有最近文件、目录、批注、信息、属性区域 | 左侧共享目录/最近文件，右侧按模式展示批注/属性/文档信息 | 面板入口位置稳定，减少重复占宽 |
| 专注开关不能覆盖各视图自有辅助区 | 一份会话状态统一隐藏并恢复面板，保留隐藏表单与滚动 | 随时回到当前任务，草稿和历史不因隐藏丢失 |
| 窄窗口不同辅助面板各自响应和管理焦点 | 单一模态抽屉、背景 inert、Tab 循环、Escape 返回入口 | 键盘不会误落到遮罩后的操作 |
| 画布依赖固定高度和手动调整条 | 自动填满工具栏下方可用高度，属性独立滚动 | 窗口变大即可获得更多画布空间 |
| 源码目录只改变光标偏移，目标行可能仍在屏幕外 | 显式跳转按不换行 textarea 的行高显示目标，普通重渲染不重复跳转 | 能直接看到所选章节且保持当前编辑位置 |

状态方案见 ADR-037。任务组件通过固定 portal 容器进入外壳，隐藏/显示不卸载表单。Ctrl+Shift+F 可从抽屉进入正文并返回原控件，阅读和源码 Ctrl+F 排除 Shift 组合。共享目录在阅读定位标题，在源码设置光标并显示目标行，在画布聚焦对应节点或可见父节点，不自动展开或保存。

### 修改文件

新增 `src/renderer/workspace-panels.tsx`；调整 `app-shell.tsx`、`main.tsx`、`reader-view.tsx`、`editor-view.tsx`、`canvas-view.tsx` 和 `style.css`。新增 `tests/e2e/ux2-workspace-panels-packaged.mjs` 与 npm 脚本；旧 E2E 使用可见面板入口和可见性判断，适配常驻隐藏 DOM。更新进度、设计评审、ADR 和本日志。个人试读 fixture 与 hash 命名副本继续留在本地，未纳入此批。

### 检查与结果

已执行 `npm.cmd test`（252/252）、`npm.cmd run typecheck`、`npm.cmd run package`、`npm.cmd run make`；使用 `MERMARKD_ELECTRON_ZIP_DIR` 指向本机 Electron 44.4.1 缓存。没有新增依赖或修改 lockfile。

最终构建的 13 组打包版 E2E 全部通过：`npm.cmd run test:e2e:ux2`、`test:e2e:ux1`、`test:e2e:b1`、`test:e2e:a6`、`test:e2e:a7-1`、`test:e2e:a7-2`、`test:e2e:a7-3b`、`test:e2e:a7-4`、`test:e2e:a7-5`、`test:e2e:a8-2`、`test:e2e:a8-3`、`test:e2e:a8-4`、`test:e2e:a8-5`（各名称均使用 npm run 执行）。UX2 专项已经通过：1200×800、800×700、420×800 CSS px 下三种模式无页面横向溢出；单抽屉/焦点循环和返回、专注期间批注与关系标签草稿保留、正文与源码位置、源码查找快捷键隔离、编辑撤销、窗口增高时画布变大。分别验证无 sidecar 时不会创建文件，以及现存 Markdown/YAML/JSON 的 bytes 和 mtime 在模式/面板/专注/尺寸切换后不变。

### 排查、失败与修复

- 共享目录和任务栏不再被卸载，旧脚本中“DOM 不存在”等于“面板关闭”的假设失效，改为实际可见性检查，操作前通过统一入口打开面板。A7.1 的目录选区检测仍验证不能复用正文选区，不删去数据保护断言。
- 专项窗口截图显示源码章节选择后内容仍在顶部，补充显式跳转的滚动定位，并防止回调变化重复应用旧 focus request。专项检查目标可见、光标和滚动在专注切换后不变。
- 新快捷键与源码 Ctrl+F 冲突，增加 Shift 分支隔离；专项验证不打开源码查找。
- A7.2 发现全局捕获阶段的 Escape 抢先关闭阅读查找，未归还查找入口焦点。仅批注重新定位取消保留捕获优先，其余 Escape 恢复冒泡，让局部查找/编辑/抽屉先处理。
- A8.3 的旧导出脚本未等待初始布局/上一次导出完成，且负坐标根卡触发 B1.5 已有自动恢复，导致预设的大场景缩回默认布局。改为通过导出菜单等待实际可用状态，使用初始化根位置和远处旁支覆盖视口外箭头/中文长标签，并新增导出前后画布 JSON 字节一致断言；未放宽尺寸断言或修改导出实现。
- 新测试最初在焦点 requestAnimationFrame 执行前断言返回位置；补充渲染帧等待。B1 旧脚本使用程序化 click，不会像真实指针一样转移焦点，因此根据菜单展开状态重开，避免把仍开的菜单再次关闭。专项测试保留真实指针和键盘输入。

### 产物、限制与下一步

截图为 `out/qa/ux2-{reader-wide,source-wide,canvas-wide,canvas-1200,canvas-800,canvas-420,drawer-800,drawer-420}.png`；人工查看阅读、源码、宽画布、420 px 抽屉和画布。打包日志与回归日志为 `out/qa/ux2-*.log`，安装包位于 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`。这些构建产物由 `.gitignore` 排除，仅留本地。

最终 Setup 为 `154,909,696` 字节，SHA-256 为 `DEAEDF0203E79704196CF886966AC13FB840B0F271EA2C3EA91321CFE1A66B5E`。A8.3 的完整 PNG/JPG 为 `1728×1024`、PDF 为 1 页，包含视口外卡片、跨层箭头和中文长标签，三份文档文件不被导出修改。尝试 `2228×1724` 场景时，本机离屏引擎实际返回 `2050×1233`，应用的尺寸核验明确报错并停止落盘；该既有引擎限制未在 UX2 扩展。

本批不公开发布安装包，未重新做安装/卸载全流程、真实中文 IME、多显示器 DPI 或大文档性能验收；P0 仍进行中。隐藏面板/专注期间的草稿保留已经验收，跨模式批注草稿、dirty 批注参考与保存后继续操作仍遵守既有边界，进入 UX3。完成此批 GitHub 提交/PR 后继续按 UX3–UX5 推进。

Git 基线核对：收尾 fetch 发现远端 PR #1 的合并历史更新为 `71b96a7`，其 tree 与原基线完全相同（`d4e6804ccf6439c4d616a0e9b83c30cc478d2a3a`）。在工作区和索引保持不变的前提下，将尚无 UX2 提交的本地分支基线对齐远端，避免 PR 携带旧的合并历史。相关 diff 检查通过。实现提交 `f33326d` 已推送至 `origin/codex/ux2-shared-panels`，GitHub 连接器成功创建 [PR #2](https://github.com/KLucen/MerMarked/pull/2)，目标 `main`，当前未合并；此次没有再出现权限不足错误。


## 2026-10-13 · UX3 阅读编辑与批注连续操作

### 目标与实现

用户要求继续下一批开发并延续 GitHub 同步。核对 PR #2 已合并，以 origin/main 的 16db676 为基线创建 codex/ux3-reader-continuity，按设计评审 UX3 处理正文编辑后批注中断和受限输入无反馈的问题。修改前核对产品架构、模式边界、开发流程、可行性审查、进度和 ADR，验收清单见 UX3_ACCEPTANCE.md。

沿用 emil-design-eng 的任务层级与反馈检查，按 vercel:react-best-practices 复核多份 TSX 的依赖、选区生命周期与可访问性；没有新增动画或依赖。当前打包截图复核如下：

| Before | After | Why |
| --- | --- | --- |
| 正文一旦未保存，批注区域不可用 | 保留批注参考，冻结旧位置及写操作 | 修改正文时仍能查看已有想法，不把旧锚点画到新文字上 |
| 编辑后需要重新保存、寻找选文、打开批注 | 提供“保存正文并继续批注”，保存后重新核验选文 | 连续操作有明确下一步，失败仍能看到自己的输入 |
| 模式切换或保存清除新批注表单 | 同文档会话保留草稿，正文变化后要求重选 | 输入不因工作流切换丢失，重复引文不会被偷偷重接 |
| 保存重建编辑历史 | 保存只推进基线 | 保存后仍可撤销，重做回磁盘版本恢复 clean |
| Enter、多行粘贴被忽略；跨格式输入失败只报错 | 提供原因、可复制的未应用输入和源码定位 | 用户可以继续完成编辑，正文不被不安全地改写 |

新增 src/core/reader-annotation-intent.ts，调整 reader-edit.ts、markdown-edit-transaction.ts、renderer main/use-markdown-editor/reader-editable-block/style。新增核心测试及 tests/e2e/ux3-reader-continuity-packaged.mjs，更新 A7.3b 与 npm 脚本。数据和会话边界记录在 ADR-038；没有修改主进程事务、IPC、YAML/JSON 格式或 lockfile。

### 检查与结果

实际执行 npm.cmd test（257/257）、npm.cmd run typecheck、改动文件 git diff --check、npm.cmd run package、npm.cmd run make，全部通过。构建使用 MERMARKD_ELECTRON_ZIP_DIR 指向本机 Electron 44.4.1 ZIP 缓存。

14 组打包窗口回归全部通过，依次运行 npm.cmd run test:e2e:ux3、test:e2e:a7-3b、test:e2e:a7-4、test:e2e:a7-5、test:e2e:a8-2、test:e2e:a8-3、test:e2e:a8-4、test:e2e:a8-5、test:e2e:a7-1、test:e2e:a7-2、test:e2e:ux1、test:e2e:ux2、test:e2e:b1、test:e2e:a6（各项均为 npm run 命令）。避免并行窗口争抢焦点和剪贴板。

专项使用带 BOM/CRLF、中文/emoji、重复引文、强调/链接及代码块的临时文件，通过打包 Electron 的实际指针/键盘输入完成：已有批注参考、修改后保存并创建新批注、保存后源码撤销/重做、草稿跨模式保留、正文变化后明确重选第二处重复引文并核对字节坐标、Enter/真实剪贴板多行粘贴/跨格式拒绝后恢复输入、代码块跳源码、外部磁盘冲突。检查 1200×800、800×700、420×800 CSS px 下控件和反馈不越界。程序化组合事件验证 compositionstart→blur 不提前提交、compositionend 后提交并可撤销；不代表真实操作系统输入法验收。

测试在相关操作前后比较 Markdown、批注 YAML、画布 JSON 的 bytes 与 mtime：模式切换、重选、受限操作、撤销/重做不写文件；新增批注只写 YAML；失败保存不覆盖外部正文或侧栏文件。A7.3b 仍直接调用主进程验证 dirty 时拒绝批注修改，没有仅依靠按钮禁用。

### 失败、排查与修复

- 首次 BOM 窗口编辑被旧 reader-edit 拒绝：文件解码将 BOM 与正文分开，旧核心要求两者同时存在。改为兼容分离元数据并保持调用者文本表示，新增从真实文件字节解码、编辑、重新编码的往返测试，确认没有重复 BOM。
- A7.3b 发现右键冻结选区与后续 selectionchange 的对象引用不同，严格引用比较错误阻止打开批注。改用冻结菜单自己的 epoch/source hash/完整正文快照，并在提交前重建映射。右键创建批注、取消重开和键盘导航回归通过。
- BOM 修复使原先错误禁用的剪切/粘贴等菜单可用；旧脚本期待 ArrowDown 跳过它们直达颜色，现改为等待菜单焦点后验证下一项“剪切正文”。dirty 边栏断言更新为可见只读和禁用修改，保留直接 IPC 拒绝与三文件未变断言。
- 新专项初版存在等待布局/光标帧不足、选择器拼写和误留旧脚本入口的问题，逐项修复；最终脚本完整退出成功。没有放宽数据字节、坐标或冲突断言。

### 产物与剩余边界

截图：out/qa/ux3-reference-only.png、ux3-restricted-{1200,800,420}.png、ux3-conflict-{1200,800,420}.png。人工查看宽屏只读批注、420 px 受限输入和 420/800 px 冲突草稿；抽屉可滚动，输入和操作可见。日志：out/qa/ux3-{unit,package,make}.log 与 ux3-regression-*.log。

Windows Squirrel 安装包为 out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe，154,911,744 字节，SHA-256 为 EDBED17ACF55D61D79E0B1FD1646635A6A0B2916F0AAED55CBEAD10908525088。安装包、截图与临时测试文件留在本地，未公开发行；个人试读 fixture 和 hash 命名副本不纳入提交。

未开放多行/跨块富文本编辑；未提交的新批注表单仅在当前文档会话保留，新开文档或重启不保证恢复。未重做安装/卸载全流程、真实中文 IME、多显示器 DPI 或大文档性能验收，P0 仍进行中。下一批为 UX4：精简卡片层级、按选中项显示操作、结构预览和完整导出说明。

GitHub：实现提交 `a9e9114` 已推送至 `origin/codex/ux3-reader-continuity`，连接器成功创建 [PR #3](https://github.com/KLucen/MerMarked/pull/3)，目标 main，尚未合并。 本轮 GitHub 同步成功，无权限错误。


## 2026-10-13 · UX4 画布层级、上下文操作与导出预检

### 目标与实现

用户要求继续下一批开发并延续 GitHub 同步。确认 PR #3 已合并，在 origin/main 39f72eb 基础创建 codex/ux4-canvas-clarity。修改前核对产品架构、模式边界、流程、可行性审查、进度和 ADR；验收样例见 UX4_ACCEPTANCE.md。

沿用 emil-design-eng 的界面层级与反馈检查，并用 vercel:react-best-practices 复核 TSX 的状态、异步生命周期、键盘入口和共享组件。没有新增动画、依赖或数据模型，沿用已有源跨度变换、批注映射与三文件事务，因此未增加架构 ADR。

| Before | After | Why |
| --- | --- | --- |
| 父组和正文卡片视觉接近，路径与零值计数重复 | 父组浅色虚线、正文白卡；路径放入属性，叶卡不显示子章节计数 | 先看内容与包含关系 |
| 每张卡片常驻多项图标，卡片与关系工具混排 | 仅选中卡片显示编辑与操作；属性随卡片/箭头切换，次要表单折叠 | 常用操作更容易识别，键盘仍能选取所有对象 |
| 创建关系和修改关系复用标签输入 | 独立的新关系草稿与选中关系标签 | 不覆盖尚未提交的输入 |
| 结构拖动跳入源码模式并直接展示完整差异 | 留在画布，先摘要/级别/批注影响，再展开源码 | 保持整理章节的任务上下文，确认和保存边界仍明确 |
| dirty 后只能切源码撤销 | 画布提示区直接操作共享正文撤销/重做 | 能当场退回，不触发落盘 |
| 导出菜单只有格式按钮 | 显示完整场景、折叠状态、数量与尺寸，超限禁用 | 提前说明输出范围，避免静默裁切 |

新增纯核心 canvas-export-preflight.ts，调用 buildCanvasExportScene 和 assertCanvasExportSize，保留完整父子坐标、箭头曲线及标签范围，折叠后代只计数一次。无效几何继续抛错，尺寸超限保留实际值。renderer 使用共享 CanvasStructurePreview；新预览按 request sequence、document epoch、路径、hash、正文快照和模式核验，晚到 token 显式取消。拖动还原与异步状态更新受 canvas generation 约束。

### 检查与结果

npm.cmd test：262/262 通过。npm.cmd run typecheck、改动文件 git diff --check、npm.cmd run package、npm.cmd run make 均通过；构建使用 MERMARKD_ELECTRON_ZIP_DIR 指向本机 Electron 44.4.1 ZIP 缓存。

按串行实际运行 npm.cmd run test:e2e:ux4、ux3、ux2、ux1、b1、a6、a7-1、a7-2、a7-3b、a7-4、a7-5、a8-2、a8-3、a8-4、a8-5（后续名称沿用相同 npm 脚本前缀），15 组全部通过。最终生成安装包后再次验证 UX4、A8.4、A7.3b，覆盖最后的异步 generation 保护和测试焦点等待修正。

专项在临时 BOM/CRLF 文件中放置三层嵌套、长正文、同名标题、跨分支箭头与重复引文批注。使用实际鼠标/键盘选择卡片与关系、编辑标签、删除与新增关系、拖入结构候选、取消恢复坐标、确认/撤销/重做和显式保存。比较 Markdown/YAML/JSON 的 bytes 和 mtime；关系操作仅写 JSON，取消/预览/确认/撤销/模式切换不写三份文件。保存核对批注字节位置、BOM/CRLF、卡片 ID、箭头身份与各自基线。

延迟主进程真实预览回复后切换到阅读，验证晚到 token 被取消，模式不被拉回，没有残留预览或文件写入。导出专项使用 13,428×404 超限场景验证真实范围、禁用三格式和文件不变；A8.3 继续验证完整 PNG/JPG/PDF 和视口外箭头标签。核心新增 5 项，覆盖完整几何、折叠计数、尺寸边界和无效几何。

### 排查、失败与修复

- UX4 首次撤销测试在候选重排引起提示条变高时取了旧按钮坐标，补充等待场景就绪和渲染帧后点击；保持 dirty、共享缓冲区与三文件零写入断言。
- 人工查看 420 px 预览截图发现窄屏抽屉落到页面下方：旧 cards/editor 静态定位选择器优先级高于媒体规则。提高抽屉规则优先级，新增抽屉 top=0、完整视口高度断言；源码与画布窄屏同步修复。
- A8.4 第二次拖动目标被保留的属性栏遮挡，原测试假设预览一定切换源码。取消后显式“适应全图”再拖动，继续验证实际投放、取消、三文件外部冲突和身份保留。
- A7.3b 首次在模式进入焦点帧前输入导致 dirty 等待超时，单独复跑通过；插入辅助函数增加渲染帧等待，确保焦点与章节定位完成后放置测试光标。没有更改产品阅读编辑或冲突逻辑。
- A8.2/A8.5/UX2 按新入口先展开新增关系或结构表单，保留原有持久化与草稿断言。移除导出超限的重复建议文字。

### 产物与后续

人工检查 out/qa/ux4-card-inspector.png、ux4-structure-420.png、ux4-export-limit-420.png；专项另有 1200/800 宽度截图。结构确认/取消完整可见，章节组弱化，选中卡片动作和键盘焦点清晰。日志为 out/qa/ux4-unit.log、ux4-package.log、ux4-make.log、ux4-regression-*.log。

安装包 out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe：154,914,816 字节；SHA-256 6462F765793D1497EF856CC42ADA4D8471AEF9284D6706027948811D83A2F064。产物本地生成，不公开发行。保留且不提交已有个人 fixture 与 hash 命名副本。

下一批 UX5 继续统一字体、间距、状态色和焦点反馈；真实中文 IME、多显示器物理 DPI、安装/卸载残留与大文档 Worker/虚拟化仍属 P0 未闭合门槛。本批不扩展实际导出引擎上限或发布产品版本。

GitHub：实现提交 `0728e9e` 已推送至 `origin/codex/ux4-canvas-clarity`，连接器成功创建 [PR #4](https://github.com/KLucen/MerMarked/pull/4)，目标 main，尚未合并。本轮推送与 PR 创建均成功。


## 2026-10-14 · UX5 视觉一致性、可读性与菜单焦点

### 目标与实现

继续用户授权的逐批开发和 GitHub 同步。在 UX4 83e749b 上建立 codex/ux5-visual-consistency；开发期间确认 PR #4 已合并为 ce031bd，git fetch origin 后核对两者代码树相同，再用 git merge --ff-only origin/main 快进基线，没有更改既有工作区内容。UX5 PR 直接面向 main。

修改前核对产品架构、模式边界、开发流程、可行性审查、进度和 ADR。沿用 emil-design-eng 做层级/可读性/反馈检查，并按 vercel:react-best-practices 复核组件、effect 清理、依赖和键盘语义。验收先记录在 UX5_ACCEPTANCE.md。

| Before | After | Why |
| --- | --- | --- |
| 各区域零散的字体、近似颜色和 10/11 px 辅助字 | theme.css 提供共享字号、字色、主色、圆角及常用间距；阅读 16 px、源码 13 px、辅助文字至少 12 px | 保持三种视图的可读性和视觉层级 |
| 焦点环偏浅、状态颜色各自定义 | 统一 2 px 焦点样式及警告/错误色，状态详情保留明确文字 | 键盘位置和失败状态更容易辨认 |
| 画布菜单可同时打开，空格受平移快捷键拦截 | 原生 details 语义配合互斥、Space/Enter、方向键/Home/End、Escape 和焦点归还 | 高频键盘操作即时、可预测 |
| 导出弹层在窄屏使用固定偏移 | 跟随触发器测量定位、限制可用高度并允许滚动，触发器离开视口时关闭 | 短窗口和缩放下操作仍可达 |
| 布局已经完成仍显示正在整理 | 布局完成后显示“布局已就绪 · 尚未保存” | 状态对应实际工作进度与磁盘边界 |

主要文件为 renderer 的 theme.css、style.css、use-canvas-toolbar-menus.ts、canvas-view.tsx 和 app-shell.tsx。菜单 hook 只管理呈现事件，在卸载时清理监听和 ResizeObserver；布局状态更新沿用 generation 校验。没有改变依赖、schema、IPC、领域模型或三文件保存，因此未新增架构 ADR。qa-installed.mjs 的临时目录清理增加绝对路径和前缀核验。

### 命令与结果

- npm.cmd run typecheck：通过；npm.cmd test：262/262。
- npm.cmd run package、npm.cmd run make：通过，使用 MERMARKD_ELECTRON_ZIP_DIR 指向本机 Electron 44.4.1 ZIP 缓存。最终修改后重新 package，复跑 UX5/UX4 和 DPR，然后用 npm.cmd run make -- --skip-package 从同一最终打包目录生成安装包。该参数由本机 Forge --help 核实；没有复用旧源码构建。
- 串行运行 npm.cmd run test:e2e:ux5，以及 ux4、ux3、ux2、ux1、b1、a6、a7-1、a7-2、a7-3b、a7-4、a7-5、a8-2、a8-3、a8-4、a8-5（同一 test:e2e: 前缀），16 组通过。覆盖既有选文、批注、冲突保存、章节拖放/撤销、恢复和完整导出流程；避免并行窗口争抢焦点与剪贴板。
- npm.cmd run test:e2e:qa-installed：通过。明确使用 out/MerMarkd-win32-x64/MerMarkd.exe，未设置安装版路径；DPR 1、1.25、1.5、2 下控件未越界。每档从进程启动累计到 renderer 就绪为 480/480/490/478 ms，阅读打开为 654/643/610/646 ms，卡片就绪为 901/753/721/756 ms；不是各阶段独立耗时。DPR 1 导出 PNG 为 844×564。
- npm.cmd run test:qa:performance：5,242,880 字节、1000 标题、200 卡片，extractSections 892.10 ms、buildCanvasScene 1.93 ms、arrangeCanvas 161.75 ms；各阶段采样 RSS 为 274.57/274.72/243.94 MiB，最大采样值 274.72 MiB。这是一次 Node 核心样本测量，没有 renderer 卡顿和端到端性能结论。
- 改动文件 git diff --check 与新 E2E 的 node --check：通过。

UX5 专项使用临时 BOM/CRLF、中英混排、emoji、GFM 表格/任务列表和代码样本，实际鼠标与 CDP 键盘输入覆盖原生菜单、跳过禁用项、循环方向键、动作关闭、Tab 离开、点击外部、焦点恢复。检查 1200×800、800×700、420×800、420×360 CSS px、200% 页面缩放、强制高对比与减少动态效果。比较正文、批注、画布的 bytes 和 mtime，确认模式、编辑缓冲撤销、菜单、窗口/缩放与媒体偏好变化均零写入。

### 排查与修复记录

- 空格打开 details 的测试失败，定位到 React Flow 在 document 上监听空格并 preventDefault。菜单 summary 的空格事件现在停止冒泡，同时保留浏览器原生展开默认行为；实际键盘回归通过。
- 状态按钮 Enter 测试未产生 click；事件记录显示键盘未被应用阻止，CDP helper 缺少 Enter 的回车文本负载。补齐原生按键文本并等待布局/焦点帧，没有用直接调用 onClick 替代键盘验收。
- Windows 分数缩放下声明 2 px 焦点环的计算值为 1.6 px（物理像素取整），断言改为可见宽度至少 1.5 px，同时保留样式声明和焦点对象核验。
- 截图显示初始布局完成后仍保留“正在整理”；修正完成分支消息，并断言可保存时状态已经就绪。
- 辅助字色在目录计数浅底上的对比不足，调整共享辅助色至 #5f6c80，并增加目录计数对比断言；正文、链接和警告文字对比也通过。
- 最后补充滚动边界：触发器离开视口时关闭弹层，避免固定菜单停留在负坐标。最终包专项通过。

### 产物与后续

人工查看 out/qa/ux5-reader-{1200,420}.png、ux5-source-420.png、ux5-source-dirty.png、ux5-export-420-360.png、ux5-zoom-200.png、ux5-forced-colors.png。确认语义排版、源码字符、短窗口导出和焦点可见。日志为 out/qa/ux5-{unit,package,make,make-final,e2e,dpi,performance}.log 与 ux5-regression-*.log；四档 DPR 截图在 out/qa/ux5-dpi/。

最终 Squirrel 安装包 out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe：154,915,328 字节；SHA-256 111AF1089050CE6D0F416789CF72ACEBEE43DFADD1589E600623C381BAB9C2AA。安装包和截图留在本地，没有公开发行。原有个人试读 Markdown、画布 fixture 和 hash 命名 HTML 副本均不纳入提交。

真实中文 IME、跨显示器物理 DPI、干净机器安装/卸载残留仍未验证；模拟 DPR 不能代替这些门槛。下一批先测量长文档 renderer 打开/查找/编辑响应性，再推进可取消的后台解析、过期结果保护与必要的虚拟化。UX5 的视觉和菜单切片完成不代表发布质量或 P0 整体完成。

GitHub：实现提交 `6c8c4f6` 已推送至 `origin/codex/ux5-visual-consistency`，成功创建 [PR #5](https://github.com/KLucen/MerMarked/pull/5)，目标 main，尚未合并。本轮推送和连接器 PR 创建均成功。


## 2026-10-14 · PERF1 后台目录与阅读解析复用

### 目标与实现

用户继续下一批开发并延续 GitHub 同步。以 UX5 802a00f 建立 codex/perf1-background-outline；收尾 fetch 后确认 PR #5 已合并为 348037b，代码树相同，用 git merge --ff-only origin/main 快进基线。先阅读产品架构、模式边界、开发流程、可行性审查、进度和 ADR，再记录 PERF1_ACCEPTANCE.md。

本批针对源码输入后的全文目录解析和查找/状态刷新引起的正文重复解析。core/source-outline.ts 提供只读目录投影及线性 CRLF 偏移映射；renderer 的 SourceOutlineTask/Worker/useSourceOutline 负责 120 ms 合并输入、终止旧解析、15 s 超时与精确快照发布。当前阅读树和编辑源全文相同时直接复用。目录 pending/error 不提供旧索引，失败提供重试且完整源码仍可编辑、撤销、保存。

ReaderMarkdown 将插件配置移出 render，按 content/components 复用；阅读快照依赖内容和 dirty，提交回调通过当前控制器 ref 读取操作方法，避免 opening 或同内容草稿确认重建回调。内容/文档/权限变更继续更新正文及映射。章节预览在目录更新期间保留，生成和确认被 sectionsReady 双层禁用；重新就绪后仍按精确源快照核验。

| Before | After | Why |
| --- | --- | --- |
| 源码目录以 useDeferredValue 在界面线程重新全文解析 | 当前精确阅读树复用，其余源码解析可终止 Worker | 输入期间不积压同步解析，也不使用过期偏移 |
| 查找、状态和同内容确认重解析阅读 Markdown | 稳定插件、正文快照和语义回调，复用 DOM | 保留选区对象并减少重复工作 |
| 更新目录时空 sections 清掉已有结构预览 | 保留预览但禁用依赖新目录的命令和确认 | 用户仍可检查/取消，旧候选不能套到新源 |
| Worker 返回后章节高亮未随现有光标恢复 | 按同 epoch 的最新光标重新定位 | 后台更新保持源码导航连续 |

主要修改包括 renderer main/editor-view/reader-view/style、独立目录 Worker、核心投影、新 E2E 与性能脚本、npm 脚本和 Vite 条件解析。没有新增依赖、IPC、schema 或持久化字段；架构决定见 ADR-039。按 React best-practices 复核 effect 清理、语义依赖和 memo，并请独立代理只读审查。其额外验证 486 组 BOM/Unicode/实体/混合换行映射、2125 个命名实体及 serve/build resolver，没有修改文件或启动窗口。

### 命令与验证

- npm.cmd run typecheck：通过；npm.cmd test：269/269（原 262 项 + 7 项目录/取消专项）。专项涵盖完整 Markdown 语义、源偏移、替换任务、取消、重复/晚到回复、构造和 postMessage 失败、异常/解码失败、超时。
- npm.cmd run package：通过，MERMARKD_ELECTRON_ZIP_DIR 使用本机 Electron 44.4.1 缓存。npm.cmd run make -- --skip-package 从当前 package 输出生成最终 Squirrel 安装包；最后视觉调整后重新 package，并复跑 PERF1/UX5。
- npm.cmd run test:e2e:perf1 与既有 ux5、ux4、ux3、ux2、ux1、b1、a6、a7-1、a7-2、a7-3b、a7-4、a7-5、a8-2、a8-3、a8-4、a8-5（同一 test:e2e: 前缀），17 组最终通过。实际鼠标/键盘与真实 Worker 结合，延迟已排队的真实解析回复，验证取消、最新索引/光标、错误重试及文档切换；真实草稿 checkpoint 完成后核对同内容正文 DOM 身份。
- 开发入口验证：node_modules/.bin/vite.cmd --config vite.renderer.config.mjs --host 127.0.0.1 --port 5178 --strictPort；通过 MERMARKD_QA_RENDERER_URL 指向该地址，在 Electron preload 环境运行同一 PERF1 专项。成功后关闭本次服务；serve/build resolver 的最终条件也经独立审查核对。
- npm.cmd run test:qa:responsiveness：分别设置 MERMARKD_PERF_MIB=1/5 和可区分的 MERMARKD_PERF_LABEL，保留 baseline 与最终 stable 日志/JSON；最终性能样本测量时没有并行打包或窗口测试。完整前后五项数字见 PROGRESS.md。
- 改动文件 git diff --check、新 E2E 的 node --check：通过。模式/查找/目录失败与重试/未保存编辑和撤销比较 Markdown/YAML/JSON bytes 和 mtime，均未写三份内容文件。无 sidecar 的新文档不创建伴随文件。

### 失败与修复

- 首次打包 Worker 使用实体解码依赖的 browser 导出，报 document is not defined，进入可重试失败界面。Vite worker.plugins 的 config 条件被 resolved 配置覆盖，最终在 renderer resolve.conditions 中优先 worker，使开发服务与打包目录都使用 DOM-free 实现。普通浏览器语义与命名实体结果核对通过。
- 初版测试在 CDP 上重复声明全局 const 和序列化 DOM 返回值，分别出现重复声明与 object reference chain 错误。改为 IIFE 和 void 返回，不改变实际键盘、文件或过期结果断言。
- 首版异步目录恢复后未重新计算 activeSection，独立审查发现后绑定 editor epoch 与最新光标重算；另发现同内容 editor 元数据仍使 memo 失效，改为语义内容依赖和当前控制器 ref，并增加真实 checkpoint DOM 复用测试。一次 typecheck 提示 current 可能为空，补显式 null guard 后通过。
- A7.5 发现 pending 空目录使旧结构预览被清掉，原 stale-preview-disabled 等待失败。保留预览状态并显式 sectionsReady 禁用生成/确认，重新就绪后继续源文本比较；原预览取消、stale 拒绝和 BOM/CRLF 保存回归通过。
- 最初 5 MiB 测量有并行 Squirrel 负载，随后在独立测量中仍见首屏退步。消除初始重复目录解析，再稳定 opening 状态变化引起的提交回调，最终首屏 6595→4898 ms。全部中间日志保留，未将早期退步样本当作最终结果。
- A8.2 两次父卡拖动未改变坐标。等待 draggable 后增加两帧绘制，再读取实际标题位置；检查命中元素后移除诊断截图/日志，独立复跑通过。真实拖动持久化、子卡相对坐标、撤销/重做和原文/YAML 不变断言全部保留。

### 性能证据、产物与下一批

1,058,744 字节 / 205 标题样本：正文首屏 1762→1394 ms、打开查找 249→126 ms、唯一正文词查找 702→200 ms、切换源码 154→344 ms、源码输入到下一帧 235→102 ms。5,288,903 字节 / 1024 标题：6595→4898、1167→83、3272→504、437→597、1208→282 ms。首屏指标截止标题 DOM 与绘制帧，不包含所有后台核验。测量是同机单次前后点值，不是跨机器预算保证；源码切换壁钟耗时未改善。

最终 5 MiB 的首屏最长帧间隔 4721 ms、查找 442 ms、源码输入 113 ms，仍有明显阻塞。全部阅读章节/选区/扩展分析、DOM 查找和渲染未后台化，也未实现虚拟化，P0 性能门槛仍进行中。下一批 PERF2 优先首次阅读分析与加载期间的模式/文档/缓冲区隔离，再依据测量处理搜索和 DOM 渲染。真实 IME、跨显示器物理 DPI、干净机器安装/卸载仍待验收。

日志与 JSON 为 out/qa/perf1-{unit,package,e2e,dev-e2e,make-final,baseline,baseline-5m,stable-1m,stable-5m}.* 及 perf1-regression-*.log；保留中间 after/final/repeat/reuse 测量。人工查看 perf1-outline-error.png 和 perf1-outline-ready.png；失败提示可读、重试符合共享控件样式、计数用 — 区分未知与零章节。

最终 out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe：154,973,184 字节；SHA-256 388452CD8CFB964E7DCF34E56F771B9D75C5F510E2D9003ED569996D339FFB11。安装包本地生成，不公开发行。原有个人试读 Markdown/画布 fixture 和 hash 命名 HTML 保留且不提交。

GitHub：实现提交 `b8520e2` 已推送至 `origin/codex/perf1-background-outline`，成功创建 [PR #6](https://github.com/KLucen/MerMarked/pull/6)，目标 main，尚未合并。推送和连接器 PR 创建均成功。


## 2026-10-14 · 当前设计复核与后续批次重排（规划）

### 目标与实际发现

用户要求先重新确认问题和设计缺陷，再制定开发计划。本轮没有继续实现 PERF2。新增 docs/DESIGN_REVIEW_2026-10-14.md 并更新 PROGRESS.md；GitHub 只读确认 PR #6 已合并，未修改产品代码、依赖、数据模型或持久化规则。

复跑当前打包程序并检查入口代码，确认未提交批注草稿缺少离开保护：输入后状态仍为“已保存”，换文档没有提示，返回并再次添加批注时原文字已丢失。临时文档三个内容文件不变。该问题优先于原计划 PERF2，下一批改为 UX6A。阅读首次打开和正文查找仍同步阻塞；文件操作、两个保存入口、阅读编辑能力说明、卡片文本边界和搜索也有明确缺口。完整 Before/After 表、代码证据、七批范围及退出条件已写入评审。

### 本轮验证

- npm.cmd run test:e2e:ux5：通过；重新生成并检查开始页、阅读、源码、画布及窄/短窗口截图，菜单键盘、200% 缩放、高对比、减少动态效果和三文件零写入断言通过。
- MERMARKD_PERF_MIB=5，MERMARKD_PERF_LABEL=review-2026-10-14-5m 后运行 npm.cmd run test:qa:responsiveness：完成；输出 out/qa/perf1-review-2026-10-14-5m.json。5,288,903 字节 / 1024 标题首次阅读 5058 ms（最长帧间隔 4883 ms），打开查找 174 ms，正文查找 535 ms，切换源码 846 ms，源码输入到下一帧 344 ms。无并行构建负载，同机单次点值，不据此断言新回归。
- node out/qa/review-2026-10-14-draft-switch.mjs：复现未提交新批注丢失。输出 statusBefore=已保存、draftAfter=null、recreatedDraft=空字符串，三个内容文件 bytes/mtime 保持一致。脚本借用现有 UX3 的 CDP 辅助函数，在独立临时目录和用户数据目录运行；本地诊断脚本与 JSON 留在 out/qa，未作为正式修复回归提交。
- 直接调用 canvasCardContent：两条列表得到“第一项第二项”，表格得到“项目数值单价12”，确认摘要和全文共用扁平文本导致边界消失。
- 官方 Microsoft Command bar / Progress controls 用于命令层级和加载反馈参照；性能目标是项目提议，不是官方数值要求。采用 emil-design-eng 的 Before/After 检查格式。

没有重新运行全部单测、全部 17 组窗口回归、package/make、安装/卸载或物理 IME/DPI 验收。Node 提示 MODULE_TYPELESS_PACKAGE_JSON，但上述脚本均完成，不为评审临时更改 package 类型。所有测试子进程按 finally 退出。原有 hash 命名 HTML 与个人试读 Markdown/JSON 三项修改保持不变。

### 下一步与交付状态

新顺序为 UX6A → PERF2 → PERF3 → UX6B → UX7 → UX8 → QA1。先保护未提交表单和离开操作，再处理首次阅读分析、查找与渲染；之后完善文件入口、编辑能力和卡片内容。另存为、分页导出、更多方言单独列为后续候选，不混入首批。

本轮仅交付可审查的计划，尚未实施上述批次；文档保留在本地工作区，尚未提交或推送。没有新增 ADR，因为本轮没有执行新的架构或数据模型决定。P0 仍未完成。

## 2026-10-15 · UX6A 未提交输入与离开保护

### 目标与实现

用户授权执行下一批开发。按上一轮重新排序，先解决未提交批注被换文档或窗口关闭静默丢弃的问题。确认 PR #6 已合并，拉取并快进到 main `7736cd0`，建立 `codex/ux6a-draft-protection`。上一轮设计复核和计划一同纳入交付；个人试读 fixture 与 hash 命名 HTML 三项原有修改不纳入。

| Before | After |
| --- | --- |
| 批注表单已有文字，顶栏仍可能只显示已保存 | 新批注文字/标签、已有批注修改显示“有未提交批注”；保留的阅读失败输入显示尚未应用 |
| 换文档直接清空未提交表单 | 打开、新建、最近文件、拖入、重载和恢复确认共享离开保护 |
| 窗口只检查 Markdown dirty，无法发现 renderer 表单 | 先核验本地输入，再执行原正文保存/放弃/取消流程 |
| 放弃确认后取消文件选择可能丢表单 | 放弃只授权当前快照，成功切换才清空；失败或取消保留输入 |
| 已有批注编辑切换视图会消失 | 同一文档跨三视图保留，返回处理恢复焦点；其他批注操作不能覆盖未提交表单 |
| 未应用输入可能被后续失败覆盖 | 明确保留、计入离开保护，处理前暂停新的阅读块编辑 |

核心 `input-leave.ts` 把确认与实际离开分离；renderer hook 串行执行入口并恢复焦点，锁定期间禁止背景快捷键。窗口主进程通过唯一 ID 与所属主 frame 校验答复，超时或 renderer 不再就绪时拒绝许可；确认通过后重新检查当前 session。组合事件在捕获阶段覆盖三类输入，异步正文提交/批注写入计入忙状态。具体合同记入 ADR-040。

修改范围为主进程关闭协调、preload 窄 IPC、API 类型、工作区状态/入口、阅读块提交与共享外壳交互锁；新增纯核心测试、UX6A 打包专项和 npm 脚本。复核 React effect 清理、稳定回调、焦点、过期回复和文件清空时机。没有新增依赖、持久化字段或自动保存策略，锁文件未变化。

### 实际验证

- `npm.cmd run typecheck`：通过；最后整理 type-only import 位置后再次通过。
- `npm.cmd test`：273/273 通过。新增 4 项覆盖空输入、忙状态、取消/返回，以及文档/版本/文字/标签/锚点快照改变或等待中开始写入使旧许可失效。
- 设置 `MERMARKD_ELECTRON_ZIP_DIR` 指向本机已缓存 Electron ZIP 后执行 `npm.cmd run package`：通过。使用最终产品代码生成 `out/MerMarkd-win32-x64/MerMarkd.exe`。
- `npm.cmd run test:e2e:ux6a`：通过；使用独立临时 Markdown、sidecar 和 user-data，实际 Electron 窗口、IPC、原生文件拖入与关闭。对话框选择由主进程测试替身控制，不绕过离开协调。覆盖未提交状态、返回焦点、取消、明确放弃、文件选择取消、打开失败、跨模式编辑表单、保存挂起/失败、过期回复、未应用输入、组合事件、最近文件、外部修改后重载与最终实际退出，比较三个内容文件 bytes/mtime。
- 串行运行 `npm.cmd run test:e2e:<suite>`，suite 为 ux1、ux2、ux3、ux4、ux5、perf1、b1、a6、a7-1、a7-2、a7-3b、a7-4、a7-5、a8-2、a8-3、a8-4、a8-5：17 组全部通过。合计 18 组打包专项/回归。
- `npm.cmd run make -- --skip-package`：从已验证的打包目录生成 Squirrel 安装包；完成后复跑 UX6A 通过。类型声明的导入位置变化不影响运行时代码。
- 检查 `out/qa/ux6a-pending-note.png`：批注未提交状态可见，正文、表单及标签可读。未增加动画或更改全局视觉布局。

### 失败与修正

- 首次生成编辑脚本的模板字符串意外解释了源码中的插值，在写入前失败；改用不解释源码插值的生成方式，没有留下半写入文件。
- 专项粘贴脚本把换行直接放进 CDP JavaScript 字符串导致语法错误，改为 JSON 字符串传参后通过。
- 外部正文重载后旧批注需要定位，直接新建批注被原有保护拒绝。最终关闭测试先切换到干净第二文档再创建表单，保留原锚点安全规则。
- Node 调试器连接会阻止 Electron 进程退出，窗口销毁后继续请求 renderer 又会遇到上下文消失。改为主进程窗口 closed 事件写测试哨兵，断开调试连接后核验实际进程退出；未删减文件不变断言。
- 既有 Node MODULE_TYPELESS_PACKAGE_JSON 警告未阻止测试，不为该警告扩大本批 package 类型变更。

### 产物、限制与后续

日志和截图：`out/qa/ux6a-{typecheck,unit,package,e2e,make}.log`、`ux6a-regression-*.log`、`ux6a-pending-note.png`。安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`：154,975,744 字节，SHA-256 `915DEC4A8E5460B2419ABDCE0656FBC9BBC33FD98BFD8C9DF9A2E2D8F369DF9A`。本地生成，未公开发行。

未提交表单仍仅存在当前会话，未实现跨重启恢复。组合事件自动化不等于真实中文 IME；本轮没有重新安装/卸载、跨物理显示器 DPI 或大文档性能测量。首次阅读同步分析和 DOM 阻塞仍待 PERF2/PERF3；正文 dirty 的文件入口及保存语义按 UX6B 继续，不混入本批。P0 仍未完成。

GitHub：实现提交 `0442091` 已推送至 `origin/codex/ux6a-draft-protection`，连接器成功创建 [PR #7](https://github.com/KLucen/MerMarked/pull/7)，目标 main，尚未合并。PR 已附加到当前任务，推送和创建均无权限错误。下一批 PERF2，验证首次阅读章节/选区/扩展分析后台化、加载期间模式切换和过期结果隔离。

## 2026-10-15 · PERF2 首次阅读后台分析

### 目标与设计决定

用户继续下一批开发，按 10 月 14 日复核路线推进 PERF2。确认 PR #7 已合并为 `fd24690`，快进后建立 `codex/perf2-background-reading`；此前个人试读 Markdown / canvas JSON 与 hash 命名 HTML 三项修改保持原样。

| Before | After |
| --- | --- |
| 首次阅读的章节、选区和扩展分析分别在界面线程解析同一正文 | 三个只读投影共用一次 AST，在独立可取消 Worker 执行 |
| 初次大文档解析期间缺少加载、取消和错误恢复边界 | 显示加载状态，失败可重试或查看源码；离开阅读取消任务，拒绝旧回复 |
| 新旧正文派生数据可能需要依赖同步完成来保持一致 | 文档打开身份、完整正文、BOM 和重试序号绑定结果；render 时先隐藏过期偏移 |
| 只记录单次命令耗时，无法区分计算与显示 | 前后 1/5 MiB 各五次，记录加载、Worker、DOM、后续帧、长任务与 renderer 堆采样 |

详见 ADR-041 和 PERF2_ACCEPTANCE。保留已有独立核心入口，新结构候选仍重新解析；不新增依赖、IPC、schema 或三文件写入路径。正文 DOM 与阅读编辑的再次核验并未全面后台化，不能把本批实现当成整个性能阶段完成。

### 修改文件

- `src/core/markdown-snapshot.ts`、`reading-analysis.ts` 及章节/选区/扩展模块：共用只读解析快照，保持 BOM、CRLF、UTF-8 范围与 HTML 处理合同。
- `src/renderer/reading-analysis-task.ts`、Worker、hook、`main.tsx` 与状态样式：任务取消/超时/错误、精确缓存、加载状态与操作门控；源码目录复用已完成投影。
- `tests/reading-analysis.test.mjs`、PERF2 窗口脚本、响应性脚本与 package 命令：真实 Worker、安全边界与多轮性能证据。
- PERF1 测试注入只拦截源码目录 Worker；UX3 编辑后等待允许短暂 loading；A7.1/A7.2/A7.3b/A8.2/A8.4 显式固定窗口焦点仿真，避免遮挡导致 rAF 停止。

### 测试和实际命令

```powershell
npm.cmd run typecheck
npm.cmd test
$env:MERMARKD_ELECTRON_ZIP_DIR='C:/Users/KLucen/AppData/Local/electron/Cache/d69c2445857298b9bc0722ad3ce6e5cb9bf57d5c4eef6ff669ade3a51ef4d76b'
npm.cmd run package
# 分别执行 PERF2 / PERF1 / UX6A / UX1–UX5 / B1 / A6 / A7.1–A8.5 的已有 npm E2E 命令，共 19 组
npm.cmd run test:e2e:perf2
node_modules/.bin/vite.cmd --config vite.renderer.config.mjs --host 127.0.0.1 --port 5178 --strictPort
# 另一个终端执行专项，结束后关闭 Vite
$env:MERMARKD_QA_RENDERER_URL='http://127.0.0.1:5178'
npm.cmd run test:e2e:perf2
# 独立测量进程设置版本、大小、标签；改造前后 × 1/5 MiB × 五次
$env:MERMARKD_QA_EXE='C:/Users/KLucen/Desktop/MerMarkd/out/qa/perf2-ux6a-baseline/lib/net45/MerMarkd.exe'
$env:MERMARKD_PERF_MIB='5'
$env:MERMARKD_PERF_LABEL='perf2-stable-before-5m-1'
node tests/e2e/perf1-responsiveness-packaged.mjs
# 当前版不设 MERMARKD_QA_EXE；完整标签与结果见验收文档
npm.cmd run make -- --skip-package
npm.cmd run test:e2e:perf2
```

类型检查、280/280 单测、19 组打包窗口回归及真实开发服务 Worker 通过。生产 package 后运行所有窗口回归；运行时代码此后未变，make 使用该已验证目录生成 Squirrel 安装包，完成后再跑 PERF2 通过。单测覆盖共享树冻结、克隆后锚点、BOM/CRLF/emoji/重复引文、取消/旧回复、失败/重试和超时。窗口测试覆盖 pending/error、精确复用、换文档、dirty 版本、HTML 安全、bytes/mtime 和缺失 sidecar 不创建；旧三文件保存、恢复及导出回归保留。

五次前后对比：5 MiB 首屏帧中位数 4124 → 2419 ms、最差 4185 → 4256 ms；首次打开最长帧间隔中位数 4000 → 1300 ms。1 MiB 首屏帧中位数 973 → 992 ms，不能声称此样本加载更快。5 MiB 当前 Worker 分析 950 ms，结果到 DOM 989 ms、到后续帧 1328 ms，查找 414 ms、源码输入 245 ms。全量中位数/最差值、命令耗时与内存采样边界见 PERF2_ACCEPTANCE；不将 renderer 堆等同于全应用内存。

### 失败、修正与限制

- 初版仅把三个解析移入 Worker，5 MiB 单次命令为 6124 ms，计算重复未消除；改为一次 AST 三个只读投影后重新运行类型检查、单测、package 和窗口回归。
- UX3 原等待直接读取临时不存在的段落，因新增加载状态抛空值错误；改为允许 pending 后继续检查原内容和文件断言。PERF1 原全局 Worker 注入误拦新增 Worker，改为按入口筛选。
- A7.1/A7.2 的旧脚本在 Windows 遮挡时等待 rAF 挂起，Page.bringToFront 不足；核对临时测试进程后终止，增加 focus emulation 后重跑通过。一次重跑日志被旧测试进程占用，确认进程命令后停止再跑。没有终止用户日常程序或删减行为断言。
- 首次 Vite 启动进程提前退出，测试连接失败；用直接 vite.cmd / PTY 保持服务后成功。大段落测试偶尔在检查 pending 前已完成，改为挂起真实 Worker 回复以稳定取消场景。
- 大单段落切源码的自动化命令约 3 秒，进一步插入实际 click 时间戳发现分发前等待占大部分：最终 5 ms 更新模式、4 ms 取消 Worker；make 后复跑 4/4 ms。命令总计 3186/3244 ms 与点击响应不同，不据此推断全部是产品渲染延迟，也不只引用快样本宣布整体目标通过。
- 即使固定焦点仿真，5 MiB 首屏最差仍 4256 ms；Worker 内分析相对稳定，结果后的正文 DOM/布局有约 1.3 秒长任务，另有调度等待未完全拆分。查找、源码输入和模式切换预算仍待 PERF3。
- 既有 Node MODULE_TYPELESS_PACKAGE_JSON 警告不阻止运行，未为此改变全项目模块类型。未做干净环境安装/升级/卸载、真实中文 IME、物理跨屏 DPI、200 可见卡片与大量批注验收；P0 不宣告完成。

### 产物与下一步

日志：`out/qa/perf2-{typecheck,unit,package,make,dev-e2e,final-e2e,postmake-e2e}.log`、`perf2-regression-*.log`。截图：`perf2-reading-{pending,error,error-narrow,ready}.png`，已检查 420×360 状态及按钮可达。最终二十次结果为 `perf1-perf2-stable-*`，汇总 `perf2-stable-measurements.json`；早期结果仅作诊断。

安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`：155,022,336 字节，SHA-256 `D5A403C7741B4B2F79C87F7FBF7A82C99EB2273E98C96C74785AA3B8480A0E1E`，本地生成未公开发行。下一批 PERF3 聚焦正文渲染/绘制、可见正文索引与查询取消、源码输入及剩余调度瓶颈；不得按字符或换行随意切 Markdown，必须保留选区/锚点/查找和完整导出语义。

GitHub：实现提交 `1157b8e` 已推送至 `origin/codex/perf2-background-reading`，成功创建 [PR #8](https://github.com/KLucen/MerMarked/pull/8)，目标 main，尚未合并。推送和连接器 PR 创建均成功；PR 已附加到当前任务。

## 2026-10-16 · PERF3A 可取消的正文查找与索引复用

### 目标与设计决定

用户继续下一批开发。确认 PR #8 已合并为 `071bb59`，快进后建立 `codex/perf3-reader-search`。按小型可运行切片推进 PERF3，本批消除查找时重复的 DOM 遍历和全文字素分段，并支持中途输入/关闭；正文渲染及源码输入另批处理。三项用户已有 fixture / hash 命名 HTML 修改保持原样。

当前正文的连续块与文字节点区间在查找会话内复用，源版本/文档/模式或 DOM 可见性变化立即使其失效。索引和候选扫描约每 6 ms 检查让出/取消，只发布当前任务结果；单个布局或字素调用不能保证低于 6 ms。字面查询仅对候选边界使用 Intl.Segmenter.containing，保持 UTF-16 和完整字素语义。br/嵌套块分为不同索引项，禁止跨边界匹配。详见 ADR-042 与 PERF3A_ACCEPTANCE。

### 修改文件

- `src/core/visible-text-search.ts` 和 `markdown-reading.ts`：独立纯核心候选迭代器及兼容导出，拒绝的部分字素候选也保留可取消检查点。
- `src/renderer/reader-search.ts`、`use-reader-search.ts`、`main.tsx`、`app-shell.tsx`：可失效索引、异步任务身份、pending/error 呈现和旧着色清除；关闭时释放 DOM/Range 引用。
- `tests/visible-text-search.test.mjs`、两个 PERF3A 窗口脚本及 npm 命令：Unicode 参考对照、真实打包窗口、无写入边界及前后多轮性能测量。
- UX4 测试按实际键盘事件逐次等待选中节点投影更新，固定 focus emulation；不修改画布产品行为。
- 验收、阅读方言、架构决定与进度记录：保留全部性能样本和未通过门槛。

### 测试与实际命令

```powershell
npm.cmd run typecheck
npm.cmd test
$env:MERMARKD_ELECTRON_ZIP_DIR='C:/Users/KLucen/AppData/Local/electron/Cache/d69c2445857298b9bc0722ad3ce6e5cb9bf57d5c4eef6ff669ade3a51ef4d76b'
npm.cmd run package
# 串行执行 perf3a、perf2、perf1、ux6a、ux1–ux5、b1、a6、a7-1、a7-2、a7-3b、a7-4、a7-5、a8-2–a8-5，共 20 组
npm.cmd run test:e2e:perf3a
node_modules/.bin/vite.cmd --config vite.renderer.config.mjs --host 127.0.0.1 --port 5178 --strictPort
# 另一个终端执行；完成后停止 Vite
$env:MERMARKD_QA_RENDERER_URL='http://127.0.0.1:5178'
npm.cmd run test:e2e:perf3a
# 独立测量进程，不与构建或其他窗口回归并行
$env:MERMARKD_QA_EXE='C:/Users/KLucen/Desktop/MerMarkd/out/qa/perf3a-perf2-baseline/lib/net45/MerMarkd.exe'
$env:MERMARKD_PERF_MIB='5'
$env:MERMARKD_PERF_LABEL='stable-before-5m-1'
node tests/e2e/perf3a-responsiveness-packaged.mjs
# 基线和本批各 1/5 MiB × 五次，本批不设 QA_EXE；最终标签 final-after
node out/qa/perf3a-summarize.mjs
npm.cmd run make -- --skip-package
npm.cmd run test:e2e:perf3a
```

类型检查、283/283 单测、20 组生产打包回归与实际 Vite 专项通过。单测的 3600 组组合（12×12×25）与完整字素分段参考算法对照，另覆盖部分字素取消、limit、UTF-16 和长文本。窗口专项检查复用计数、DOM 变更、details/隐藏、嵌套块、1000 项、换词/关闭/模式/文档取消、失败恢复、空文件和 75,000 组 emoji 单段落，保留 Markdown/YAML/JSON 的 bytes/mtime 和缺失 sidecar 断言。420×360 成功/失败截图已检查。

### 失败、修正与限制

- 专项首次运行在 CDP 上下文重复声明全局 const、以及引号未正确转义的 selector 表达式失败，修正测试注入后通过。两个不同查询同为零结果时，测试增加后续帧等待，避免在新 input 尚未处理前读取旧文本。
- UX4 快速合成两次方向键在本批包两次停在前一项；上一批包同脚本通过。固定焦点仍复现，最终逐键等待 React Flow 选中节点投影的后续帧，通过原选择和文件断言；没有用直接设置 select.value 替代键盘路径。
- 最后复核发现 br 的内部 NUL 分隔符可能被含同样字符的查询命中；增加原始 HTML `<br>` 用例在修正前确认失败，改成独立索引项后重新 typecheck、package，并复跑 PERF3A/A7.2 相关窗口测试。最终性能样本重新采集，早期样本不作为最终结果。
- 5 MiB 大部分查找耗时和阻塞显著降低，但部分多结果/打开查找路径没有改善；1 MiB 普通查询近似持平。完整中位/最差值、首次 DOM、首屏、源码输入和堆采样见验收表，不仅展示有利结果。
- 缓存会保留当前查找会话的 DOM/Text/Range，关闭释放引用；堆采样未强制 GC，不代表 main/Worker 或 RSS。首次阅读与源码输入仍有长任务，不宣布 PERF3/P0 完成。
- Node 的既有 MODULE_TYPELESS_PACKAGE_JSON 警告不阻止测试；未扩大到全项目模块类型变更。未做干净环境安装/升级/卸载、真实中文 IME 或物理跨屏 DPI。

### 产物与下一步

日志及截图位于 `out/qa/perf3a-*`，最终二十次测量是 `stable-before-{1m,5m}-{1..5}` / `final-after-{1m,5m}-{1..5}`，汇总 `perf3a-measurements.json`。`out` 是本地忽略产物，未随源代码上传；安装包路径与最终摘要记录在 PROGRESS/PERF3A_ACCEPTANCE。

最终修正后生产 package 与 Squirrel make 成功，make 后再次运行 PERF3A 通过。安装包 155,022,848 字节，SHA-256 `2F684A9D62A48BD681EDF3990770033AD39B009102706F1E639689AB8DB8E55B`；本地生成未公开发行。

下一批 PERF3B 聚焦分析回复后的正文 DOM、布局和绘制调度，保持语义渲染、选区/批注锚点/查找及完整导出；随后处理源码输入和 200 可见卡片/大量批注窗口样本，再进入 UX6B → UX7 → UX8 → QA1。

GitHub：实现提交 `1e6c8c6` 已推送至 `origin/codex/perf3-reader-search`，成功创建 [PR #9](https://github.com/KLucen/MerMarked/pull/9)，目标 main，尚未合并。推送及连接器创建 PR 均成功；PR 已附加到当前任务。

## 2026-10-16 · PERF3B 后台准备语义正文

### 目标与设计决定

用户继续开发，按 PERF3B 推进。确认 PR #9 合并为 `7446e12`，快进后建立 `codex/perf3b-reading-render`；保留三项原有用户修改。检查发现 Worker 已做章节/选区分析，ReaderMarkdown 却仍在界面线程全文解析并进行 HTML 准备。先从上一批 nupkg 解出独立基线应用，再运行 CPU 诊断和前后多轮测量。

新增纯核心 `readingRenderFromSnapshot`，在同一解析快照的副本上按原序执行 HTML 容器占位、remark-rehype、rehype-raw、HAST 元素策略及 sanitize。完整 HAST 与三个投影共同取消、重试和缓存。界面通过准备树插件沿用 react-markdown 的组件、URL 处理及 node.position，只给 parser 空字符串。没有按字符拆 Markdown、虚拟化、注入 HTML 字符串或改动保存行为。设计表、验收与代价见 PERF3B_ACCEPTANCE / ADR-043。

### 修改文件

- `src/core/reading-render.ts`、`reading-analysis.ts`：共享源解析、复制只读 MDAST、输出安全 HAST；`markdown-reading.ts` 为既有 schema 补严格类型，不改值。
- `src/renderer/prepared-reading-plugin.ts`、`reader-markdown.tsx`、`main.tsx`：绑定已准备树，memo 与插件身份稳定，保留原正文组件。
- `package.json` / lockfile：显式固定已有 `remark-rehype@11.1.2`，没有升级传递包；新增两个 npm 验证命令。
- `tests/reading-render.test.mjs` 与两个 PERF3B 窗口脚本：新旧树/HTML/位置对照、冻结与结构化克隆、实际 Worker/DOM 边界及响应性采样。
- 架构、阅读方言、决定、进度与验收文档同步本批边界及剩余路线。

### 实际命令与结果

```powershell
npm.cmd install --save-exact --ignore-scripts --offline --no-audit --no-fund remark-rehype@11.1.2
# 离线元数据缺失后，执行同一固定版本安装
npm.cmd install --save-exact --ignore-scripts --no-audit --no-fund remark-rehype@11.1.2
npm.cmd run typecheck
npm.cmd test
$env:MERMARKD_ELECTRON_ZIP_DIR='C:/Users/KLucen/AppData/Local/electron/Cache/d69c2445857298b9bc0722ad3ce6e5cb9bf57d5c4eef6ff669ade3a51ef4d76b'
npm.cmd run package
npm.cmd run test:e2e:perf3b
# 串行执行原 20 组：perf3a、perf2、perf1、ux6a、ux1–ux5、b1、a6、a7-1、a7-2、a7-3b、a7-4、a7-5、a8-2–a8-5
node_modules/.bin/vite.cmd --config vite.renderer.config.mjs --host 127.0.0.1 --port 5178 --strictPort
# 另一个终端使用真实 preload；完成后停止 Vite
$env:MERMARKD_QA_RENDERER_URL='http://127.0.0.1:5178'
npm.cmd run test:e2e:perf3b
# 独立性能进程，基线/本批 × 1/5 MiB × 五次
$env:MERMARKD_QA_EXE='C:/Users/KLucen/Desktop/MerMarkd/out/qa/perf3b-perf3a-baseline/lib/net45/MerMarkd.exe'
$env:MERMARKD_PERF_MIB='5'
$env:MERMARKD_PERF_LABEL='before-5m-1'
node tests/e2e/perf3b-responsiveness-packaged.mjs
# 当前版不设 QA_EXE，使用 after 标签；CPU profile 只用于单独诊断
node out/qa/perf3b-summarize.mjs
npm.cmd run package
npm.cmd run make -- --skip-package
npm.cmd run test:e2e:perf3b
```

最终类型检查、286/286 单测、21 组打包 E2E 与 Vite 专项通过。最终 package 补入 npm 命令元数据，运行时代码与回归/性能采样一致；make 后 PERF3B 再次通过。窗口证明读取 → Worker 已清洗 HAST → 精确 DOM 位置 → 可见正文查找与模式缓存的完整流程；原数据写入、取消、dirty、保存、锚点、恢复与导出断言保留。

### 测量、失败与限制

- 同机各五次，5 MiB 首屏中位/最差 4352/4417 → 3446/3480 ms，回复至正文 DOM 1006/1031 → 69/72 ms，首次打开最长帧间隔 1338/1375 → 379/417 ms；1 MiB 首屏 1034/1047 → 798/819 ms。完整操作表和方法见验收文档，不把前后各一次诊断当最终结论。
- 5 MiB 首次打开后 renderer used heap 中位数 64 → 77 MiB，安全 HAST 增加缓存；多结果查找 135 → 183 ms。该读数未强制 GC、不含 main/Worker/RSS。源码输入仍约 298 ms；剩余数百毫秒布局/绘制与调度等待继续列入下一批。
- 离线 npm 返回 ENOTCACHED，固定版本联网安装成功，锁文件只有根依赖项变化。初次 typecheck 暴露 schema 推断过宽，补导出 Options 类型后通过，安全策略未变。
- 新 E2E 把 DOM 引用赋值结果交回 CDP，触发 Object reference chain is too long；改为浏览器内保存引用、返回 void 后通过。读取一个不存在的旧测试路径后改用实际 `tests/core/markdown-reading.test.ts`，未据错误路径跳过安全验证。
- Node 既有 MODULE_TYPELESS_PACKAGE_JSON 提示不阻止运行。没有为此调整项目模块类型，也未扩大源码编辑支持范围。真实中文 IME、物理多屏 DPI、干净 Windows 安装/升级/卸载未验证，P0 仍进行中。

### 产物与下一批

本地日志、截图及 20 个最终性能样本在 `out/qa/perf3b-*`；汇总 `perf3b-measurements.json`。安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe` 为 155,033,088 字节，SHA-256 `067E382E188E57DB6793655DBF60500A68618523B59364902D4D23EFAC5FA089`。这些 `out` 产物被 Git 忽略，未公开发行；没有将 make 成功等同干净机安装/卸载通过。

下一批 PERF3C 继续剩余正文布局/调度和源码输入热路径，再补 200 可见卡片/大量批注样本；后续 UX6B → UX7 → UX8 → QA1。不得为缩短耗时放宽完整 Markdown 语义、锚点核验或导出边界。

GitHub：本批已完成本地验证，提交与 PR 同步记录将在推送后补充。
