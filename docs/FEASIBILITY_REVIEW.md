# MerMarkd 架构可行性审查（2026-09-17）

## 结论

现有方案**适合继续开发 Windows 首版**，但它目前是“有实现路径”，不是已经证明能无损处理任意 Markdown、任意尺寸画布。应先完成 P0 原型的四个门槛：打出可启动安装包；安全移动真实章节；保持 Markdown 与伴随画布数据一致；从专用导出场景完整输出 PDF/JPG。门槛不过时先限制输入或替换局部方案，不把未经验证的能力写成已完成承诺。

本机已检查为 Windows x64，Node 24.20.0、npm 11.19.0、Git 2.45.1 可用；没有 Rust/Cargo 或 MSVC 编译工具。纯 TypeScript/Electron 开发可开始，原生图片模块若引入须额外验证预编译包与安装包加载。当前仓库此前只有设计文档，未有可运行代码；P0 桌面壳正在建立。

## 可行性与问题清单

| 领域 | 可行性判断 | 主要问题与约束 | 解决方案及 P0 验收 |
| --- | --- | --- | --- |
| Electron 桌面壳 | 高 | Electron Forge 的 Vite 插件仍标为实验性；未来次版本可能有破坏性改动。发布包较大。 | npm + 锁文件固定版本；P0 就执行 `start`、类型检查、打包和 Windows `Setup.exe` 安装冒烟。若插件打包不稳定，在 UI 代码尚少时改用 Forge Webpack 模板。 |
| Markdown 章节树 | 高 | 不能用正则扫描 `#`；围栏代码、列表/引用标题、YAML frontmatter 和 Setext 会误判。 | `remark-parse` + `remark-gfm` + `remark-frontmatter`，只把根层 `heading` 节点转成可移动卡片；其他容器内标题留在正文。用固定样本断言章节父子树与源位置。 |
| 结构拖入 | 中，最高数据风险 | 原文块即使逐字移动，也可能因相邻段落、围栏、HTML、引用定义或无尾换行而改变 Markdown 的解释；Setext 可跨多行，不能一概改为 `#`。 | 使用半开文本范围和最小补丁生成**候选全文**，预览前重新解析；验证目标父子树、标题文本、非目标内容以及链接/引用解析。失败即阻止。单行 Setext 转 ATX 需展示完整差异；多行 Setext 一旦必须转 ATX，首版阻止结构拖入并引导源码编辑。操作与撤销需还原原文摘要。 |
| 稳定卡片 ID | 中 | 同名标题、复制相同段落、外部重排会让标题路径或偏移失效，错误连线比断线更糟。 | 应用内编辑追踪位置；重开时做一对一匹配，并要求唯一的高置信候选。歧义端点保留为待修复，不自动接最近标题。用重复标题、复制、重命名与外部改动样本要求“误连线数为零”。 |
| `.md` 与伴随 JSON 一致性 | 中，最高持久化风险 | `.md` 明确保存、sidecar 自动保存时，sidecar 可能提前引用未保存的新章节；两个文件不能原子同时替换；双实例也会覆盖画布。 | sidecar 记录其对应的**已落盘 Markdown 摘要**。未保存正文/结构与相关画布改动进同一恢复草稿；保存先校验两个磁盘基线，再写 Markdown、再写新 sidecar，失败或崩溃由事务日志恢复。双实例/外部写入须冲突提示或另存，不能静默覆盖。 |
| 卡片画布 | 中高 | React Flow 的 `parentId` 不会自动完成容器尺寸、折叠、拖入判定或动态重排；展开长正文会改变节点尺寸。 | `SectionTree` 是唯一层级真相，React Flow 只是投影。自写父卡边界、可见子图、命中与折叠逻辑；测量真实尺寸后再异步交给 ELK。首次自动排布，之后只有用户点“自动整理”才覆盖手动坐标。P0 测三层卡片与跨层级箭头。 |
| PDF/JPG/PNG | 中，最高渲染风险 | `capturePage` 默认只截可见窗口；`printToPDF` 不懂卡片分页；交互 React Flow DOM 不适合作完整导出；超大图会触及内存/像素限制。 | 导出使用独立的静态场景：绝对定位 HTML 卡片 + SVG 箭头。边界包含节点、箭头、标签与阴影。PDF 先按纸张切片并绘制跨页续接，再显式设置 A4/A3、背景和边距调用 `printToPDF`；首版固定坐标分页，智能避让卡片为后续优化。JPG/PNG 用固定视口逐块渲染/捕获；单张超限时降倍率或编号分片，不裁切。P0 先测整图、中文、图片、跨页线与文字可复制。 |
| 图片拼接 | 有条件 | Sharp 是原生模块；缺 MSVC 时只能依赖适配当前平台的预编译包，Forge ASAR 还需解包。 | P0 先验证普通大小的单图捕获和多图分片。若确需拼接成一张，单独引入 Sharp 并在安装包内实测；未通过则不把 Sharp 设为首版硬依赖。实际单图尺寸上限按峰值内存测试决定。 |
| 安全与本地资源 | 高 | Markdown 可能包含 HTML、脚本、外链和指向目录外的图片。过严的路径限制又会挡住常见相对图片。 | 原始 HTML 不执行；清洗渲染并限制链接协议。主进程按用户打开的文档目录/已授权工作区解析并校验真实路径，越界资源明确提示或由用户授权；渲染进程无 Node/任意文件读取权限。 |
| 安装与公开发布 | 高，但有外部依赖 | 本地 unsigned `Setup.exe` 可测；公开分发的签名证书、下载渠道与干净机器测试尚未准备。 | P0 先产出测试安装包；P5 准备签名与发布渠道，并核查第三方许可证。证书问题不阻断核心功能开发。 |

### 两项产品规则需修订

1. **“解除容纳”是结构变更。** 原方案只规定拖入父卡，保存后无法从卡片模式移回顶层。正式交互应提供“提升一级/移至顶层”，同样先预览再修改 Markdown。虚拟文档根不生成 `#` 标题；移到顶层的级别由预览明确选择，不暗中归一化原本以 `##` 开头的文档。
2. **Setext 与 Markdown 方言要诚实限制。** Setext 标题可正常阅读和卡片化；结构变更需要改成 3–6 级且标题跨多行时，首版阻止该操作。首版明确支持 CommonMark+GFM+YAML frontmatter；MDX、数学公式和自定义扩展可按原文阅读，但其结构变换不承诺无损，未通过重解析校验时阻止。

## P0 原型的四个关口

| 关口 | 最小样本 | 通过标准 |
| --- | --- | --- |
| A. 安装包 | 只有安全窗口、React 页面、preload 接口的桌面壳 | npm 锁文件可重装；类型检查通过；打包后的 Windows 安装包能启动 |
| B. 章节移动 | CRLF/BOM、无尾换行、中文/emoji、跳级、Setext、围栏、引用定义、相邻 HTML | 可移动样本目标层级正确，撤销后字节摘要等于原始；不安全样本有明确拒绝原因，无静默改写 |
| C. 双文件恢复 | 未保存结构后退出、Markdown 写完而 sidecar 未写、双实例修改、外部文件修改 | 重开不丢正文/箭头、不误绑节点；冲突不能静默覆盖 |
| D. 全图导出 | 三层嵌套、跨页线、长卡、中文字体、相对图片、视口外卡片、8k 以上画布 | PDF 页数与边界正确、文字可复制；JPG/PNG 不裁切且尺寸可解释；安装包内导出可运行 |

完成这些关口后再锁定侧边文件 schema、导出单图上限及首版性能指标。目前对 5 MB/1000 标题/200 可见卡片的数字只应视为测试目标，不应当作已验证承诺。

## 已核实的一手资料

- [Electron Forge Vite 模板及实验状态](https://www.electronforge.io/templates/vite)、[Windows Squirrel 安装包](https://www.electronforge.io/config/makers/squirrel.windows)
- [Electron `printToPDF` 与 `capturePage`](https://www.electronjs.org/docs/latest/api/web-contents)、[Sharp 安装与 ASAR 要求](https://sharp.pixelplumbing.com/install/)
- [mdast 节点模型](https://github.com/syntax-tree/mdast)、[CommonMark Setext 标题](https://spec.commonmark.org/0.31.2/#setext-headings)、[引用定义规则](https://spec.commonmark.org/0.31.2/#link-reference-definitions)、[remark-frontmatter](https://github.com/remarkjs/remark-frontmatter)
- [React Flow 子流程](https://reactflow.dev/learn/layouting/sub-flows)、[布局指南](https://reactflow.dev/learn/layouting/layouting)、[图像示例的版本提示](https://reactflow.dev/examples/misc/download-image)
