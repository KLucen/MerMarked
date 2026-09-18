# MerMarkd 开发进度

> 2026-09-18。当前阶段：P0 可行性原型，进行中；最小阅读、A1 选区映射、拖入打开、A2 批注 sidecar 持久化和 A3 混排排版切片已完成。状态只记录已观察到的结果；“设计可行”不等于“功能已实现”。

## 已完成

- 建立产品与架构方案 v0.2、开发流程、可行性审查与技术决策记录。
- 检查本机环境：Windows x64，Node 24.20.0、npm 11.19.0、Git 2.45.1 可用；Rust/Cargo 与 MSVC 编译工具未发现。
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

## 当前停点

- 等待用户试用 A3 混排排版并反馈；本批不继续 A4 正式高亮界面。

## 后续切片

1. A1：选区到原文字节范围的锚点原型与边界样本，已完成。
2. A2：批注 YAML schema、安全持久化和冲突检测，已完成原型与打包版验收；待用户试用。
3. A3 混排排版已完成；A4–A6 依次是正式高亮、便签与标签、保守重定位和阅读摘要，每批交付后等待试用反馈。下一建议批次是 A4。
4. A7：章节结构移动、批注重定位与三文件恢复；A8：嵌套画布和独立 PDF/JPG 导出原型。
5. 后续完成编辑模式、卡片交互、质量打磨与正式发布。逐批验收见 `docs/DEVELOPMENT_PROCESS.md`。

## 尚未验证的门槛

- 测试安装包已生成；新版阅读切片已在打包版启动与打开文件，尚未在干净 Windows 机器或新版安装版完成安装/卸载复验。首次从 GitHub 获取 Electron 资源超时，设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后成功。前一版安装版启动时有缓存目录权限警告，UI 仍显示；卸载后 Squirrel 留下 `.dead`、`Update.exe` 和 `squirrel.exe` 残留，发布前需复测与处理。
- 章节移动、三文件恢复、外部改动后的批注自动重定位、ID 匹配和全图导出尚未由可运行代码验证。
- 5 MB 文档、1000 标题、200 可见卡片以及单图尺寸均只是目标，尚无测量结果。
- 阅读器目前将全文在渲染线程同步解析；大文件性能和图片解码后内存占用尚未测量。相对 `.md` 链接只提示暂不支持。
- 正文高亮着色、便签与标签 UI 尚未实现；A2 仅保存测试高亮锚点。A1 只支持可核验的单段落/标题选区；表格单元格、代码、跨块和部分实体/转义需后续扩大映射范围。A3 的 Windows 样本视觉验收不代表所有系统字体或平台均已验收。
- A2 的单文件替换不等于 Markdown、YAML 与画布 JSON 的跨文件事务。崩溃留下的 `.lock` 目前会保守地阻止新写入并保留草稿，安全锁恢复、断电后的目录持久化和任意外部编辑器不遵锁时的极窄竞态留待恢复切片；本批未在干净 Windows 机器重新安装/卸载，也未做资源管理器物理拖放。

## 本轮验证命令

```powershell
npm test
npm run typecheck
npm run package
npm run make
```

本轮 A3：`npm test` 38/38、`npm run typecheck`、`npm run package`、`npm run make` 通过（打包使用 Electron 镜像）。打包版在实际 100%/125%/150% 缩放下复核混排、横向滚动、选区映射与源摘要。Node 测试仍提示项目未声明 ESM 模块类型，目前不影响测试结果。
