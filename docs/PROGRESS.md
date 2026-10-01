# MerMarkd 开发进度

> 2026-10-02。当前阶段：P0 可行性原型，进行中；A1–A8.5 已完成对应切片验证，A8.6 已完成首轮测量但质量门槛仍有缺口。B0 核心合同、B1 工作区外壳与 B1.1 内存新建/首次保存、B2 画布 v2 投影、B3 结构拖动候选、B4 共同选区命令/右键菜单和 B5 共享编辑会话/纯文本阅读编辑已完成当前切片验证；全量单测 `236/236`、类型检查、生产打包、A7.3b/A8.4/A8.5 回归通过。B5 尚未覆盖阅读内联 Markdown 格式、跨块编辑、完整输入法/键盘菜单验收和最终干净环境门槛。每批收尾重新检查并上传 GitHub；P0 尚未完成。开发时间线见 [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md)。

## 试用反馈与迭代规划（已整理，尚未实施）

按本轮八项反馈读取当前外壳、阅读、源码编辑、画布、卡片状态与导出实现，并使用本机 `emil-design-eng` 技能复核工作区和动效方案。发现父章节内容与子树容器共用节点，导致父内容固定左上角；正文仅有 160 字摘要且无独立折叠；结构手势只有固定投放区命中，无拖出候选；阅读仍只读，有批注选区操作条但没有统一编辑右键菜单。

新增 `docs/ITERATION_PLAN.md`，定义独立本节卡/章节组、独立正文与后代折叠、v2 内存迁移、重叠停留与拖出候选、共享文档事务/撤销、可编辑阅读、右键内容编辑与 YAML 高亮边界、开始页/左右栏及简短动效。卡片阈值、编辑引擎和性能预算均标为待验证；未安装新依赖、未修改产品代码、未声称目标能力已实现。下一步先用小样本证明 B0 编辑闭环与卡片几何合同，再进入 B1 工作区。

本批建立 `docs/DEVELOPMENT_LOG.md` 作为按批次追加的 GitHub 可读开发时间线，并在 `docs/DEVELOPMENT_PROCESS.md` 固定每批收尾重新检查后更新进度与日志的流程；`docs/DECISIONS.md` 新增 ADR-022 说明三份文档的职责边界。该阶段记录创建时尚无 `.git` 元数据；当前仓库已初始化并同步 GitHub `main`，提交证据见开发日志。

## B0 合同与编辑原型（核心切片已完成，视图实现未完成）

本批新增 `src/core/canvas-state-v2.ts` 和 `src/core/markdown-edit-transaction.ts`。v1 画布只在内存迁移为 v2：新增 `contentPosition`、`bodyDisplay` 和 `descendantsCollapsed`，保留稳定卡片 ID、原坐标、箭头和视口；旧文件不会因打开而自动改写。编辑事务支持精确局部替换、revision 过期拒绝、Unicode 代理对边界保护、撤销/重做和重做分支清理，保留周边 BOM/CRLF 文本。

本批验收样本见 [B0_ACCEPTANCE.md](B0_ACCEPTANCE.md)。阅读视图直接编辑、中文 IME、剪贴板右键菜单、CodeMirror/ProseMirror 选型和真实 v2 React Flow 投影仍未实现，不能将本批描述为完整阅读编辑器或卡片 v2。

## B1 工作区外壳（当前切片已完成）

开始页现在提供打开、新建和最近文档。最近文件只在主进程保存绝对路径与打开时间，失效路径在展示前过滤；新建先进入内存中的未命名编辑缓冲区，首次显式保存时再通过保存对话框选择路径并独占创建 Markdown。打开文档后使用单行模式导航，文件名与最小状态保留在顶栏，完整路径、编码和状态在可收起的文档信息栏中。

左侧栏显示最近文档与工作区提示，右侧栏显示文档信息；两侧互斥打开，焦点模式收起辅助栏。B1/B1.1 打包版在 `1200/800/420` CSS px 下验证无横向溢出，并复查 A8.4/A8.5 既有流程。临时文档首次保存前的批注、画布、结构变更和导出会明确冻结。

## B2 画布 v2 投影（当前切片已完成）

画布 sidecar 现在同时接受 v1 与 v2。旧 v1 打开只在内存迁移；当用户切换正文显示或移动本节卡位置并显式保存时，才写入 v2。v2 将后代折叠、正文显示（隐藏/摘要/全文）和本节内容位置分开保存，结构事务与三文件恢复按 schema 分派，稳定卡片 ID、箭头端点和外部变更保留原有安全门槛。

当前 React Flow 仍使用兼容卡片投影：父章节以低对比虚线组边界区分，本节正文卡可在组内使用独立位置；全文正文在卡片内部滚动。重叠停留设为子章节、拖出提升和独立组节点拆分留待 B3，现有结构投放标记暂时保留以维持 A8.4 回归。

## B3 结构拖动候选（当前切片已完成）

卡片不再显示固定的“拖到此处设为子章节”区域。拖动时按两张卡片的屏幕矩形计算交叠面积，覆盖较小卡片达到 `35%` 才显示候选，达到 `50%` 并稳定停留 `280 ms` 才进入可移入态；目标卡片高亮并提供短促提示，松开后仍进入既有源码结构预览，不会直接写 Markdown。自身、当前父章节和后代章节不会成为目标。

子卡移出直接父组后，按父组边界计算逃逸比例；达到 `35%` 显示提升提示，达到 `70%` 并稳定停留后松开会预览提升到文档顶层，取消或预览失败会恢复拖前位置。普通拖动仍只保存画布坐标，所有结构变更继续由预览、确认、撤销和三文件基线校验保护。

复查 A8.6 证据：小型 UI fixture 只有 3 张卡，200 卡片基准使用 1000 标题树的部分 bindings，阶段 RSS 采样不等于完整峰值；开发用户上的空安装目录不能等同于没有开发工具的新 Windows 环境。安装验收脚本已补测 2× DPR，1×/1.25×/1.5×/2× 均通过视口、模式切换和卡片控件检查；真实大文件 UI、卸载器自动回收、跨显示器 DPI 仍需独立验收。此批仅更新规划文档和验收脚本，不宣称 P0 收口。

## B4 共同选区命令与右键菜单（当前切片已完成）

源码编辑器和阅读正文现在共享一组纯核心的选区命令边界：源码复制保留原始 Markdown，剪切/粘贴/删除/加粗/斜体/引用通过 revision 校验的局部事务修改源码；阅读模式复制可见正文，高亮与批注只生成 YAML sidecar 意图，不把标记写入 Markdown。源码菜单在异步剪贴板操作后重新检查文档 revision，避免旧选区误剪切或误粘贴；阅读菜单冻结已验证的源码锚点，避免菜单点击后重新读取另一段浏览器选区。

本批完成源码右键菜单（复制、剪切、粘贴、删除、加粗、斜体、引用）和阅读右键菜单（复制正文、四色高亮、添加批注）的最小可运行切片，并为源码加粗/撤销加入打包回归。菜单支持 Escape 和指针关闭，暂未完成完整键盘菜单导航。`MarkdownEditSession` 尚未真正由 `useMarkdownEditor` 持有，因此当前菜单命令会把单次结果写入已有编辑器历史，但不能宣称阅读/源码跨模式共享同一撤销栈；阅读模式的加粗、斜体、引用仍需 B5 的保守 DOM 到 Markdown 映射后再开放。

本批复查并执行：

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

结果：B4 核心测试 `6/6`，全量单测 `233/233`，类型检查、生产打包和三项打包版回归均通过。已重新确认无残留 Electron 进程；未在本批扩大到跨模式撤销、阅读格式编辑、Shift+F10/方向键/Enter 菜单导航。下一批进入 B5，先把编辑 session 提升到共享 hook，再实现阅读模式最小可编辑正文和输入法/撤销边界。

## B5 共享编辑会话与纯文本阅读编辑（当前切片已完成）

`useMarkdownEditor` 现在持有 renderer 侧 `MarkdownEditSession`，源码输入、右键命令、查找替换、结构确认和阅读正文编辑共用同一份撤销/重做历史；保存成功、放弃编辑、恢复草稿和文档切换会重建正确基线，IPC revision 队列仍由主进程合同单独校验，历史最多保留 500 个局部快照。源码视图在收到共享 session 时停用本地历史，模式切换后可以继续撤销或重做。

阅读模式本批只开放安全的单块纯文本编辑：当一个段落或 ATX 标题的源码（去除标题标记后）与渲染可见文字完全相同，且不含实体、内联 Markdown、Setext、跨行或不确定边界时，才使用块级 `contenteditable`。输入法组合、纯文本粘贴、Escape 恢复和 Enter 禁止换段已处理；失焦后仅把该块的可证明源码范围提交到共享 session，不从整篇 DOM 反向生成 Markdown。产生 dirty 缓冲区后阅读回到只读预览，必须切到源码模式显式保存；BOM、CRLF 和标题标记保留。

本批验证了阅读编辑进入源码缓冲区、跨模式单步撤销/重做，以及复杂 Markdown 保持只读。内联加粗/斜体/链接、跨块换行、完整中文输入法验收、右键菜单 Shift+F10/方向键/Enter 焦点导航仍未完成，不把当前切片宣称为 Typora/Obsidian 等价的完整所见即所得编辑器。

本批复查并执行：

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

结果：阅读编辑核心与事务测试 `6/6`，全量单测 `236/236`，类型检查、打包和三项打包版回归通过。A7.3b 新增第三份临时 Markdown，验证阅读纯文本块编辑、源码缓冲区同步和共享撤销/重做；样本结束前回到磁盘基线。首次验收脚本因模式切换后未聚焦源码文本框而误报撤销超时，补回真实焦点后复跑通过。已确认没有残留 Electron、MerMarkd、Setup 或 Update 进程。

## A8.6 安装、性能与高 DPI 验收（已完成测量，P0 仍未闭合）

本批新增 `tests/e2e/qa-installed.mjs` 和 `tests/qa-performance.mjs`，先在真实 Windows 用户目录执行 Squirrel 安装版，再执行卸载、性能基准和 1×/1.25×/1.5×/2×设备像素比复测。验收过程中没有修改 Markdown、批注 YAML 或画布 JSON 样本。

安装结果：`out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe` 的 `--silent` 安装退出码为 `0`，耗时约 `7,993 ms`；安装目录包含 `app-0.1.0`、`Update.exe`、执行 stub、开始菜单快捷方式和桌面快捷方式，共 79 个文件、约 `525,601,380` 字节。安装版冒烟打开本地 Markdown、切换阅读/编辑/卡片、保存画布并导出 PNG 均成功。`Update.exe --uninstall -s` 退出码为 `0`，耗时约 `1,052 ms`，快捷方式已删除、后台没有 MerMarkd/Setup/Update 进程；Squirrel 随后留下 `.dead`、`Update.exe` 和 `app-0.1.0`，本批仅在确认无进程后清理该明确安装目录。卸载器自身未证明可以自动回收全部安装文件；已有的 `%APPDATA%\MerMarkd` 是本轮前已有的 Electron 数据，未删除。若 P0 要求卸载器单独完成零残留，这一门槛仍失败待处理。

代表性性能样本为 `5,242,880` 字节、1,000 个标题和约 200 张可见卡片：`extractSections` `762.12 ms`，`buildCanvasScene` `2.00 ms`，`arrangeCanvas` `133.18 ms`，操作后观测峰值 RSS `273.25 MiB`。安装版/打包版 UI 在 1×、1.25×、1.5×下启动到阅读约 `546–671 ms`，卡片就绪约 `719–857 ms`。额外的极端短行压力样本（5 MiB、约数十万短行）达到约 27 秒和 3.4 GiB RSS，证明当前同步 Markdown 解析对行数密集输入存在风险；它不是代表性目标样本，也不作为通过结果。性能预算尚未在产品决策中固定，故本批记录基线而不宣称性能门槛已闭合。

高 DPI 结果：`qa-installed.mjs` 在真实安装版和重新打包版分别以 `--force-device-scale-factor=1/1.25/1.5/2` 启动，并以 1200×800 CSS px 复核。四档 `window.devicePixelRatio` 分别为 `1/1.25/1.5/2`，阅读、编辑、卡片工具栏和 PNG 导出按钮均在视口内，无根级横向溢出；重新打包版 1× 导出 PNG 为 `844 × 525`。截图位于 `out/qa/dpi-1-installed.png`、`out/qa/dpi-125-installed.png`、`out/qa/dpi-15-installed.png`、`out/qa/dpi-2-installed.png`，已人工检查中文卡片、嵌套区域和右侧结构面板无重叠或裁切。A8.5 恢复对话框仍通过打包版 1200/800/420 CSS px 回归；真实多显示器物理 DPI 尚未覆盖。

本批复查命令：

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

结果为单测 `202/202`、类型检查、打包、安装包生成和 A8.2/A8.3/A8.4/A8.5 打包回归全部通过；安装/卸载残留策略、行数密集大文件解析和多显示器高 DPI 仍是 P0 后续门槛。

## 已完成

- 建立产品与架构方案 v0.2、开发流程、可行性审查与技术决策记录。
- 早期环境检查记录为 Windows x64、Node 24.20.0、npm 11.19.0、Git 2.45.1 可用，Rust/Cargo 与 MSVC 编译工具未发现。2026-09-28 复核时当前目录没有 `.git` 元数据，所以不能执行仓库级 `status`、`diff` 或提交验证；当前系统的 Git 命令可用，版本为 2.55.0.windows.5。
- 核实 Electron、Forge、CommonMark/mdast、React Flow 和导出相关官方文档，并定义 P0 验证关口。
- 初始化 Git，建立 Electron Forge + Vite + TypeScript + React 安全桌面壳和 npm 锁文件。`npm run package`、`npm run make` 通过；打包版与 Squirrel 安装版均启动并显示 MerMarkd 窗口。Windows 测试安装包位于 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`，约 154 MB。测试安装版已用官方卸载入口卸载。
- 实现 `src/core/sections.ts` 的 Markdown 根层标题抽取、章节父子树和原文 UTF-16 半开范围；已接入阅读界面目录。
- 完成最小只读阅读器：本地 `.md` 打开/取消/错误提示、UTF-8/BOM 解码、GFM 排版、YAML frontmatter 隐藏、根层章节目录与跳转、同名标题独立锚点、`Ctrl+O`、受控相对图片和外链。原始 HTML 不执行；编辑与卡片入口标明尚未开放。
- 使用打包版实测 `reading-features.md`：目录 5 个标题、表格 1 个、本地 PNG 实际宽 96 px、目录跳转后滚动并选中章节；YAML 元数据未显示。`security-cases.md` 中原始 HTML 未产生脚本或图片节点，越界图片显示失败占位。阅读前后样本 SHA-256 均为 `D5C6D8EAFD642D28C0D5852FD38DF9519913EC77666108BAB75217FAE9FF34FC`，未生成 sidecar。
- `npm test` 13/13 通过，`npm run typecheck` 通过。`npm run make` 使用 Electron 镜像后生成新版 Windows 测试安装包，位于 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`，约 154 MB；打包版成功启动并通过上述实际阅读检查。
- 根据新增需求把产品架构升级为 v0.3：规划 `*.md.annotations.yaml` 批注 sidecar、源码锚点与保守重定位、内容优先的便签/高亮、标签化阅读摘要、中英文混排排版规则。同步修订开发流程、可行性关口、ADR 与工作区不变量。此项仅为设计，尚无批注或排版新代码。
- 完成 A1 单块选区映射原型：主进程返回原始文件 SHA-256 和 BOM 长度；`src/core/selection-map.ts` 把渲染后标题/段落的可见文字位置映射到原始 `.md` 的 UTF-8 半开字节范围；阅读界面的“验证选区”显示范围、选文、原文片段或拒绝原因。只读原文，不创建批注 sidecar。
- 新增 UTF-8 BOM + CRLF 的 `selection-mapping.md` 样本及边界测试，核对重复文字、加粗、链接、中文、emoji、组合字符的确切字节范围；无法确定的转义/实体边界、软换行、跨块和含不支持内联节点的块保守拒绝。`npm test` 20/20、`npm run typecheck` 通过。`npm run package` 初次因 Electron GitHub 下载超时失败，设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后通过。
- 打包版实测打开该样本并选中“加粗内容”；阅读界面显示 `已定位到原文`、UTF-8 范围 `[163, 175)`，可见选文与原文片段均为“加粗内容”，与直接读取原始字节的结果一致。跨段落选区显示明确拒绝。试用前后样本 SHA-256 均为 `40CD23BB1D6A92AFEA4D1C42AD34A6EFA01E0D551F4B3864B94895325999B3ED`，未生成 `.annotations.yaml`。
- `npm run make` 使用 Electron 镜像生成本批 Windows 测试安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`（153,747,456 字节）。本批验证了打包版，尚未在干净 Windows 环境完成该安装版的安装/卸载复验。
- 按用户临时调整优先级，完成独立的拖入打开切片：阅读器右上角“打开 Markdown”附近可投放单份本地 `.md`；非投放区仅拦截系统默认文件导航，不打开文档。preload 由实际 `File` 获取本地路径，主进程校验绝对路径、扩展名、真实路径与普通文件后，以现有只读读取流程打开，成功后才更新文档路径。错误或多文件投放显示提示；不写 Markdown 或 sidecar。A2 未启动。
- 拖放切片复核：`npm test` 21/21、`npm run typecheck`、`npm run package` 和 `npm run make` 通过；本批安装包为 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`（153,748,480 字节）。打包版右上角投放区和原有按钮均可见。独立打包进程以真实磁盘 `.md` 文件和合成拖放事件验收：目标区投放后显示正确文件名、路径与正文；正文区投放不切换文档；投放 `.txt` 提示错误且保留当前文档；原文 SHA-256 不变。资源管理器鼠标拖入手势尚待用户试用确认。
- 完成 A2：`src/core/annotations.ts` 固定 v1 YAML schema、受限解析和稳定序列化，批量核验原始 UTF-8 字节锚点；`src/main/annotation-store.ts` 按已打开文档派生 sidecar 路径，限制文件大小，原子写入并复核 Markdown/sidecar 摘要。冲突、只读写入失败时在应用数据目录保留候选草稿；未知格式或版本、无法保留的字段与注释只读处理。损坏草稿单独报告，不阻断正常 sidecar 读取。
- 阅读界面增加最小 A2 验证入口：对 A1 成功定位的选区可保存一条 amber 测试高亮锚点；显示 sidecar 路径、记录数、待定位数与草稿状态。此批只验证数据保存，尚不在正文着色，也没有正式便签/标签界面。文件选择和拖入都先规范化为同一真实路径，主进程仅接收选区数据而不接收 sidecar 路径。
- A2 验证：`npm test` 38/38、`npm run typecheck`、`npm run package`、`npm run make` 通过。Windows 测试安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`（153,790,976 字节）。打包版以真实磁盘 UTF-8 BOM+CRLF 样本、合成 DOM 拖放实测：选中“关键结论”得到 `[40,52)`，保存后 YAML 含匹配的 `source.sha256`/`basisSha256` 和 1 条 amber 记录；重启显示 1 条。给 YAML 加未知字段后只读且保存按钮禁用。样本 `.md` 前后 SHA-256 同为 `9A5B19B406B6673C2BE5BC13E9647CE2908267817AA5319DE4051F476F8323B2`，sidecar 未被非法覆盖。打包应用进程已关闭。
- 完成 A3 混排排版：GFM `<table>` 保持语义与单元格对齐，由可键盘聚焦的外层区域横向滚动；两位数、嵌套和任务列表用原生标记与一致缩进；代码块显式 `tab-size: 4` 且长行在自身区域滚动。长链接可在正文内换行，窄窗口的章节目录改为横向可滚动单行，避免压缩正文。没有增删 Markdown 的对齐空格或写入批注 sidecar。
- 新增 `tests/fixtures/reader/mixed-layout.md`，覆盖中英文、全角/半角标点、GFM 右对齐数值列、长 URL、emoji/组合字符、9–12 有序列表、嵌套任务项、真实 tab 和长代码行；验收步骤写入样本 README。
- A3 验证：`npm test` 38/38、`npm run typecheck`、`npm run package` 与 `npm run make` 通过；测试安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`（153,791,488 字节）。打包版通过主进程检查接口设置**实际 Electron** 100%/125%/150% 缩放，在 1200×800 和约 800×600 窗口共 6 个场景中，整页无横向溢出。最窄场景表格容器约 471 px、表格滚动宽约 763 px，代码块容器约 470 px、内容滚动宽约 1346 px；键盘右箭头可把表格滚到数值列。列表标记、任务框和折行经截图复核；125% 下 A1 的“普通文本”仍定位 `[33,45)`。混排样本 SHA-256 前后同为 `9DCD5755107021C0FA8B3142BB4F3D18A90FE0AADA1C311519D2DBA2165CF35A`，选区样本摘要也未变。测试进程已关闭。
- 完成 A4 正式高亮交互：选中单个可映射标题或段落的文字后直接选择四色；高亮记录列表可跳转、改色、删除，关闭重开后恢复。正文由 CSS Custom Highlight API 对经过源码锚点反向核验的 DOM Range 着色，不插入文字包装节点。重复文字按 UTF-8 原文字节区分；锚点无法唯一还原时不着色。旧 A2 测试保存入口已由正式的加载、创建、改色、删除窄 IPC 取代。主进程保留便签与标签记录，待处理草稿、外部改源、过期 sidecar 和非法 YAML 阻止覆盖。
- A4 验证：`npm test` 44/44、`npm run typecheck`、`npm run package`、`npm run make` 通过；Windows 测试安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`（153,794,560 字节）。打包版复制 UTF-8 BOM+CRLF 样本到临时目录，用实际 DOM 选区和鼠标/键盘操作创建 8 条高亮，涵盖普通、加粗、两处重复词 `[88,97)` / `[109,118)`、emoji、部分重叠、文末与组合字符；从文末回到顶部点击色板、Tab 聚焦后 Enter 创建均成功。改色并删除后剩 7 条，重启后位置与颜色恢复、删除项不再出现。模拟系统高对比模式后伪元素使用系统高亮色。全过程 `.md` SHA-256 均为 `40CD23BB1D6A92AFEA4D1C42AD34A6EFA01E0D551F4B3864B94895325999B3ED`；外部修改原文后重开，7 条旧记录全为待定位、只读，正文高亮注册表为空。构建首次因 GitHub 下载超时，设置 Electron 镜像后成功。
- 完成 A5 便签与标签：可从精确映射选区新增、编辑或删除纯文本便签，并选择无标签、已有标签或同时创建新标签；边栏可按标签筛选并跳回原文。对已有高亮的同一精确锚点添加便签会原位更新为 `note`，保留 ID、锚点、`createdAt`、记录顺序和颜色。直接便签不强制着色，原文跳转仍使用核验后的 DOM Range。新标签与便签或便签更新组成一个候选后只保存一次；NFC 等价且大小写相同的名称复用，删除便签保留标签。待定位、只读或有恢复草稿时阻止不安全修改。
- A5 界面采用内容优先的响应式布局：宽窗口右侧栏进入正常页面网格，多条便签按文档流排列，当前项展开；宽度不超过 1100 px 时默认收起并使用模态抽屉，支持焦点循环、Escape 关闭和焦点返回。便签和标签由 React 作为纯文本渲染；窄 preload 只暴露便签增改删命令，不接收 sidecar 路径。
- A5 自动验证：新增 10 项便签领域测试，覆盖高亮原位转换、无色便签、新标签一次候选、NFC 复用、编辑、删除、限制与无操作时间戳；纯变更规则位于 `src/core/annotation-mutations.ts`，不依赖 Electron。全套 `npm test` 54/54、`npm run typecheck`、`npm run package`、`npm run make` 通过。Windows 测试安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe` 为 153,799,680 字节。
- A5 打包版实测：在工作区外复制 UTF-8 BOM+CRLF 样本，创建无标签纯文本便签、新建并复用“疑问”标签、筛选、跳回并聚焦原文、编辑、新建标签和删除均成功；`<img onerror=alert(1)>` 按文本显示，未生成元素。把“加粗内容”的 amber 高亮转换为便签后，ID、`createdAt`、锚点、颜色和记录位置保持，记录数不增加；重启后 3 条便签及标签恢复。1200×800 边栏和 800×600 默认收起抽屉无明显遮挡或裁切；焦点循环、Escape 返回入口、可用编辑器聚焦及只读编辑器回退到关闭按钮均通过。主动外部修改前 `.md` SHA-256 始终为 `40CD23BB1D6A92AFEA4D1C42AD34A6EFA01E0D551F4B3864B94895325999B3ED`，仓库样本未生成 sidecar。
- A5 冲突与过期验证：人为保留 `.lock` 后尝试同时创建“待办”标签与便签，sidecar SHA-256 前后均为 `51D9BC846E7A380AB0C2AA95D13A15373414EE1CE8084181696BD475D5DC5032`，完整候选草稿同时包含新标签与新便签。随后主动修改临时 `.md`，原有 3 条便签全部仍可见但进入待定位，跳转、编辑和删除禁用，CSS Highlight 注册表为空，sidecar 未被覆盖。7 张宽屏、筛选、窄屏、焦点、草稿只读与过期状态截图已人工复核；测试进程已关闭。
- 完成 A6 保守重定位：当前原文摘要变化后，只在 `sourceExact` 全文唯一、锚点保存的左右上下文均仍精确相邻、候选可反向还原到当前阅读 DOM 且不与其他记录碰撞时提出“可安全重定位”。旧字节位置和 `sectionHint` 不用于破除歧义；删除、重复、上下文变化、非渲染区域或目标碰撞继续待定位。候选由用户显式应用后才写回；未解决记录保留旧 `basisSha256`、引文、便签、标签和颜色。迁移保存同时核对当前 Markdown 摘要、sidecar 字节摘要与旧 `source.sha256`，冲突时不覆盖并保留完整候选草稿。
- A6 增加人工重选与阅读摘要：待定位的高亮或便签可重新选择当前正文中的可映射单块文字，保留记录 ID、`createdAt`、顺序、便签、标签和颜色，只更新锚点与 `updatedAt`。边栏“复制摘要”沿用“全部 / 无标签 / 指定标签”筛选，把已定位记录按当前 UTF-8 字节位置和章节路径组织，把待定位记录按 sidecar 顺序附后；引文、标签和便签作为转义后的 Markdown 引用输出。摘要只写系统剪贴板，不修改 `.md` 或批注 sidecar。
- A6 自动验证新增 25 项相关测试，覆盖 BOM/CRLF、中文/emoji、唯一匹配、双侧上下文、段落移动、删除/复制/歧义、非渲染区域、混合锚点基线、目标碰撞、人工重选、旧 sidecar 基线迁移，以及摘要过滤、章节排序、重复标题、待定位保留和不可信 Markdown/HTML 转义；全套 `npm test` 79/79、`npm run typecheck` 与 `npm run package` 通过。
- A6 Windows 打包版 E2E：`tests/e2e/a6-packaged.mjs` 驱动 `out/MerMarkd-win32-x64/MerMarkd.exe` 通过。外部改源后界面识别 3 条安全候选并在显式应用后保留 3 条待定位；把“旧关键词”人工重选为“新关键词”后剩 2 条待定位，记录 ID、创建时间和便签保留。全部摘要复制 6 条，按“疑问”筛选复制 2 条；摘要含章节路径和待定位区，复制前后 Markdown 与 sidecar 摘要不变。第二次外部改源后再外部修改 sidecar，应用拒绝覆盖并保留 1 份完整草稿。窄窗口实测 viewport 788×538、outer 802×600，边栏默认关闭、页面无横向溢出，抽屉位于窗口内并可用 Escape 关闭。测试结束共 6 条批注、人工修复后仍有 2 条待定位、保留草稿 1 份。`npm run make` 已生成 Windows 测试安装包 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`（153,850,368 字节，SHA-256 `6E648B80F94E2D16486BDF38CA516E6C779644FFB7F0BD1371A76F7BDDF3A0E8`）。
- 完成三模式职责审查并形成 `docs/MODE_BOUNDARIES.md`：打开/拖入、文件状态和模式导航归共同外壳；阅读模式只呈现受支持 Markdown 的语义结果并承载高亮、批注、标签、摘要和锚点修复；编辑模式显示完整源码且不渲染，只有显式保存可改 `.md`；卡片模式承载画布、折叠、箭头和完整场景导出，只有确认的结构变更可改 `.md`。审查确认当前实现仍只有阅读模式，`Hn`、sidecar 路径、UTF-8 范围和 `sourceExact` 会污染阅读界面，选区与滚动章节也缺少即时反馈；这些是 A7.1 的待开发项。本轮只更新设计与实施规则，没有修改产品代码。
- 完成 A7.1 共享外壳与阅读交互收口：文件打开/拖入、文件名、模式入口、正文查找入口、已检测到的原文变化和普通/错误提示由 `AppShell` 统一承载，阅读正文与目录拆入 `ReaderView`。阅读模式使用普通导航按钮和 `aria-current="page"` 表示当前模式；该阶段编辑与卡片入口继续禁用，并在可见文字和可访问名称中标明“尚未开放”。普通阅读流不再显示 `H1/H2`、UTF-8 字节范围、`sourceExact`、原始 Markdown 片段或常驻 sidecar 路径。
- A7.1 现在在 `selectionchange` 后合并核验正文选择：可映射选区就近显示轻量高亮/批注工具和 Unicode 字素数，不支持选区只给自然语言原因；目标绑定当前文档 epoch 与源摘要，换文件、重新载入或在目录/工具栏等正文外重新选择时会清除旧目标。临时 CSS Highlight 在工具取得焦点后保留原选区反馈。目录点击、文内标题链接和手动滚动都会更新当前章节，当前目录项使用 `aria-current="location"`，窄窗口与强制颜色模式提供非纯颜色反馈。
- 完成 A7.2 阅读方言收口：方言固定为 CommonMark + GFM + YAML frontmatter。所有非白名单原始 HTML 容器先在 Markdown AST 层替换，再执行 `rehype-raw → HAST 元素兜底 → rehype-sanitize`；因此 HTML5 foster parenting 不能把被拒绝容器内的表格文字、图片或资源节点移到容器外。白名单内的语义 HTML 仅保留受限属性；普通未支持标签和危险内容分别显示克制占位，整棵子树都不进入普通正文。原始 HTML 即使允许显示，当前也不进入源码选区映射，因此不能建立高亮或批注。数学公式、Wiki Link 与 directive 等可保守识别的未支持扩展只产生一次文档级提示，不伪装为已渲染能力。完整合同见 `docs/READER_DIALECT.md`。
- 完成 A7.2 可见正文查找：`Ctrl+F` 打开共享外壳中的搜索条，按字面量、Unicode 不区分大小写查找渲染正文；目录、工具界面、frontmatter、HTML 占位、隐藏内容和关闭的 `details` 不计入结果。结果不跨阅读块或 `<br>`，按字素边界核验，最多保留 1000 项；全部匹配与当前项分别着色，当前块另有轮廓，上一项/下一项循环导航。查找不借用原生文字选区，不触发批注，也不写 Markdown 或 sidecar。
- 完成批注加载错误的安全收口：sidecar 读取、当前 Markdown 复核读取和 YAML 解析失败分别返回稳定错误码与固定自然中文提示。`AnnotationDocumentView.reason` 不再包含原始 `error.message`、`sourceExact`、字节范围或 sidecar 绝对路径；详细异常只写主进程日志，失败状态保持只读。聚焦测试覆盖损坏 sidecar 和两类读取失败。
- 完成 A7.3a 的字节往返核心：`src/core/markdown-source.ts` 以严格 UTF-8 解码，单独记录 UTF-8 BOM、换行类型和尾换行；编码时拒绝不完整 Unicode 代理项，不主动规范化 LF、CRLF、CR 或尾换行。保存门槛拒绝把单一换行格式意外改成另一种格式，混合换行源暂不覆盖。
- 完成 A7.3a 的主进程保存原型：`src/main/markdown-store.ts` 在任何源文件写入前，先把候选作为面向 app-data 草稿目录的不可变 generation 写入唯一临时文件、执行文件级 `sync`，再以独占硬链接发布。并发候选不会覆盖同一路径；被替代 generation、显式丢弃和成功后的清理都要求精确草稿 SHA-256。最终 generation 发布失败而临时文件保留下来时，该孤立临时文件仍可被枚举、载入和显式丢弃；发布成功但临时硬链接清理失败时，清单把残留单独列出，避免把可清理路径去重隐藏。
- Markdown 保存使用会话提供的 expected SHA-256，写前和取得独占保存锁后再次核验原文。候选先写入源目录内的唯一临时文件并执行文件级 `sync`；随后把已核验源文件移动为同目录唯一 backup，再把候选以独占硬链接发布到空出的原路径。若外部进程在空档重建原路径，发布得到冲突并保留外部文件、候选草稿和原文 backup，不执行路径级覆盖。若候选因权限、文件系统支持或空间等其他错误无法发布，原路径仍为空时会以独占硬链接恢复精确原文；恢复失败时保留 backup 供显式处理。无操作保存会再次读取源文件并保持摘要不变。每次真正改变 `.md` 的成功保存也保留可枚举的原文 backup，并在 `saved` 结果中返回 `sourceBackup`；不会因当前校验成功就自动删除该证据。
- 草稿可在原文被删除或暂时不可读时按稳定文档身份枚举；冲突分支不会相互覆盖。源 backup 清单同时报告可读取项和无法读取/校验的项；可读取 backup 只有在当前不存在 document lock 时，才能以精确 SHA-256 恢复或显式丢弃。Markdown 保存锁记录 PID，可检查存活状态，只有死 PID 的已知锁或用户明确选择的未知锁才能按精确锁 SHA-256 清理。活动锁、摘要不符和格式未知的恢复物保守保留。保存原型不会创建或修改缺失的批注 YAML 与画布 JSON。
- A7.3a 原型把单个源文件和候选限制为 32 MiB。该阶段只提供 core/main API，尚未接入 preload、IPC、编辑器、dirty 会话或正常 UI 恢复流程；这些入口随后由 A7.3b 接入。文件级 `sync` 与同目录发布不包含目录 `fsync`，因此不承诺物理断电后的目录项持久性；外部进程持续持有旧 inode/句柄仍有平台相关边界。Windows ACL、ADS、额外元数据和原硬链接身份目前不会随新文件保留。Markdown、批注 YAML 与画布 JSON 的跨文件事务仍属于 A8.1。
- 完成 A7.4 核心映射：`src/core/annotation-edit-map.ts` 从保存前后精确源码计算包含全部等价最小单补丁对齐的保守包络，并把代理对或 CRLF 中间边界向外扩展。只迁移完整位于包络前后、旧基线/字节范围/旧阅读范围均有效且新范围仍能反向还原的锚点；映射后重建 UTF-8 范围、上下文和章节线索。相交、重复删除歧义、无关旧基线、不可渲染范围和目标碰撞保留原锚点及旧 `basisSha256`，不搜索全文第一次同名文字。
- A7.4 主进程把 Ctrl+S 与关闭窗口保存统一到同一协调函数。changed save 前从磁盘预检 sidecar、草稿和旧源摘要，先提交 Markdown，再用新 Markdown 摘要、旧 sidecar 摘要和旧 sidecar 源摘要条件写回 mixed-basis 候选。dirty/clean save、Markdown 冲突、待处理批注草稿和缺失 sidecar 均不产生错误 YAML 写入；缺失 sidecar 不创建空文件。Markdown 已保存而 YAML 随后冲突时不回滚源码，外部 YAML 保留，完整候选进入批注恢复草稿。复制阅读摘要也补上 dirty、写入状态、文档摘要和 revision 的提交前复核。
- 当前工作区遗留的 hash 命名 shadow copies 保持原样，没有删除或改写；`tsconfig.json` 显式排除 `src` 下这些副本，避免它们进入类型检查。由于当前目录没有 `.git` 元数据，无法用仓库 diff 证明这些文件的历史来源或工作树清洁度。

## 当前停点

- A8.4/A8.5 保持已完成的结构保存与恢复验证；A8.6 已有安装、核心性能与高 DPI 首轮记录，残留清理和端到端平台质量未闭合。最新试用反馈已整理为 `docs/ITERATION_PLAN.md`；下一步为 B0 可编辑阅读与卡片 v2 原型，随后 B1–B6 每批复查推进。当前没有本轮新功能实现，P0 仍待完整门槛验收。

## 后续切片

1. A1：选区到原文字节范围的锚点原型与边界样本，已完成。
2. A2：批注 YAML schema、安全持久化和冲突检测，已完成原型与打包版验收；待用户试用。
3. A3 混排排版、A4 正式高亮、A5 便签标签与 A6 保守重定位、人工重选和阅读摘要已完成。
4. A7.1 共享模式导航外壳与阅读交互收口、A7.2 阅读方言、安全 HTML 与可见正文查找均已完成并通过组合验收。
5. A7.3a 的 core/main 原型、A7.3b 纯源码编辑、A7.4 编辑到批注映射及 A7.5 章节源码变换均已完成对应验证。A8.1 固定画布模型并验证三文件恢复；A8.2 实现嵌套画布与关系持久化；A8.3 单独实现 PDF/JPG/PNG 全图导出。逐批验收见 `docs/DEVELOPMENT_PROCESS.md`。

## 尚未验证的门槛

- 测试安装包已生成；新版阅读切片已在打包版启动与打开文件，尚未在干净 Windows 机器或新版安装版完成安装/卸载复验。首次从 GitHub 获取 Electron 资源超时，设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后成功。前一版安装版启动时有缓存目录权限警告，UI 仍显示；卸载后 Squirrel 留下 `.dead`、`Update.exe` 和 `squirrel.exe` 残留，发布前需复测与处理。
- 阅读、编辑和卡片模式均可进入。卡片模式已接入 React Flow 嵌套投影、折叠/展开、拖动、箭头和关系面板；编辑器、Markdown 保存 IPC、dirty 状态、外部冲突反馈、逐项恢复界面和 changed save 后的批注锚点同步继续生效。
- A8.4/A8.5 已在打包版验证结构专用批注映射、卡片 ID/箭头保持、三文件保存和显式恢复。纯源码的 A7.5 入口仍走 A7.4 单包络；结构确认后增加任意源码编辑也回退保守映射，不确定的批注或卡片保持待定位/待修复，不用重名文字或旧偏移猜测身份。
- A8.1 已完成核心数据门槛：`src/core/canvas-state.ts` 固定 v1 画布 schema、标题/虚拟卡片锚点、坐标/折叠/箭头/视口校验和保守 ID 对齐；`src/main/document-transaction.ts` 为 Markdown、YAML、画布 JSON 写入不可变 before/after 快照与 journal，提交前逐文件核验，处理中断后只按精确摘要恢复，外部重建或未知锁保持冲突。A8.2 已把普通画布操作接入 `*.md.mermarkd.json` 保存与重开恢复。
- 5 MB 文档、1000 标题、200 可见卡片以及单图尺寸均只是目标，尚无测量结果。
- 阅读器目前将全文在渲染线程同步解析；大文件性能和图片解码后内存占用尚未测量。相对 `.md` 链接只提示暂不支持。
- 正文查找有 1000 项显式上限；大文档查找延迟和大量搜索高亮尚未形成性能基线。安全白名单内的原始 HTML 可阅读但当前不能批注；原始 HTML 标题不会进入由 Markdown 标题树生成的目录。未支持扩展检测是保守提示器，不是完整方言解析器。
- 高亮、便签和人工重选仍只支持可核验的单段落/标题选区，每条便签为零或一个标签；表格单元格、代码、跨块和部分实体/转义需后续扩大映射范围。A6 重定位只接受全文唯一原文片段、双侧原上下文仍紧邻且当前阅读视图可精确还原的候选；复制或重复文本、任一侧上下文变化、非渲染区域和碰撞继续待定位。阅读摘要目前只复制到系统剪贴板，尚未提供另存文件；全局标签重命名/删除、几百条记录时的性能和其他平台的高对比模式尚未实现或验证。A3 的 Windows 样本视觉验收不代表所有系统字体或平台均已验收。
- A2/A7.4 的 sidecar 单文件替换和 A7.3a/A7.3b 的 Markdown 单文件保存都不等于 Markdown、YAML 与画布 JSON 的跨文件事务。Markdown 保存可按精确 SHA-256 检查和清理死 PID 锁，并只在无 document lock 时恢复或显式丢弃精确 backup；A7.3b 已提供当前会话草稿与本次 changed save backup 的逐项 UI，但不自动扫描、排序或清理所有历史 backup。A2 遗留 sidecar 锁仍需自己的恢复流程；sidecar 在锁内多次核验摘要，但最后一次核验与替换之间仍有不遵锁外部写入的极小竞态窗口。文件级 `sync` 不包含目录 `fsync`，物理断电后的目录项持久性没有承诺；不遵锁的外部编辑器若持续持有旧 inode/句柄仍有平台残余边界。本批未在干净 Windows 机器重新安装/卸载，也未做资源管理器物理拖放。
- A7.3a 当前只接受不超过 32 MiB 的 UTF-8 Markdown；混合换行只读保留。替换会创建新的文件对象，因此 Windows ACL、ADS、额外元数据和原硬链接身份尚未保留，发布前需要单独决定支持合同与验证范围。

## A6 验证记录

```powershell
npm test
npm run typecheck
npm run package
node tests/e2e/a6-packaged.mjs
npm run make
```

A6 已执行 `npm test` 79/79、`npm run typecheck`、`npm run package`、打包版 E2E `node tests/e2e/a6-packaged.mjs` 和 `npm run make`。E2E 实测安全候选显式应用、歧义/删除保留待定位、人工重选、全部与标签筛选摘要、同名章节分组、Markdown/sidecar 不因复制摘要改变、外部 sidecar 冲突草稿和窄窗口抽屉。Node 测试仍提示项目未声明 ESM 模块类型，目前不影响测试结果。

## 三模式文档审查历史记录

进入 A7.1 之前的审查只修改产品文档和工作区规则，没有修改运行代码或重新生成安装包。该记录解释 A7.1/A7.2 的来源，不代表当前工作树仍停留在设计阶段。

## A7.1/A7.2 最终验证记录（已完成）

本批状态：**完成**。A7.1 共享外壳与阅读交互、A7.2 阅读方言、安全 HTML 与可见正文查找均已通过最终组合验证；下一批为 **A7.3a 安全保存与单文档草稿原型**，该批不开放编辑界面。

实际执行：

```powershell
npm test
npm run typecheck
npm run package
npm run test:e2e:a7-1
npm run test:e2e:a7-2
npm run test:e2e:a6
npm run make -- --skip-package
git diff --check
```

- `npm test`：89/89 通过；`npm run typecheck` 通过。新增回归覆盖 `rehype-raw` 前的 HTML5 foster parenting 防护，以及损坏 sidecar、批注读取失败和 Markdown 复核读取失败的错误信息边界。
- `npm run package`：标准下载路径此前因 GitHub `20.205.243.166:443` 返回 `ETIMEDOUT`；本轮使用本机缓存的 Electron zip 完成打包。为使用缓存而设置的临时环境变量和 Forge 配置均未留在仓库。
- A7.1 打包版 E2E：`status="passed"`，即时选区反馈 `selectionDelayMs=13`，模式按钮 3 个，核对章节 3 个，被动操作前后 3 类内容文件不变；实际窗口 outer 802×602，覆盖 400/320 CSS px 模拟宽度，`forcedColors=true`。
- A7.2 打包版 E2E：最近一次执行结果为 `status="passed"`，`commonMarkAndGfm=true`，危险 HTML 网络请求数为 0，可见正文搜索命中 3 项，被动操作前后 4 类文件状态不变；实际窗口 outer 802×600，覆盖 320 CSS px，`forcedColors=true`，并验证超过上限时只保留前 1000 项并显示截断状态。脚本现已增加 foster parenting 逃逸文本、图片占位、DOM 图片与网络请求断言；安全收口后的打包版重跑结果在安装包重建后同步。
- A6 打包版回归：`status="passed"`，批注 6 条，人工修复后待定位 2 条，保留草稿 1 份，outer 802×600。
- 最近一次 `npm run make -- --skip-package` 生成 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`（153,909,248 字节，SHA-256 `7679480EB5A52340AE1BD0ABFF52593954D40D7C3B6CDAAA533986A26C9C631F`）；安全收口后的安装包大小与摘要待重建后替换本条记录。
- `git diff --check` 通过；只有工作区行尾将转换为 CRLF 的提示，没有空白错误。

## A7.3a 实现与验证记录（已完成）

本批已实现 `src/core/markdown-source.ts`、`src/main/markdown-store.ts` 及对应聚焦测试。覆盖目标包括 UTF-8/BOM/换行与无尾换行往返、无操作保存、expected SHA 冲突、并发不可变草稿、源删除后的草稿恢复、孤立草稿临时文件枚举、外部路径重建、changed save 保留并返回源 backup、可读/不可读 backup 清单、backup 恢复与无锁精确丢弃、死 PID/未知保存锁处理、只读与清理失败，以及不创建或修改两类 sidecar。

本轮已执行：

```powershell
npm test
npm run typecheck
npm run package
npm run test:e2e:a7-2
npm run test:e2e:a7-1
npm run test:e2e:a6
```

- `npm test`：121/121 通过；`npm run typecheck` 通过。Node 仍报告既有的 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告，本批没有改变模块类型合同。
- `tests/main/markdown-store.test.ts` 的 27 项测试连续执行 20 轮，没有失败。
- `npm run package`：直连 Electron 资源路径不稳定；设置临时 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后通过。该变量只用于当前构建环境，不写入产品配置。
- 安全收口期间，A7.2 与 A7.1 打包版 E2E 曾各有一次在等待 selection feedback 时超时，立即单独重跑后通过。最终打包后的 A7.2、A7.1、A6 三组回归均在首次执行时为 `passed`：危险 HTML 网络请求为 0，可见正文搜索命中 3 项，A7.1 核对 3 个章节，A6 保留 6 条批注、2 条待定位记录和 1 份冲突草稿；被动操作未改 Markdown 或 sidecar。一次性超时仍保留在记录中，后续若复现，应检查打包版启动/渲染时序和测试等待条件。

上述结果是在 changed-save backup 保留策略、发布失败恢复、不可读 backup 清单和锁阻断恢复全部完成后取得。当前目录没有 `.git` 元数据，所以本批不能以 `git diff --check`、`git status` 或提交记录作为证据；A7.3a 依据源码测试、压力测试、类型检查、打包和打包版回归完成验收。

## A7.3b 实现与验证记录（已完成）

本批开放纯源码编辑模式。原生 `textarea` 只承载 LF 形式的编辑投影，主进程仍保存完整源码和持久化基线格式；保存前按原始 LF、CRLF 或 CR 规则重建候选，BOM 与尾换行独立保留。编辑器显示 frontmatter、标题标记、链接目标、代码围栏和原始 HTML，不挂载阅读渲染器；已实现源码目录、字面量查找/替换、撤销/重做、行列与选区字数、`Ctrl+F`、`Ctrl+H`、`Ctrl+S`、显式放弃并从磁盘重载，以及恢复草稿和本次 changed save 恢复文件的显式处理。混合换行和超过 32 MiB 的文档保持源码只读。

renderer 使用单一候选缓冲区和单调 revision，通过窄 preload API 传递 `epoch + revision + content`；路径、expected SHA、BOM、草稿目录和恢复文件路径全部由主进程会话派生。输入停止 700 ms 后生成 app-data 不可变草稿；保存、草稿和批注保存共享主进程互斥状态。dirty 或 Markdown 写入期间，所有批注 mutation 在主进程拒绝。dirty 切回阅读模式时显示候选语义预览，暂停旧锚点着色、批注新增/修改/删除、重定位和边栏操作；切换模式本身不写三类内容文件。打开、拖入、重新载入和窗口关闭均检查主进程 dirty/写入状态。

恢复边界保持保守：只有 `recoverable` 草稿可载入当前缓冲区，`conflict` 草稿不能改绑当前外部版本；多个 generation 分项显示并按 opaque ID、精确 SHA 操作。changed save 只暴露本次保存返回的恢复文件，应用不会自动扫描或推断所有源 backup 的时间顺序。保存成功后更新 `DocumentSession` 的磁盘基线并使批注缓存失效；A7.4 前不自动迁移锚点。

本轮已执行：

```powershell
npm test
npm run typecheck
$env:MERMARKD_ELECTRON_ZIP_DIR = <本机已校验 Electron 44.4.1 zip 所在目录>
npm run package
npm run test:e2e:a7-3b
npm run test:e2e:a7-1
npm run test:e2e:a7-2
npm run test:e2e:a6
```

- `npm test`：134/134 通过；新增 13 项编辑文本与主进程编辑会话测试。`npm run typecheck` 通过。Node 仍只有既有的 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。
- `npm run package`：两次标准下载都在 `20.205.243.166:443` 超时；Vite bundle 均已成功。随后通过新增的可选 `MERMARKD_ELECTRON_ZIP_DIR` 配置使用 SHA-256 已核对的本机 Electron zip，Forge 完整打包通过。默认未设置该变量时仍使用 Forge 标准下载路径。
- A7.3b 打包版 E2E：`status="passed"`。同一 UTF-8 BOM + CRLF + 无尾换行 fixture 验证完整源码显示、clean 模式切换 bytes/mtime/目录项不变、可信输入、撤销/重做、替换全部单步撤销、行列、dirty 阅读预览、直接 preload 批注 mutation 被主进程拒绝、显式保存精确字节往返、A7.4 对安全锚点的同步、画布 JSON 不变，以及 changed save 恢复文件等于旧原文。第二个 fixture 验证外部版本胜出、候选与 dirty 保留、拖入被阻止、sidecar 不变、恢复草稿保留原 expected SHA 和候选摘要。
- E2E 初版仅设置 `APPDATA/LOCALAPPDATA`，实际打包进程仍使用系统 user-data，留下 7 份指向临时 fixture 的恢复草稿；测试改为显式 `--user-data-dir` 后隔离通过。7 份草稿已通过产品的精确 SHA 草稿丢弃 API 清理，并确认匹配残留为 0。一次强制结束后的临时 Chromium journal 短暂返回 `EBUSY`，脚本现等待并带有限重试，最终清理通过。
- 回归均在本批打包后通过：A7.1 核对 3 个章节及 3 类被动文件不变；A7.2 危险 HTML 请求为 0、可见正文命中 3 项；A6 保留 6 条批注、2 条待定位和 1 份预期冲突草稿。

仍有边界：源码编辑器目前是无语法着色的原生文本区；不支持混合换行写回、编码转换、另存为、目录 `fsync`、完整 Windows ACL/ADS/硬链接身份保留或三文件事务。当前恢复 UI 只管理会话扫描到的草稿和本次保存返回的源恢复文件，不自动清理历史 backup。P0 仍未完成；A7.5 章节源码变换、卡片、画布持久化和导出仍在后续门槛。

## A7.4 实现与验证记录（已完成）

本批把显式 Markdown changed save 与批注锚点同步接入同一主进程操作。核心映射以保存前后精确源码为输入，计算全部等价最小单补丁对齐的并集；锚点只有在包络外、旧范围有效且新范围仍能反向还原到阅读语义时才迁移。重复选文本身可以按已知位置安全平移；重复删除、相交、旧基线、不可渲染或碰撞记录保持旧 `basisSha256` 与全部内容。当前一次保存只形成一个包络，因此多处远距编辑之间的记录会保守进入待定位。

保存协调先从磁盘预检 sidecar 与批注草稿，再提交 Markdown，最后以新 Markdown 摘要、旧 sidecar 字节摘要和旧 sidecar 源摘要条件写回已有 sidecar。没有 sidecar 时不创建空 YAML；clean save、Markdown 冲突和 pending/unreadable 批注草稿不触发自动写回。YAML 保存冲突不会把已经提交的 Markdown 伪装成失败，完整映射候选由现有批注恢复草稿保留。Ctrl+S 和关闭窗口保存共用这一流程。

本轮已执行：

```powershell
npm test
npm run typecheck
$env:MERMARKD_ELECTRON_ZIP_DIR = <本机已校验 Electron 44.4.1 zip 所在目录>
npm run package
npm run test:e2e:a7-4
npm run test:e2e:a7-3b
npm run test:e2e:a7-1
npm run test:e2e:a7-2
npm run test:e2e:a6
```

- `npm test`：144/144 通过；A7.4 新增 10 项核心测试，覆盖 BOM/CRLF、中文/emoji、重复引文、相交修改、半开 start/end、上下文与章节线索重建、不可渲染范围、no-op、无关旧基线、重复删除歧义及输入/时间校验。`npm run typecheck` 通过。Node 仍只有既有的 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。
- `npm run package`：使用 SHA-256 为 `34BC07977D6C43B6514B956A5F2E3292255DAA3838A49E6110F3FE19FFAFB83F` 的本机 Electron 44.4.1 zip 完整通过；该路径只通过临时环境变量传入，未写入产品配置。
- A7.4 打包版 E2E：`status="passed"`，3 条包络外锚点迁移到新摘要，1 条相交记录完整保留旧基线；dirty 时 YAML bytes/mtime 不变；无 sidecar 保存后仍不存在 YAML；重启后为 3 resolved / 1 unresolved。Markdown SHA-256 为 `9178077476B0E9C4A561973690CC94143F9342C7A6861D06C7590F3C94E059C0`。
- 打包后回归全部通过：A7.3b 精确 BOM+CRLF+无尾换行保存、changed backup、外部冲突和安全锚点同步；A7.1 选区反馈 51 ms、3 个章节和 3 类被动文件不变；A7.2 危险 HTML 请求为 0、可见正文命中 3 项和 4 类被动文件不变；A6 保留 6 条批注、人工修复后 2 条待定位和 1 份冲突草稿。A6 第一次执行在 Windows `resizeTo(800, 600)` 后等待窄视口时超时；确认没有残留 MerMarkd 进程后立即复跑通过，产品断言未出现失败。

仍有边界：当前单包络会降低多处远距编辑的自动迁移率，但不会据此猜测锚点。A2 sidecar 发布保留最后摘要复核与 `rename` 之间的不遵锁外部写入竞态，强发布协议与三文件事务留待 A8.1。A7.5 负责章节源码变换及其批注影响预览。

## A7.5 实现与验证记录（已完成并重新审查）

本批新增 `src/core/section-transform.ts`。移动固定把完整源章节子树插入目标子树末尾；提升只允许更浅级别，把子树移到保留父章节末尾或文档顶层末尾，避免原地改标记捕获后面的同级章节。候选重新解析，按原章节身份核对顺序、深度、全部父级和正文 AST，比较标题内联语义、首次引用定义，以及已使用标题片段链接的目标身份。阅读器与验证器共用标题片段 ID 生成器。必要边界换行保留原换行风格并进入完整源码预览。

单行 Setext 在 1/2 级保留下划线，超过 2 级转为 ATX；转换后内联含义变化或多行标题需要转换时拒绝。多行 Setext 不改级别的移动可通过。原始 HTML 除独立注释外保守阻止结构命令，因为尚未证明跨 Markdown 块的 HTML 树构造等价。源码面板支持预览、取消、过期阻止和单步撤销/重做。新增只读窄 IPC 从磁盘预检批注并复用 A7.4，列出保存后将待定位的引文；预览不更新会话或写文件，保存前仍重新核验基线。dirty 期间两类 sidecar 保持冻结。

本轮已执行：

```powershell
npm test
npm run typecheck
$env:MERMARKD_ELECTRON_ZIP_DIR = <本机已校验 Electron 44.4.1 zip 所在目录>
npm run package
npm run test:e2e:a7-5
npm run test:e2e:a7-3b
npm run test:e2e:a7-4
```

- `npm test`：164/164 通过，A7.5 核心测试扩至 20 项，覆盖提升后的相邻章节归属、跳级、祖先与源子树末尾相等、无尾换行/BOM/CRLF、首次引用定义、重名/编码标题链接、代码/GFM/容器标题、HTML 保守拒绝和 Setext 内联变化。初次复查仅失败于旧断言要求文案含“移动”，修正文案后全部通过。
- `npm run typecheck`：通过。
- `npm run package`：直连 Electron 下载因 `20.205.243.166:443` 超时；随后使用本机已校验的 `electron-v44.4.1-win32-x64.zip` 目录通过 Forge 打包。`forge.config.cjs` 只在环境变量存在时使用该缓存路径，默认下载行为未改变。
- A7.3b/A7.4 打包版回归通过。此前 A7.3b 重复超时的原因已定位：编辑页面变高后平滑滚动尚未归零，拖入目标的 Y 为负值。测试在测量前关闭平滑滚动并归零，复跑通过；不是随机重试掩盖产品断言。
- A7.5 打包版 E2E 通过：预览批注 1 条可迁移/1 条待定位，取消、自身拒绝、过期预览阻止、未知 IPC 字段拒绝、确认、单步撤销/重做；未保存时 Markdown/YAML bytes 与 YAML mtime 不变；显式保存精确保留 BOM/CRLF，相交批注整条保留旧 basis，画布文件不变，重开保持 1 条待定位。1200/800 CSS px 截图检查无横向溢出或元素重叠，截图位于 `out/qa/a7-5-wide.png` 与 `out/qa/a7-5-narrow.png`。

本批收尾重新审查了完整父级、正文、引用、标题链接、批注基线、dirty 冻结及打包回归，然后进入 A8.1。仍有边界：结构入口位于源码编辑模式；没有卡片投放区。保存采用 A7.4 单包络，移动范围中的批注会保守待定位，尚无结构专用逐范围迁移。三文件事务、画布及导出未完成；未在干净 Windows 机器重新安装/卸载。当前没有 `.git` 元数据，无法执行仓库级 diff/status 审计。

## A8.1 画布数据与三文件恢复（已完成核心门槛）

本批固定 `src/core/canvas-state.ts` 的 v1 JSON 合同：Markdown 摘要、UTF-8 字节坐标、标题路径/深度/标题源码/直接正文摘要、虚拟前言/全文卡片、稳定卡片 ID、相对坐标、折叠状态、用户箭头和视口。未知字段/版本、重复 ID、越界端点、非有限坐标、超限文件和无效 UTF-8 均拒绝。相同源摘要使用精确标题字节和正文摘要恢复；外部编辑只接受唯一标题路径、标题源码和正文摘要候选，重名、改名、改正文或父级变化保留旧卡片和箭头为待修复。已核验的结构变换使用预览提供的章节身份映射，保留 ID、位置、折叠和连线。

`src/main/document-transaction.ts` 为三类文件写入不可变 before/after 快照与 journal，快照和 journal 先 `sync` 后再提交；提交逐文件获取 Markdown/YAML/JSON 锁，核验每个目标的 before/after 摘要，外部重建不覆盖，处理中断留下 displaced 原文并可按 opaque transaction ref 显式 roll-forward。YAML/画布候选重新解析并核验其新的 Markdown 摘要；旧基线候选只能保持原 anchor，不能伪装成新基线。当前事务模块尚未接入渲染 UI，下一批将把它接入嵌套画布状态。

本批验证：

```powershell
npm test
npm run typecheck
$env:MERMARKD_ELECTRON_ZIP_DIR = <本机已校验 Electron 44.4.1 zip 所在目录>
npm run package
```

- 新增 11 项画布核心测试与 5 项三文件事务测试；本批单元测试 180/180 通过，类型检查和打包通过。
- 画布样本覆盖重复标题、外部重排、改名/正文/父级、BOM/CRLF/中文/emoji、前言/全文虚拟卡片、GFM/箭头与 schema 拒绝；事务样本覆盖新增 sidecar、外部重建、Markdown 移动后中断、死/外部锁、伪造 journal 与恢复重放。

重新审查后进入 A8.2。仍有边界：事务暂未连接到真实卡片界面和主进程画布 IPC；提交策略仍是逐文件独占发布而非物理原子三文件替换，恢复依赖用户显式选择；导出和安装版三文件恢复尚未验证。

## A8.2 嵌套画布与关系持久化（已完成当前切片）

卡片模式现在由同一 `SectionTree` 和 A8.1 稳定 ID 派生，使用 React Flow 呈现父子嵌套、相对坐标和可测量的父卡边界。卡片标题过长或正文变高时，真实 `ResizeObserver` 尺寸会在自动整理前传入 ELK；子卡片位置保持在父卡内容区域。普通拖动、折叠、全部展开/收起、箭头标签、删除/更新关系、画布搜索、适应全图、视口保存和撤销/重做只写画布 JSON，不修改 Markdown 或批注 YAML。折叠分支中的箭头在画面中指向最近可见祖先并标记隐藏端点，JSON 仍保存原始端点。

画布保存由主进程校验当前 Markdown 摘要、sidecar 摘要、schema 和 dirty 状态；外部 Markdown/JSON 变化返回冲突，不覆盖现有文件。未保存源码进入卡片模式时只显示只读结构预览，布局、折叠和箭头写入禁用；编辑器主进程也拒绝绕过 UI 的 `canvas:save` 调用。编辑卡片本节会回到同一源码章节位置。

本批验证：

```powershell
npm test
npm run typecheck
$env:MERMARKD_ELECTRON_ZIP_DIR = <本机已校验 Electron 44.4.1 zip 所在目录>
npm run package
npm run test:e2e:a8-2
npm run test:e2e:a7-1
npm run test:e2e:a7-2
npm run test:e2e:a7-3b
npm run test:e2e:a7-4
npm run test:e2e:a7-5
```

- 全量 `npm test`：190/190 通过；A8.2 新增 4 项场景核心测试、2 项画布保存测试。
- `npm run typecheck`、缓存 Electron ZIP 打包及 A7.1/A7.2/A7.3b/A7.4/A7.5 打包回归全部通过。
- A8.2 打包版：4 张嵌套卡片，父卡拖动，撤销/重做，折叠隐藏后代和隐藏端点，中文箭头标签，重开恢复，1200/800/420 CSS px 无横向溢出；dirty 期间 YAML/JSON bytes 不变，直接 `canvas:save` 返回冲突。截图位于 `out/qa/a8-2-wide.png`、`out/qa/a8-2-narrow.png`、`out/qa/a8-2-mobile.png`。

本批收尾重新审查了父卡尺寸、相对位置、折叠端点、主进程 dirty 守卫、旧批次回归和打包界面，然后进入 A8.3。仍有边界：结构拖入尚未从卡片投放区调用 A7.5 预览；画布 sidecar 更新使用逐文件锁与 journal，不承诺物理断电下三个文件原子替换。

## A8.3 独立全图导出（已完成当前切片）

导出从已核验的 `CanvasScene` 生成静态 SVG，不复用交互画布的视口裁切。父子卡片先解析为绝对坐标，箭头使用包含控制点、箭头标记和长标签的完整边界；卡片导出内容来自当前 `SectionTree` 的实际标题、正文摘要和子章节数量，用户标签和正文文本均做 XML 转义。空场景保留 `1 × 1` 占位图。

主进程通过窄 preload API 接收当前 Markdown 摘要、场景卡片和箭头，重新核验章节数量、父级、源文件摘要、字段规模和颜色/尺寸范围。隐藏 sandbox 窗口只用于静态导出：PNG/JPG 用 `capturePage` 并核对实际像素尺寸，PDF 用 `printToPDF` 生成单页。输出先写已同步的临时文件，再改名到用户选择的目标；不得覆盖 Markdown 或两个 sidecar。单边超过 12,000 px、超过 40 MP、文字溢出或捕获尺寸不完整时返回明确错误，绝不静默裁切。dirty 编辑、导出并发、文档切换和布局保存在主进程与界面两层互相阻止。

本批验证：

```powershell
node --test tests/core/canvas-export.test.ts
npm test
npm run typecheck
$env:MERMARKD_ELECTRON_ZIP_DIR = <本机已校验 Electron 44.4.1 zip 所在目录>
npm run package
npm run test:e2e:a8-3
```

- 核心导出测试 4/4 通过，覆盖嵌套/视口外边界、箭头标签、XML 转义、空场景、循环父级、超大尺寸和真实标题/摘要。
- 全量 `npm test`：194/194 通过；`npm run typecheck` 通过；缓存 Electron ZIP 打包通过。
- 打包版 A8.3：PNG、JPG、PDF 均成功落盘；样本完整边界为 `1648 × 1198`，PDF 1 页；包含三层嵌套、视口外卡片、长中文关系标签，且 Markdown/YAML 未变化，dirty 时三个导出按钮全部冻结。验收脚本为 `tests/e2e/a8-3-packaged.mjs`。
- 本批重新检查了全图边界、实际捕获尺寸、PDF 页数、输出覆盖保护、源摘要复核、dirty/并发门槛和导出文件的临时发布路径。当前仍未在干净 Windows 环境完成安装/卸载与高 DPI、多屏的导出复测；超大场景在首版以明确尺寸错误停止，不自动分页或分块。

## A8.4 卡片结构投放与显式三文件保存（已完成当前切片）

真实章节卡片提供明确“设为子章节”区域，另有键盘可操作的移动/提升入口。普通拖动只保存位置；投放后先恢复拖前位置，再进入编辑模式展示全文差异和批注影响。主进程保管一次性预览 token，确认时重读 Markdown/YAML/JSON 三份独立基线，并检查 dirty、导出与保存并发、批注恢复草稿。确认只接受一条编辑 revision，不创建文件事务；取消、确认、撤销、重做和模式切换均不写三类内容文件。编辑器保持挂载以保留跨模式撤销栈，隐藏时不响应编辑快捷键。

结构专用映射复核源码变换并使用精确保留范围，包含 BOM/CRLF、重复引文、emoji、移动正文和后代；Setext 被重写的范围仍待定位。dirty 画布消费内存中的候选 JSON，保留卡片 ID 与用户箭头，但暂停写入。显式保存先保留源码恢复草稿，再核对基线，以三文件快照/journal 提交。精确撤销/重做继续使用已核验的结构映射；额外源码编辑改用保守原基线映射，不确定的批注和卡片/箭头保持待修复。缺失的 sidecar 不创建空文件。

执行 `npm test`（200/200）、`npm run typecheck`、缓存 Electron ZIP 的 `npm run package`、`npm run test:e2e:a8-4`，以及 A7.1/A7.2/A7.3b/A7.4/A7.5/A8.2/A8.3 打包版回归，最终均通过。A8.4 验证真实投放、取消恢复位置、三类过期基线拒绝、确认零写入、跨模式单步撤销/重做、dirty 主进程冻结、两条重复引文迁移、卡片 ID/箭头保持、BOM/CRLF 和重开。截图 `out/qa/a8-4-wide.png`、`out/qa/a8-4-narrow.png` 已检查。

复查发现并修复初始布局尚未结束就开放拖动/保存的时机问题，避免延迟适应全图打断第一次拖动。旧 A8.2 测试改为命中真实标题栏，并等待初始布局和隐藏连线标签就绪；A8.3 同样等待可保存状态。最初测试中的 Buffer/Uint8Array 类型断言已修正。部分并发 UI 回归受到实际窗口交互干扰，最终桌面回归串行执行并通过，没有放宽文件与语义断言。当前没有 Git 元数据；事务恢复 UI、源路径暂时缺失时的重开、干净 Windows 安装/卸载仍待下一批，不宣称 P0 完成。

## A8.5 文档事务恢复界面（已完成当前切片）

共同外壳新增“检查保存恢复”：列出当前文档未完成事务，或通过原生文件选择器选择同目录 `.journal.json`。主进程只持有经核验的路径、journal 摘要与 opaque token，向界面展示原始/候选源码和三个文件的当前状态；核验、取消不写文件。原 Markdown 被 displacement 暂时移走时，无需先打开缺失的文件，仍可选择 journal 查看候选并显式继续保存。确认重查三个目标并通过 A8.1 恢复；外部变化、活动/未知锁阻止恢复，原文与候选快照保留。

打开带未完成事务的文件会冻结编辑、批注、画布写入及导出。同会话的结构保存失败也会冻结编辑，并允许恢复对应的 pending 事务；其他 dirty 缓冲区不能被恢复操作替换。关闭该失败会话提供保留恢复记录并关闭的选项。完成事务写入绑定 journal 摘要的独占完成凭据；保留的历史快照在后续普通编辑后不误报为未完成保存，仍不能覆盖外部改动。

本批命令：

```powershell
npm test
npm run typecheck
$env:MERMARKD_ELECTRON_ZIP_DIR = <本机已校验 Electron 44.4.1 zip 目录>
npm run package
npm run test:e2e:a8-5
npm run test:e2e:a8-4
npm run test:e2e:a8-2
npm run test:e2e:a8-3
npm run test:e2e:a7-3b
npm run test:e2e:a7-4
npm run test:e2e:a7-5
npm run make
```

- 全量单测 202/202、类型检查、打包与 Squirrel 安装包生成通过。两项新事务测试覆盖完成凭据、后续外部编辑、凭据篡改与 Markdown 缺失时只读核验；已有九个真实进程退出点的三文件恢复样本继续通过。
- A8.5 打包版通过：原路径缺失恢复、YAML displacement 后部分恢复、预览取消零写入、恢复前冻结写入、外部 JSON 不覆盖、活动锁阻止、恢复后批注身份保留、后续编辑不误报历史事务，以及主进程注入 YAML 发布失败后的 readonly/dirty 状态与同会话恢复。1200/800/420 CSS px 截图位于 `out/qa/a8-5-*.png`，已逐端检查。
- A8.4/A8.2/A8.3/A7.3b/A7.4/A7.5 打包回归通过；A7.1/A7.2 在前一批已复查通过。测试修正了缩放后固定 20 px 落点可能超出标题栏的问题，改为标题实际中心；重开箭头等待其真实渲染。故障注入先等待主进程失败结果再撤除，避免把保存中的临时只读状态误认为失败；原生对话框 mock 复用主进程 `process.mainModule.require`。没有减弱文件断言。
- 最新安装包：`out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`，154,454,528 字节；可直接运行的打包应用为 `out/MerMarkd-win32-x64/MerMarkd.exe`。

本批收尾核对了三类独立摘要、失效 token、未知/活动锁、不可读 journal、源路径缺失、同会话 dirty 恢复、历史快照与完成凭据、窄 IPC 和多端对话框。仍未完成干净 Windows 安装/卸载、高 DPI/多屏、5 MB/1000 标题性能与公开发布签名。冲突或不完整事务不自动删除；恢复草稿和历史快照清理仍由显式流程处理。物理断电下目录项原子性与 Windows ACL/ADS 保留没有新增承诺，P0 仍进行中。
