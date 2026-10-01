# MerMarkd 阅读方言与安全 HTML 合同

> 版本：A7.2，2026-09-25。本文规定阅读模式如何解释 Markdown、如何处理原始 HTML，以及“查找正文”和阅读批注能作用于哪些内容。最终打包版验收状态见 `PROGRESS.md`。

## 1. 方言范围

阅读模式支持 **CommonMark + GitHub Flavored Markdown（GFM）+ 文档开头的 YAML frontmatter**。

- CommonMark 结构包括 ATX/Setext 标题、段落、换行、分隔线、引用、无序/有序列表、围栏或缩进代码块、行内代码、强调、粗体、链接、图片、转义和实体。
- GFM 增加删除线、自动链接字面量、表格和只读任务列表。任务复选框不能在阅读模式中修改；要改变 `[ ]` 或 `[x]`，以后进入编辑模式修改源码。
- 文档开头由 `---` 包围的 YAML frontmatter 被识别为元数据区并从阅读正文隐藏；当前阅读器不解释或展示其中字段。当前还没有“文档信息”界面；编辑模式实现后会逐字显示这些源码。
- Markdown 标题树是章节目录的唯一结构来源。白名单原始 HTML 中的 `h1`–`h6` 可以作为正文语义显示，但不会成为目录项、卡片或章节身份。

受支持结构只显示语义结果。例如标题不显示 `#` 或 Setext 下划线，表格不显示管线和分隔行，代码块显示代码内容而不显示围栏。代码内容或转义结果中的 `#`、`*` 等属于正文，继续原样显示。

## 2. 渲染与清洗顺序

正文按固定顺序处理：

1. `react-markdown` 解析 CommonMark，`remark-gfm` 解析 GFM，`remark-frontmatter` 识别并隐藏 YAML frontmatter。
2. 在 `rehype-raw` 运行前，MerMarkd 检查 Markdown AST 中的原始 HTML。白名单外的普通或危险容器从起始标签到匹配结束标签都先替换为内部占位，容器内的文字、表格和资源节点不会交给 HTML5 树构造。
3. `rehype-raw` 只把白名单原始 HTML 和内部占位解析为 HAST 节点；这道前置边界避免 HTML5 foster parenting 把被拒绝容器内的文字或资源移到容器外。
4. MerMarkd 的 HAST 元素策略再次检查每个子树；任何残留的白名单外元素仍连同整个子树替换为一个占位。
5. `rehype-sanitize` 再按显式 schema 删除未允许的属性、协议和类名。
6. 链接、图片、表格和代码块仍通过阅读器现有组件处理；本地相对图片必须通过主进程的文档目录权限边界。

这个顺序同时作用于 Markdown 生成的元素与原始 HTML。任何内容都没有绕过清洗直接进入正文 DOM 的路径。

## 3. HTML 元素白名单

首版白名单只包含阅读正文需要的语义元素：

```text
a abbr b bdi bdo blockquote br cite code dd del details dfn dl dt em
h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p pre q rp rt ruby
s samp small span strong sub summary sup table tbody td th thead time tr
u ul var wbr
```

这份列表是允许元素的完整集合。常见的布局或交互容器如 `div`、`section`、`button`、`form`、`video`、`svg` 不在列表中，不能借原始 HTML 扩大阅读器界面能力。

### 3.1 允许的属性

所有白名单元素只可保留 `dir`、`lang` 和 `title`。以下元素另有最小属性集合：

| 元素 | 额外允许属性 |
| --- | --- |
| `a` | `href`、`title` |
| `blockquote`、`q` | `cite` |
| `code` | 仅 `language-*` 形式的 `className` |
| `del`、`ins` | `cite` |
| `details` | `open` |
| `img` | `alt`、`src`、`title` |
| `input` | 只允许禁用的 checkbox 所需 `disabled`、`type="checkbox"`、`checked` |
| `li` | 仅 GFM 任务项类名 `task-list-item` |
| `ol` | `start` 和 GFM 任务列表类名 `contains-task-list` |
| `span` | 仅内部占位所需 `className="html-placeholder"` 与 `role="note"` |
| `td` | `align`、`colSpan`、`headers`、`rowSpan` |
| `th` | `align`、`colSpan`、`headers`、`rowSpan`、`scope` |
| `time` | `dateTime` |
| `ul` | 仅 GFM 任务列表类名 `contains-task-list` |

事件处理器、`style`、任意 `class`、`id`、`name` 和未列出的 ARIA 属性会被删除。`href` 只允许 `http`、`https`、`mailto` 或无协议的相对引用；`src` 只允许 `http`、`https` 或无协议的相对引用。相对图片仍受“只能读取当前 Markdown 所在目录”规则约束；相对 Markdown 链接当前只给出暂不支持提示。

### 3.2 占位与危险子树

- 白名单外的普通元素替换为一个克制的文本占位：`此 HTML 内容暂不显示（tag）`。
- `audio`、`base`、`embed`、`form`、`iframe`、`link`、`meta`、`object`、`picture`、`script`、`source`、`style`、`svg`、`template`、`video` 使用统一的“`不安全的 HTML 内容已隐藏`”占位；危险内容不会混用普通未支持标签的提示。
- 非白名单容器首先在 `rehype-raw` 前按原始 HTML 范围替换，并在 HAST 层再次兜底。子元素的文字、图片、链接、脚本和资源引用不会被 HTML5 foster parenting 提取到占位外，也不会进入正文查找。
- 每个被替换的顶层子树只产生一个占位，避免把内部实现或危险文本扩展成大段阅读内容。

占位说明是应用提示，不是 Markdown 原文，也不能被正文查找或批注选区使用。

## 4. 原始 HTML 与批注

A7.2 允许部分原始 HTML **安全显示**，但当前源码选区映射只支持能够从普通 Markdown 标题或段落精确回环到原文字节的范围。它不解析 HTML 标签、实体和 HTML 子树边界。

因此，原始 HTML 派生的可见文字目前不能创建高亮、便签或人工重选目标。选择这类文字时，阅读器应给出自然语言的不支持提示，不能搜索同名文字、剥离标签后猜测字节范围，也不能把批注错误附到相邻的 Markdown。该限制同时适用于白名单 HTML 和占位；占位本身不会进入查找或批注。

以后若扩展 HTML 批注，必须先在 `src/core` 建立可往返验证的源码映射，并补充标签嵌套、实体、重复文本和外部修改测试，不能只依据 DOM 文本偏移启用。

### 4.1 批注加载错误的呈现边界

批注 sidecar 读取失败、当前 Markdown 复核读取失败和 YAML 格式无效分别使用稳定错误码 `annotation-read-failed`、`source-read-failed` 和 `sidecar-invalid`。阅读界面只收到与错误码对应的自然中文提示。

原始 `error.message`、`sourceExact`、UTF-8 字节范围和 sidecar 绝对路径不能拼入 `AnnotationDocumentView.reason`。详细异常只记录在主进程日志中，供排查使用；读取失败保持只读，不用不完整数据猜测锚点或覆盖文件。

## 5. 已知未支持扩展

数学公式、Wiki Link 和自定义 directive 不属于当前阅读方言。检测器只识别较明确的拼写：

- 至少一对独占一行的 `$$`，提示“数学公式”；
- 行内代码之外未转义的 `[[...]]`，提示“Wiki Link”；
- 常见的块、叶子或行内 directive 形式，提示“自定义指令”。

frontmatter、围栏代码块和行内代码中的相同字符不参与提示。每种扩展在一份文档中最多列出一次，界面只显示一个文档级提示。检测器不会改写或执行扩展内容；内容继续按 CommonMark 普通文本规则解释，因此未支持的扩展标记可能作为正文出现。

这是保守提示器，不是完整的扩展语法解析器。没有提示不表示任意第三方 Markdown 方言已经兼容；可能有多种解释的普通文字也不会被武断标成扩展。

## 6. 可见正文查找

`Ctrl+F` 或“查找正文”只搜索当前 `.markdown-body` 中实际可见的文本：

- 不搜索章节目录、文件状态、模式导航、批注边栏、搜索条自身或其他应用界面；
- 不搜索 frontmatter、HTML 占位、`hidden`、`aria-hidden="true"` 或当前没有可见布局范围的内容；关闭的 `details` 内文因此不计入结果，展开后重新查询即可计入；
- 查询被当作普通文字而不是正则表达式，使用 Unicode 不区分大小写匹配；结果必须从完整字素边界开始和结束，不能截断 emoji 或组合字符；
- 结果不重叠，不跨标题、段落、列表项、表格单元格、代码块等阅读块，也不跨 `<br>`；内联强调或链接不会人为切断同一阅读块中的普通文字；
- 一次最多保留 1000 个结果。存在更多结果时，搜索条显示“仅显示前 1000 项”。

全部命中与当前命中使用独立 CSS Highlight 层，当前命中所在阅读块还有轮廓，避免只靠颜色表达状态。Enter 或“下一项”向后循环，Shift+Enter 或“上一项”向前循环；Escape 或关闭按钮结束查找并把焦点送回“查找正文”入口。

查找不会创建浏览器原生选区，不会成为高亮/批注目标，也不会写 `.md`、`*.md.annotations.yaml` 或 `*.md.mermarkd.json`。换文档时会清除查询、结果和视觉标记。

## 7. 三模式边界

- **阅读模式**使用本文方言和安全策略，查找可见语义正文，并承载高亮、便签、标签、摘要与锚点修复。普通阅读不显示源码标记、字节偏移或原始锚点诊断。
- **编辑模式**以后逐字显示完整 Markdown，包括 frontmatter、原始 HTML 和未支持扩展；它使用源码查找/替换，不运行本文的阅读正文搜索，也不在源码选区上弹出批注工具。
- **卡片模式**以后从 Markdown 标题树派生章节卡。卡片中的阅读化摘要应复用本文安全渲染原则；原始 HTML 标题不能成为卡片结构。卡片查找和全图导出属于卡片模式。

模式切换本身不得修改 Markdown、批注 YAML 或画布 JSON。详细写入和 dirty 状态规则见 `MODE_BOUNDARIES.md`。

## 8. 当前限制与验收责任

- 大文件仍在渲染线程同步解析；5 MB 文档和 1000 标题尚无性能基线。
- 1000 项是正文查找的产品上限，不代表已经完成 1000 个结果的跨平台性能验收。
- 原始 HTML 只解决安全阅读，不承诺完整网页布局、表单、媒体、SVG、脚本或 CSS 兼容。非白名单容器必须继续在 `rehype-raw` 前屏蔽，不能退回到仅在 HTML5 树构造后删除。
- 新增或放宽 HTML 元素、属性、协议、扩展语法时，必须先修改本合同和核心策略测试，再进行打包版危险内容、文件权限与被动零写入回归。

A7.2 的最终验收已覆盖语义 fixture、安全 HTML、未支持扩展提示、可见/隐藏正文查找、1000 项上限、强制颜色、窄窗口、A7.1 选区回归和 A6 批注回归。最终安全收口另加入 HTML5 foster parenting 与批注错误信息泄漏的聚焦回归；实际执行命令和观察结果只记录在 `PROGRESS.md`。
