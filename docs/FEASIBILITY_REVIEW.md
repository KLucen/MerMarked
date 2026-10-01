# MerMarkd 架构可行性审查（2026-09-17，状态更新 2026-09-30）

## 结论

现有方案**适合继续开发 Windows 首版**，但它目前是“有实现路径”，不是已经证明能无损处理任意 Markdown、任意尺寸画布。新增批注后，P0 除原有安装、结构移动、持久化与整图导出门槛，还必须证明阅读选区能准确对应原始 Markdown，以及 `.annotations.yaml` 不会误绑或丢失批注。门槛不过时先限制输入或替换局部方案，不把未经验证的能力写成已完成承诺。

本机为 Windows x64；早期记录使用 Node 24.20.0、npm 11.19.0 和 Git 2.45.1，没有 Rust/Cargo 或 MSVC 编译工具。2026-09-28 复核时系统 Git 命令为 2.55.0.windows.5，但当前工作目录没有 `.git` 元数据，所以不能执行仓库级 status/diff/提交验证。纯 TypeScript/Electron 开发已开始，原生图片模块若引入须额外验证预编译包与安装包加载。P0 安全桌面壳、阅读器、编辑器、嵌套画布和测试安装包已运行；A8.3 打包版已验证 PNG/JPG/PDF 单页全图导出。最新全量测试、类型检查、打包及 A8.3/A8.2/A7.5/A7.4/A7.3b/A7.1/A7.2/A6 打包版回归需以 `PROGRESS.md` 的最新记录为准。导出仍受单边 12,000 px、40 MP、当前窗口/显卡和单页 PDF 限制；超限明确停止，不声称任意尺寸已验证。现有 hash 命名 shadow copies 保持原样，`tsconfig.json` 显式排除 `src` 下副本。

## 可行性与问题清单

| 领域 | 可行性判断 | 主要问题与约束 | 解决方案及 P0 验收 |
| --- | --- | --- | --- |
| Electron 桌面壳 | 高 | Electron Forge 的 Vite 插件仍标为实验性；未来次版本可能有破坏性改动。发布包较大。 | npm + 锁文件固定版本；P0 就执行 `start`、类型检查、打包和 Windows `Setup.exe` 安装冒烟。若插件打包不稳定，在 UI 代码尚少时改用 Forge Webpack 模板。 |
| Markdown 章节树 | 高 | 不能用正则扫描 `#`；围栏代码、列表/引用标题、YAML frontmatter 和 Setext 会误判。 | `remark-parse` + `remark-gfm` + `remark-frontmatter`，只把根层 `heading` 节点转成可移动卡片；其他容器内标题留在正文。用固定样本断言章节父子树与源位置。 |
| 阅读渲染完整性 | 中；A7.1/A7.2 已通过当前首版合同的打包版门槛，大文档与其他平台仍待验证 | HTML 元素、属性与危险子树必须在可读性和安全性之间采用明确合同；若只在 `rehype-raw` 后删除危险容器，HTML5 foster parenting 可能先把表格文字或资源移到容器外。数学公式、Wiki Link、directive 等未支持扩展会按普通文本显示；正文查找若索引目录、占位或隐藏内容会产生不可见结果。 | 首版合同限定 CommonMark + GFM + frontmatter；所有非白名单原始 HTML 容器先在 Markdown AST 层替换，再执行 `rehype-raw → HAST 元素兜底 → rehype-sanitize`。普通未支持标签与危险内容分别显示克制占位，子树内容和资源不逃逸；原始 HTML 当前一律不可批注。只对保守识别的已知扩展给文档级提示；查找只索引可见正文并限制为 1000 项。完整合同见 `READER_DIALECT.md`，验证见 `PROGRESS.md`。 |
| 源码编辑往返 | 中，最高 Markdown 写入风险；A7.3a/A7.3b/A7.4 已通过当前单文档打包版门槛 | 编辑器字符串、BOM、CRLF/LF、无尾换行、外部修改和未保存预览可能产生无关 diff，或让批注写到错误摘要。并发候选、路径级外部重建和中断清理不能丢失可恢复内容。 | A7.3a 严格解码 UTF-8 并分离 BOM/换行元数据；候选先以不可变 generation 写入 app-data 草稿目录，再核对 expected SHA。源先移动到同目录唯一 backup，候选以独占硬链接发布。A7.3b 让纯源码编辑器共享 `DocumentSession`，textarea 使用 LF 投影，主进程按基线重建源格式；窄 IPC 不接收路径、SHA 或 BOM。dirty 阅读预览与主进程共同暂停 sidecar 写入，打开/拖入/重载/关闭不能静默丢失候选。A7.4 在 changed save 后只同步可证明的旧锚点；clean save、无 sidecar、Markdown 冲突或待处理批注草稿不写 YAML。打包版已验证 BOM+CRLF+无尾换行、changed backup、外部冲突和锚点 mixed-basis 结果。 |
| 阅读选区与原文锚点 | 中，最高批注正确性风险 | DOM Range 用渲染文本的 UTF-16 位置，`.md` 中加粗、链接、转义和实体会改变可见文本与源码的长度；现有读取还会从展示字符串去掉 BOM。全角/半角和 emoji 不能按固定字符宽度推算。 | 同一 Markdown AST 建可见文本到源码片段映射，原始文件记录 UTF-8 字节摘要/BOM 长度与半开字节范围；同时记录原文片段、上下文和章节线索。先只支持能精确反算的单块选区，复杂选区拒绝。用重复文字、中文、emoji、BOM、CRLF、格式化片段实测往返。 |
| 阅读高亮还原 | 中；A4 Windows 打包版已验证小样本 | 同一引文可能在多处出现；源码格式标记让字节范围与 DOM 文字范围不同；颜色叠加和系统高对比模式会影响可读性。 | 先核验源摘要和字节片段，再要求反向映射到唯一可见选区，DOM 文本再次核验后以 CSS Custom Highlight API 着色；无法还原不着色。已实测重复词、格式化、emoji、重叠、键盘、高对比、重开及外部改源冻结；大量记录性能和其他系统仍待测。 |
| 便签与标签交互 | 中；A5 Windows 打包版已验证小样本 | 同一锚点重复记录、标签和便签分次保存、文本注入、边栏遮挡正文或窄屏焦点丢失会损害可用性和数据一致性。 | 同锚点高亮原位转换并保留 ID、锚点、创建时间与颜色；标签和便签组成一个候选后保存一次；正文和标签只按文本渲染；宽屏边栏进入正常布局，窄屏抽屉管理焦点；待定位记录不可跳转或修改。已实测重开、冲突草稿、外部改源冻结、1200×800/800×600 布局和键盘焦点；大量记录与其他平台仍待测。 |
| 批注重定位 | 中，最高误绑风险；A6 与 A7.4 Windows 打包版小样本已验证 | 只用字节位置会在外部编辑后漂移；只用引文会碰到重复段落。章节移动也改变字节范围。一次保存含多处远距编辑时，当前单包络会保守覆盖中间区域。 | 同摘要仍核验字节片段和可见文字。A6 在外部变化后只为全文唯一且双侧上下文、阅读范围和目标碰撞均通过的记录提出候选，并由用户显式应用。A7.4 对应用内 changed save 使用保存前后精确文本：对全部等价最小单补丁对齐取并集，只有包络外锚点按 UTF-8 字节差平移，再重建上下文/章节线索并反向核验；重复删除、相交、旧基线、非渲染区域及碰撞继续待定位。打包版已验证重复引文安全平移、相交记录保留旧 basis、dirty YAML 冻结、无 sidecar 不创建和重启恢复；结构移动后的映射随 A7.5 验证。 |
| `.annotations.yaml` sidecar | 中 | YAML 可有别名、自定义标签、重复 ID 或不稳定序列化；Git 的文本 diff 也不自动保证无冲突。文件系统与解析异常若直接进入 UI，还可能泄露原文片段、字节范围或本机绝对路径。 | 每份 `example.md` 对应 `example.md.annotations.yaml`；受限 schema、大小/深度/别名限制、稳定 ID/顺序、原子写和磁盘摘要校验。读取、原文复核与 YAML 解析失败使用稳定错误码和固定自然提示，原始诊断只留主进程日志。测非法输入、错误信息边界、同 ID 冲突、两实例写入、只读目录及小改动 Git diff。 |
| 中英文混排表格/列表 | 高；A3 Windows 样本已视觉实测 | 实际字宽由字体回退、字形与缩放决定；把中文当两个半角、按空格补列会在表格/列表中错位。 | 阅读表格保留语义 `<table>`、浏览器列布局和 GFM 单元格对齐；外层容器横向滚动。列表使用原生 marker 与统一缩进，代码块独立横向滚动。已用混排、全半角标点、emoji、组合字符、长 URL、两位数列表在窄窗口及实际 Electron 100%/125%/150% 缩放验收，`.md` 未变；其他平台/字体仍待复核。 |
| 结构拖入 | 中，最高数据风险 | 原文块即使逐字移动，也可能因相邻段落、围栏、HTML、引用定义或无尾换行而改变 Markdown 的解释；Setext 可跨多行，不能一概改为 `#`。 | 使用半开文本范围和最小补丁生成**候选全文**，预览前重新解析；验证目标父子树、标题文本、非目标内容以及链接/引用解析。失败即阻止。单行 Setext 转 ATX 需展示完整差异；多行 Setext 一旦必须转 ATX，首版阻止结构拖入并引导源码编辑。操作与撤销需还原原文摘要。 |
| 稳定卡片 ID | 中 | 同名标题、复制相同段落、外部重排会让标题路径或偏移失效，错误连线比断线更糟。 | 应用内编辑追踪位置；重开时做一对一匹配，并要求唯一的高置信候选。歧义端点保留为待修复，不自动接最近标题。用重复标题、复制、重命名与外部改动样本要求“误连线数为零”。 |
| `.md` 与两类 sidecar 一致性 | 中，最高持久化风险；A7.3a 只证明单 Markdown | `.md` 明确保存、sidecar 自动保存时，YAML/JSON 可能提前引用未保存的文字或章节；三文件不能原子同时替换；双实例也可能覆盖批注或画布。 | 两类 sidecar 均记录其对应的**已落盘 Markdown 摘要**，批注记录另保留各自 `basisSha256`，允许明确的过期或混合基线但不误用旧范围。A7.3a 的不可变草稿与源 backup 不扩大为三文件承诺；未保存正文/结构与相关 sidecar 改动进恢复草稿，A8.1 才校验三个磁盘基线并写事务日志，失败或崩溃后恢复或回滚。双实例/外部写入须冲突提示或另存。 |
| 卡片画布 | 中高 | React Flow 的 `parentId` 不会自动完成容器尺寸、折叠、拖入判定或动态重排；展开长正文会改变节点尺寸。 | `SectionTree` 是唯一层级真相，React Flow 只是投影。自写父卡边界、可见子图、命中与折叠逻辑；测量真实尺寸后再异步交给 ELK。首次自动排布，之后只有用户点“自动整理”才覆盖手动坐标。P0 测三层卡片与跨层级箭头。 |
| PDF/JPG/PNG | 中，最高渲染风险 | `capturePage` 默认只截可见窗口；`printToPDF` 不懂卡片分页；交互 React Flow DOM 不适合作完整导出；超大图会触及内存/像素限制。 | 导出使用独立的静态场景：绝对定位 HTML 卡片 + SVG 箭头。边界包含节点、箭头、标签与阴影。PDF 先按纸张切片并绘制跨页续接，再显式设置 A4/A3、背景和边距调用 `printToPDF`；首版固定坐标分页，智能避让卡片为后续优化。JPG/PNG 用固定视口逐块渲染/捕获；单张超限时降倍率或编号分片，不裁切。P0 先测整图、中文、图片、跨页线与文字可复制。 |
| 图片拼接 | 有条件 | Sharp 是原生模块；缺 MSVC 时只能依赖适配当前平台的预编译包，Forge ASAR 还需解包。 | P0 先验证普通大小的单图捕获和多图分片。若确需拼接成一张，单独引入 Sharp 并在安装包内实测；未通过则不把 Sharp 设为首版硬依赖。实际单图尺寸上限按峰值内存测试决定。 |
| 安全与本地资源 | 高 | Markdown 可能包含 HTML、脚本、外链和指向目录外的图片；HTML5 树构造还能把被拒绝容器内的内容重新挂到容器外。过严的路径限制又会挡住常见相对图片。 | 原始 HTML 不执行；所有非白名单原始容器在 `rehype-raw` 前屏蔽，之后仍清洗元素、属性与协议。主进程按用户打开的文档目录/已授权工作区解析并校验真实路径，越界资源明确提示或由用户授权；渲染进程无 Node/任意文件读取权限。 |
| 安装与公开发布 | 高，但有外部依赖 | 本地 unsigned `Setup.exe` 可测；公开分发的签名证书、下载渠道与干净机器测试尚未准备。 | P0 先产出测试安装包；P5 准备签名与发布渠道，并核查第三方许可证。证书问题不阻断核心功能开发。 |

### 两项产品规则需修订

1. **“解除容纳”是结构变更。** 原方案只规定拖入父卡，保存后无法从卡片模式移回顶层。正式交互应提供“提升一级/移至顶层”，同样先预览再修改 Markdown。虚拟文档根不生成 `#` 标题；移到顶层的级别由预览明确选择，不暗中归一化原本以 `##` 开头的文档。
2. **Setext 与 Markdown 方言要诚实限制。** Setext 标题可正常阅读和卡片化；结构变更需要改成 3–6 级且标题跨多行时，首版阻止该操作。首版明确支持 CommonMark + GFM + YAML frontmatter；对能够无歧义识别的数学公式、Wiki Link、directive 等已知未支持语法给出文档级提示，其余文本按 CommonMark 解释。不能把普通文本误报为未知方言，也不能声称未支持扩展已被渲染。编辑模式仍完整显示其原文。

## 关键原型与阶段关口

| 关口 | 最小样本 | 通过标准 |
| --- | --- | --- |
| 安装包（本机已通过） | 只有安全窗口、React 页面、preload 接口的桌面壳 | npm 锁文件可重装；类型检查通过；打包后的 Windows 安装包能启动。仍需干净机及缓存权限复测 |
| 阅读/编辑模式分离（P1） | 同一 CommonMark+GFM+frontmatter fixture，含 HTML、已知未支持扩展、BOM/CRLF、中文与 emoji | 阅读 DOM 不显示受支持结构语法或源码诊断；可识别的已知未支持扩展有文档级提示；编辑缓冲区包含完整源码且不渲染；模式切换不写文件 |
| 源码保存与批注映射（A7.3a/A7.3b/A7.4 已完成验证） | BOM/无 BOM、LF/CRLF、无尾换行、无操作保存、外部修改、并发候选、外部路径重建、中断恢复、dirty 预览、重复/相交锚点与无 sidecar | 无操作摘要不变；有效修改只产生预期字节差异；外部冲突/路径重建不覆盖；changed save 返回并保留源 backup；候选草稿、孤立临时文件以及可读/不可读 backup 可检查，backup 只在无文档锁时按精确 SHA 恢复或丢弃；窄 IPC 不接收路径或格式元数据，dirty 期间 renderer/main 双层门槛阻止 sidecar 写到错误基线；只有可证明的锚点迁移到新 basis，其余内容完整保留，缺失 sidecar 不创建 |
| 阅读选区锚点 | BOM/CRLF、中文、emoji、加粗/链接/转义、重复选文、跨块选择 | 可精确映射的选区反算到同一原始 UTF-8 字节片段；复杂选区明确拒绝；不同字体/排版不改变锚点 |
| 批注 sidecar | 高亮与便签样本、非法 YAML、读取失败、外部改动、只读目录、两个实例 | YAML 小改动产生局部 diff；原文摘要不变；错误数据不覆盖；批注重开正确或待定位，错贴数为零；UI 错误提示不含原始异常、原文、字节范围或绝对路径 |
| 章节移动 | CRLF/BOM、无尾换行、中文/emoji、跳级、Setext、围栏、引用定义、相邻 HTML | 可移动样本目标层级正确，撤销后字节摘要等于原始；不安全样本有明确拒绝原因，无静默改写 |
| 三文件恢复 | 未保存结构后退出、Markdown 写完而 YAML/JSON 未写、双实例修改、外部文件修改 | 重开不丢正文/批注/箭头，不误绑选文或节点；冲突不能静默覆盖 |
| 全图导出 | 三层嵌套、跨页线、长卡、中文字体、相对图片、视口外卡片、8k 以上画布 | PDF 页数与边界正确、文字可复制；JPG/PNG 不裁切且尺寸可解释；安装包内导出可运行 |
| 混排可读性 | 中英混排表格、全半角标点、emoji、长链接、列表、代码 tab、窄窗口/缩放 | 表格列和列表标记稳定，超宽内容可横向滚动，便签不遮挡正文，Markdown 字节不变 |

批注 sidecar v1 schema 已在 A2 固定；画布 sidecar schema、导出单图上限及首版性能指标仍待对应原型关口。A7.3a 当前将单个 Markdown 源/候选限制为 32 MiB；这只是保存原型的拒绝上限，不是已验证性能承诺。对 5 MB/1000 标题/200 可见卡片的数字仍只应视为测试目标。

A7.3a/A7.3b/A7.4 还有明确的平台边界：文件级 `sync` 不包含目录 `fsync`，不承诺物理断电后的目录项持久；外部进程若持续持有旧 inode/句柄，仍可能在平台允许时迟到修改已移动的 backup。因此每次 changed save 都保留并返回 backup，而不是在本次校验通过后自动删除。A7.3b 已提供当前会话草稿与本次保存 backup 的逐项 UI，但尚未定义历史 backup 的全局扫描、保留期和自动清理。发布后的 Markdown 是新的文件对象，目前只沿用基础权限 mode，不完整保留 Windows ACL、ADS、额外元数据或原硬链接身份。A2 的 sidecar 替换会在锁内三次复核摘要，但最后一次复核与 `rename` 之间仍存在不遵锁外部写入的极小竞态窗口；A7.4 沿用这一既有单文件合同，A8.1 需要与三文件恢复一起决定更强的发布协议。跨 Markdown、批注 YAML、画布 JSON 的事务必须等 A8.1，不能用单文件结果代替。

## 已核实的一手资料

- [Electron Forge Vite 模板及实验状态](https://www.electronforge.io/templates/vite)、[Windows Squirrel 安装包](https://www.electronforge.io/config/makers/squirrel.windows)
- [Electron `printToPDF` 与 `capturePage`](https://www.electronjs.org/docs/latest/api/web-contents)、[Sharp 安装与 ASAR 要求](https://sharp.pixelplumbing.com/install/)
- [mdast 节点模型](https://github.com/syntax-tree/mdast)、[CommonMark Setext 标题](https://spec.commonmark.org/0.31.2/#setext-headings)、[引用定义规则](https://spec.commonmark.org/0.31.2/#link-reference-definitions)、[remark-frontmatter](https://github.com/remarkjs/remark-frontmatter)
- [React Flow 子流程](https://reactflow.dev/learn/layouting/sub-flows)、[布局指南](https://reactflow.dev/learn/layouting/layouting)、[图像示例的版本提示](https://reactflow.dev/examples/misc/download-image)
- [W3C Web Annotation 文本引用与位置选择器](https://www.w3.org/TR/annotation-model/#text-quote-selector)、[Selection API](https://www.w3.org/TR/selection-api/)、[WHATWG DOM 字符数据与 UTF-16 偏移](https://dom.spec.whatwg.org/#interface-characterdata)、[YAML 1.2.2](https://yaml.org/spec/1.2.2/)
- [CSS Custom Highlight API Level 1](https://drafts.csswg.org/css-highlight-api-1/)
- [Unicode East Asian Width](https://www.unicode.org/reports/tr11/)、[CSS 表格布局](https://www.w3.org/TR/css-tables-3/)、[CSS 列表标记](https://www.w3.org/TR/css-lists-3/)
