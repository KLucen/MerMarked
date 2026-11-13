# QA1 阶段收口验证

> 2026-11-08 开始，2026-11-12 完成本轮本机验证，2026-11-13 整理交付。输入修复 `cc386b0` 的干净构建、319 项单测、make、28 套窗口、实际 Vite 与真实 WeType 通过，本机安装、两次升级及卸载已记录。正式性能 A 轮保留 44 项超限；B 轮普通 40 份在已记录的 `nativeAPIs` 环境中满足所测动作预算，C 轮 pending 五次通过、内存四组采样完成。辅助功能增强路径、一次未定位拖动异常、一个终末失焦快照、卸载残留及外部设备/发布门槛继续保留，不将本机通过范围扩大为 QA1 或 P0 整体退出。当前阶段以 [开发进度](PROGRESS.md) 为准。

QA1 对应 [设计复核中的第 7 批](DESIGN_REVIEW_2026-10-14.md)。目标是从干净检出构建，在同一提交和包体上核验三模式、保存及恢复、完整场景导出和性能，并分别记录实际设备与安装生命周期证据。

## 当前验收矩阵

| 项目 | 当前状态 | 已有证据与后续范围 |
| --- | --- | --- |
| 干净源码检出 | 当前 `cc386b0` 已通过 | `npm ci`、类型检查、319/319 单测和 Squirrel make 全过，源码与锁文件核验通过。回执为 `qa1-ime-final-build-manifest.json`；ASAR `8659…` |
| 三模式与数据边界 | 当前包 28 套通过 | `qa1-ime-bound-a-regression-manifest.json` 为 28/28，绑定 `8659…` ASAR、测试提交 `5b4093f`。实际 Vite 的 UX7 与 UX8 同样通过，服务已停止 |
| 中文组合输入与真实 IME | 当前包本机验收通过 | 独立回归旧实现三项失败、新实现八项通过；完整 UX7 及原生 `qa1-ime-fixed-report.json` 通过，绑定 `8659…`，记录 34 个原生 keydown 和真实候选截图 |
| 完整场景导出 | 当前包三格式专项通过 | `qa1-ime-bound-a-a8-3.log` 验证 8228×1024 PNG/JPG/PDF、长中文标签、嵌套与视口外节点、dirty 冻结和源文件不变；升级后的实际安装版 2180×634 PNG 同样通过 |
| 物理 DPI | 单屏 125% 已盘点与观察 | 当前只有一块 `NE160QDM-NZB` 显示器，Electron 报告缩放 1.25、逻辑边界 2048×1280。用户确认只有当前单屏电脑，真实跨屏验收仍需额外显示设备 |
| 本机安装及卸载 | 安装通过；卸载入口清理通过，有目录残留 | 实际 Setup 安装与根启动器通过。最终卸载退出 0，20 秒后进程、注册项及两处快捷方式均清除，原 Roaming 57 文件保持基线；安装目录保留四个文件及子目录，不宣称零残留 |
| 跨版本升级 | 两次本机升级与数据保留通过 | `0.1.0 → 0.1.1-qa1 → 0.1.2-qa1` 均由实际 updater 执行；最后包 ASAR、根启动器、UX7/UX8、四档软件 DPR、便签、标签、三卡几何、箭头和三文件 bytes/mtime 通过，2180×634 PNG 成功 |
| 干净 Windows 环境 | 当前设备条件待补 | 用户确认只有当前电脑且无额外干净 Windows 环境。本机有开发工具和既有应用数据，未发现可用的 Windows Sandbox、Hyper-V 管理环境、VMware 或 VirtualBox |
| 性能多轮采样 | A 轮未通过；B 所测动作通过，C 专项完成 | 当前 `8659…` 包 A 轮保留 44 项超限，5 MiB 长帧最高 558 ms。B 普通 40 份为 `met-for-recorded-actions`、0 项超限，80 份前后快照均为 `nativeAPIs`，含一个终末失焦快照。B 后续 pending 保留一次拖动失败；C 五次完整通过、内存四组采样完成。增强 AX 性能与单次拖动异常未解决，不宣称无内存泄漏 |
| 公开发布 | 待发布阶段核验 | 当前本地测试包未签名，`package.json` 仍为 `UNLICENSED`。许可证清单、签名条件和渠道需要独立验收 |

## 构建身份与历史尝试

2026-11-08 从 `4131dd951df76b7d198f3fa0767e3fc496bba436` 创建 detached worktree。Node 为 `v24.20.0`，npm 为 `11.19.0`。串行执行 `npm ci`、`npm run typecheck`、`npm test` 和 `npm run make`，四项退出码均为 0，单测为 318/318。构建后源码状态干净，锁文件 SHA-256 保持 `6E3FF39AE568D411DDB8631117C87F2932B8E254AB5F3F69C8646DB3BA43603E`。逐步命令、时间、日志哈希和产物身份记录在本地 `out/qa/qa1-clean-build-manifest.json`。

该次 ASAR 为 4,067,936 字节，SHA-256 为 `C3E818A322763EE2741CD915F4110D3859DBDC004D20BDC0401B7656C0C73F03`，与 UX8 F 运行时一致。该次重打的 Setup 为 154,836,992 字节，SHA-256 为 `D9570EF7022E622DE1AC8D2BFEEFCCAFB6D7DC98D9C55E10C8621ACE523466C5`。安装包容器的重打哈希与上一份 Setup 不同，验收引用各自 manifest 中的产物身份。

最初 worktree 位于项目的 `out/qa/qa1-clean-4131dd9`。主工作区直接运行默认 `node --test` 时，递归发现了工作区与嵌套 worktree 的两份测试，日志 `qa1-ime-fix-unit.log` 中的 636 项对应两份 318 项。随后通过 `git worktree move` 将验证工作树移至 `C:\Users\KLucen\.codex\worktrees\mermarkd-qa1-validation`。后续独立工作树的 318 项结果用于计数。

候选历史修复提交 `021c84a5330a7deed6e586bf8d260ef92c3c5391` 在外置工作树重新完成 `npm ci`、类型检查、318 项单测和 make，四项退出码均为 0。记录位于 `out/qa/qa1-fixed-clean-build-manifest.json` 及同前缀日志。光标修复 `d76c02e` 随后纳入分支，已合并 PR #19 的主线 `27a4830`，组合提交为 `4b8f51b`。

`4b8f51b` 构建 A 轮因 PowerShell 参数展开错误退出 1，原日志 `qa1-final-clean-ci.log` 与 `qa1-final-clean-build-manifest.json` 保留。修正参数后，B 轮 `npm ci`、类型检查和 319/319 单测通过，make 在下载 Electron 时遇到官方 GitHub HTTPS `ETIMEDOUT`。C 轮通过既有配置 `MERMARKD_ELECTRON_ZIP_DIR` 使用经过 SHA-256 核验的本地 Electron `44.4.1` ZIP，make 退出 0。ZIP 为 158,290,103 字节，SHA-256 为 `34BC07977D6C43B6514B956A5F2E3292255DAA3838A49E6110F3FE19FFAFB83F`。完整回执 `qa1-final-clean-c-build-manifest.json` 保留 A/B 尝试索引、各阶段命令与日志哈希，该轮源码干净且锁文件摘要一致。

`4b8f51b5e3c454cb491d23cd6f8a764e37e0d914` 的 ASAR 为 4,068,827 字节，SHA-256 为 `24AC09F913C2D41A3C897D31E62C1C968854FB46567FC18891E8D31472D0F7C2`。Setup 为 154,837,504 字节，SHA-256 为 `3CC81151A4D8D0AC303AE07245FD8B8C1B053FDDE635C9398B1B779CD578EC88`。完整原生输入回执和隔离修复后的 D 轮 28 套窗口均绑定该运行时，不能自动转算为后续导出修复包的结果。

导出修复阶段运行时为 `f72101a6db0abc1fdb633c2805eaabd960d26593`，源树为 `dd768a1a7d3832c4e70f63923c3bcc178dc1954a`。独立干净检出完成 `npm ci`、`npm run typecheck`、`npm test` 和 `npm run make`，全部退出 0，单测 319/319；检出与构建后源码均干净，锁文件、冻结的既有验证文件与主工作区 index 均核验不变。使用同一核验 Electron ZIP，回执为 `out/qa/qa1-export-final-build-manifest.json`。

该 `0.1.0` 生产构建 ASAR 为 4,069,447 字节，SHA-256 为 `763C7CDB04CA79E68470D7C5C7045A19E718B097E00F222DF43E63BA004216B4`；Setup 为 154,837,504 字节，SHA-256 为 `B4396A76F5A3317D67969E50DA09E194C684A94EAFCEA35E24019198C2E392C5`。本地升级测试版本另有身份，见下文。两个构建与旧 `24AC…` 运行时分别记录，不以版本号相同推定包体相同。

最终输入修复运行时为 `cc386b045d1d9bef868ad07a034f21937753e719`。干净外置工作树完成 `npm ci`、类型检查、319/319 单测和 make，全过且锁文件不变，回执 `qa1-ime-final-build-manifest.json`。生产 ASAR 为 4,069,732 字节，SHA-256 `86596030FA1E4B1B40DEEB02FBF50384145E459BB35E4A398EABBB695E938033`；Setup 为 154,838,016 字节，SHA-256 `0BE1657EFB48BE2BF9293B8B4836D2BBFA494528572BE123996B51CAA900EF04`。测试路径核验提交 `5b4093f` 随后快进到同一工作树，仅改测试，未重写该 ASAR。完整 28 套的 manifest 记录测试提交及实际 ASAR；原生与性能也分别绑定此包。

性能环境元数据提交 `4a2d4b04b3face2ed4f6ee73b0a9d518e0e5fa4f` 随后仅修改两份性能测试脚本，在每份进程样本的计时操作前后读取实际辅助功能 features、辅助功能状态、窗口状态与显示刷新率。读取位于计时之外，没有修改产品、计时区间、预算、动作或生产 ASAR。

## 真实输入发现与工程回归

2026-11-08 在隔离临时 Markdown 和独立 user-data 目录中，通过原生按键观察到 WeType 中文候选框。记录捕获了 `compositionstart`、`compositionupdate`、`insertCompositionText` 和 `compositionend`。源码末尾输入拼音 `ni`，空格提交“你”后文本正确，第一次 `Ctrl+Z` 却恢复“ni”。`qa1-ime-source-commit.json` 与 `qa1-ime-source-undo.json` 保留最终中文及中间拼音的实际编辑器值和原生事件。

同轮中，活动候选期间的 `Ctrl+S` 保留候选，三文件 bytes/mtime 比较一致，见 `qa1-ime-before-ctrls.json` 与 `qa1-ime-after-ctrls.json`。`Escape` 取消后源码和光标恢复到原状态，见 `qa1-ime-source-cancel.json`。实际主进程 `app.getPath('userData')` 与传入的隔离 profile 一致。已提交中文的显式保存结果保留 UTF-8 BOM 与 CRLF，两个缺失 sidecar 继续缺失，见 `qa1-ime-source-save.json`。

根因是 CodeMirror 的每次候选 `docChanged` 都进入共享历史。`021c84a` 将组合期间的候选保留在源码编辑表面，组合结束后等待最终 DOM 变更刷新，再一次发布最终文本。取消恢复原文时只更新选区。组合结束至发布期间沿用既有 activity 门槛保护保存和离开操作，外部替换及销毁会清理待执行回调。

新增 UX7 工程回归通过 CDP 驱动 Chromium 组合事务，逐步等待 CodeMirror 实际显示 `n`、`ni` 和“你”。旧包首次运行在等待可信 `compositionend` 时超时，日志为 `qa1-ime-red-ux7.log`。该 CDP 路径的候选输入事件为可信 `insertCompositionText`，结束事件的 `isTrusted` 实测为 false。修正这一测试假设后，`qa1-ime-red-diagnostic-ux7.log` 明确在一次 Undo 应回到原文的断言失败，实际恢复“ni”。两个原失败均保留。

2026-11-12，`021c84a` 的完整 UX7 专项通过，日志为 `qa1-fixed-a-ux7.log`。结果包含一次撤销完整组合、重做最终中文、跨模式共享撤销、取消组合无新增历史及组合期间保存保护。该专项继续保留原合成事件门槛，并独立报告 Chromium 组合回归字段。

同日真实输入复测确认候选提交“你”后，一次原生 `Ctrl+Z` 已恢复完整原文。新的失败是光标由输入前的 22 跳到 0。证据依次为 `qa1-fixed-native-before.json`、`qa1-fixed-native-commit.json` 与 `qa1-fixed-native-undo.json`，候选截图为 `qa1-fixed-native-candidate.png`。

光标修复 `d76c02ee1a1ac7badd2b22e5e64bfa18ff188168` 将撤销快照的选区绑定到经过核验的本次修改范围。撤销恢复被修改前的文字范围，重做仍恢复新插入范围。新增聚焦用例覆盖非零位置插入、替换、删除、重做后再次撤销及旧会话不可变，UX7 专项增加组合撤销后的源码末尾光标断言。

`4b8f51b` 包的真实 WeType 流程已完成。源码中观察候选并提交中文，`Escape` 取消后文字和光标恢复，组合期间 `Ctrl+S` 的三文件比较一致，一次撤销恢复完整组合与原光标，重做恢复最终中文。阅读正文中同样观察到候选，组合期间保存保持三文件不变。一次点击失焦提交了字面 `n` 后切换源码，已核验最终文字和跨模式共享撤销。随后在正文提交中文，使用 `Ctrl+Enter` 应用，再显式 `Ctrl+S` 保存，结果保留 UTF-8 BOM 与 CRLF，缺失 sidecar 继续缺失。

聚合回执 `out/qa/qa1-final-ime-report.json` 的状态为 `passed`，绑定 `4b8f51b` 和旧 `24AC…` ASAR，累计记录 33 个原生 keydown 事件。源码候选、撤销光标、正文候选与正文保存四张截图的文件名及 SHA-256 均列在 `screenshots` 字段。中途一次 redo 前检测到窗口最小化及人工输入，该次尝试由守卫阻止，原生按键数为 0。用户明确可以继续后恢复前台，后续 redo 完成并核验。该记录仅代表此旧包在当前设备上的 WeType 流程，不外推到后续包；最终新包的独立复核见下文。

`out/qa/qa1-installed-updated-ux7.log` 曾被标记为安装版运行，实际旧脚本硬编码工作区 exe，未采用 `MERMARKD_QA_EXE`，因此运行的是未更新的 UX8 / `C3E8…` 包。`qa1-ime-final-ux7-first.log` 也有同一归属错误。这些日志保留一次撤销恢复 `ni` 的实际失败，但不能归因到 `EF65…` 或新 `8659…` 包。`5b4093f` 在共同启动 helper 支持明确可执行文件并独立核对主进程 `process.execPath`，防止包体标记与实际路径分离。

独立的 `source-composition-race.mjs` 直接构建真实 SourceSurface、MarkdownEditorView 与共享历史核心，控制公开测量调度和浏览器事件顺序。`qa1-ime-race-red.json` 在旧源码稳定重现 229、结束后的 isComposing Enter 和延迟最终更新三项失败。修复 `cc386b0` 后 `qa1-ime-race-green-c.json` 的八项场景通过，包含立即 Ctrl+Z/重做、取消、连续组合、换文档和销毁。临时诊断曾跑真实 Vite UX7 六次均过，诊断代码已移除。`qa1-ime-final-ux7-bound.log` 通过，并核验实际运行新生产 exe。完整窗口、实际 WeType 与安装版分别验收，确定调度不替代物理输入。

最终 `8659…` 包的独立 WeType 复核现已通过，`qa1-ime-fixed-report.json` 记录 34 个原生 keydown、源码及正文的真实候选、取消、组合期间保存零写入、一次撤销完整中文及原光标、重做、正文失焦提交字面 `n` 后切模式及共享撤销、正文提交中文后显式保存。保存逐字节核对 UTF-8 BOM、CRLF 与缺失 sidecar 零创建。四张 `.jpg` 直接保留原生窗口截图，包括外部候选框，文件 SHA-256 列在回执中；本轮没有窗口最小化或人工输入中断。

## 测试隔离失败、恢复与窗口回归

A 轮在 UX4 的键盘选项选择处失败，`qa1-final-a-ux4.log` 与 A 轮 manifest 保留。`82a5cf1` 将输入前提补为控件可见、可用、非 inert、目标选项存在，并核验真实焦点后发送原键盘流程；B 轮 28 套通过。该轮随后发现下述隔离缺口，因此仅保留为过程记录，最终采用隔离修复后的 D 轮。

安装前的基线守卫发现默认应用目录已与 Capture 不同，因此拦截了安装流程。追查发现 A6、A7.1、A7.2 三份早期打包测试只设置环境变量，没有传入显式 `--user-data-dir`，Electron 实际使用默认 Roaming。不能把这些运行称为已隔离，也不能用安装后观察掩盖测试造成的本地状态变动。

`af4b1cf` 为三份测试补入绝对用户目录，并在共同启动 helper 中要求恰好一个有效的 `--user-data-dir`，连接主进程后核验实际 `app.getPath('userData')`。C 轮 A7.1 的功能断言已通过，但退出后清理 profile 遇到 Windows 短暂 `EBUSY`，整项退出 1；`qa1-final-c-a7-1.log` 与 C 轮 manifest 保留。`b1f7734` 随后为清理加入受限重试，D 轮重新完整执行。

恢复前先保留测试后的目录副本，再按 Capture 备份恢复原有 57 文件；原文件的长度、SHA-256 与修改时间全部一致。另有两份新增测试缓存被移动到验收备份，没有删除原用户状态。`out/qa/qa1-profile-restoration.json` 记录 `status: restored`、`files: 57`、`bytesHashesTimesMatch: true` 和 `relocatedTestCaches: 2`。验收文档仅记录数量及一致性，不展开最近文件内容或私人路径。

隔离修复后的 D 轮串行 28 套全部退出 0，回执为 `out/qa/qa1-final-d-regression-manifest.json`，测试提交为 `b1f7734`，运行 ASAR 为旧 `24AC…`。测试后默认 profile 的 57 文件仍与基线一致。该轮覆盖三模式、保存、恢复、批注、结构、画布、导出和既有性能功能专项；它没有重做 PERF3 的正式多轮采样，也不能替代后续运行时的完整回归。

## 导出实测失败与当前修复

旧 `0.1.0` 安装包的持续数据流程首次请求 2180×634 PNG，隐藏导出原生窗口被当前屏幕限制，实际图像仅 2050×634。应用的尺寸守卫拒绝保存，原失败保留在 `qa1-install-flow/before-1794475638033.json`，不将其计为 PNG 导出通过。随后以同一旧版本导出 PDF 建立升级前基线，`before-1794476130243.json` 记录 2180×634 PDF 成功，便签与标签、三张卡片几何与箭头均能重开，三文件不变。

`f72101a` 将位图导出改为通过 Chromium 调试协议按精确 DPR 捕获完整导出场景，保留原尺寸与上限守卫。独立探针 `qa1-export-capture-probe.json` 对 2180×634、634×2180、8200×634 和 12000×634 分别比较旧捕获尺寸与新尺寸，并验证最远边角像素；新路径四种尺寸均完整，不受当前屏幕的原生窗口边界裁切。

导出修复阶段生产 ASAR `763C…` 的 `qa1-export-final-a8-3.log` 为 `passed`：PNG、JPG、单页 PDF 均覆盖 8228×1024 完整边界，包含长中文标签、嵌套及视口外内容，并核验源文件不变与 dirty 时冻结导出。最终输入修复包 `8659…` 的同一专项亦在 `qa1-ime-bound-a-a8-3.log` 通过。当前首版仍限制单边 12,000 px、总面积 40 MP，PDF 为单页；这些探针和专项没有扩大导出合同。

## 本机安装、升级与设备边界

本机为 Windows 11 家庭中文版 Build 26200、x64。2026-11-12 Capture 时默认安装、卸载注册项与快捷方式缺失；默认 Roaming 有 57 个文件，备份与基线一致。`out/qa/qa1-install/manifest.json` 冻结安装器、预期 ASAR、应用状态备份、注册项与快捷方式，`captureComplete` 为 true。完成上文恢复后，实际运行旧 `0.1.0` Setup，安装退出 0，卸载注册项及桌面、开始菜单两处快捷方式出现。通过实际桌面快捷方式目标的根启动器启动，主进程报告 `0.1.0`；运行采用显式隔离 profile，默认 Roaming 57 文件仍与基线一致。

旧 `qa1-upgrade-build-manifest.json` 的测试更新源及网络失败恢复记录保留为历史。首个实际使用的更新源从 `f72101a` 独立检出，仅将 package 与 lock 的三个根版本值改为本地测试版本 `0.1.1-qa1`。`qa1-export-upgrade-build-manifest.json` 核验除版本值外源码等价，`npm ci`、版本变更与 make 退出 0，嵌入包版本正确，RELEASES 的包身份、SHA-1 和长度一致。生产版本仍为 `0.1.0`，该测试版本没有公开发布。

本地 `0.1.1-qa1` ASAR 为 4,069,451 字节，SHA-256 为 `EF65D7C729DADE2EBF851E52FD5EFB70E3E7EE9E5E3499B0DA186D83D891456C`；Setup 为 154,837,504 字节，SHA-256 为 `AB9C455F6233B1C5A00505DACAFD55AF92D46D991A424C3077BAE6B41B63FBF1`。版本元数据改变使它与生产 ASAR `763C…` 的哈希不同，结果分别绑定。

实际 updater 从旧 `0.1.0` 安装升级到该 `0.1.1-qa1`，`qa1-install/manifest.json` 的 `upgrade.exitCode` 为 0、`upgrade.verified` 为 true，安装 ASAR 与更新源一致，原 Roaming 57 文件仍匹配。`qa1-default-launch-after.log` 通过桌面快捷方式的根启动器实际启动新目录下的程序，主进程报告 `0.1.1-qa1`。`qa1-installed-flow-after.log` 与 `qa1-install-flow/after-1794476550467.json` 记录升级后重开同一持续数据：便签、标签、三张卡片几何和箭头保持，Markdown、YAML、JSON 的 bytes/mtime 不变，2180×634 PNG 成功。已人工查看该图的最右卡片和长连线完整；旧版本的 PDF 基线与 PNG 失败均继续保留。

上述 `0.1.1-qa1` 通过限定于升级、入口、持续数据和该次导出。旧脚本曾使安装版 UX7 的包体归属错误，测试路径核验修复后，安装版 UX7、UX8 与 `qa-installed.mjs` 的四档 DPR 已在下述 `0.1.2-qa1` 分别验收。强制 DPR 1、1.25、1.5、2 仅用于软件布局验证。历史 A8.6 的卸载与手工处置记录保留，本轮卸载器的实际结果单独列在后文。

最终输入修复从 `cc386b0` 构建本地 `0.1.2-qa1`，仅 package/lock 三个版本值不同，嵌入版本及 RELEASES 的包长和摘要核验通过。回执 `qa1-ime-upgrade-build-manifest.json`，ASAR SHA-256 `45130D4F729256B2778FAAF0CACF5585702DC8BAC8CE3C792F5A8C8A9F406161`；`qa1-ime-renderer-package-comparison.json` 核对生产包与安装包的五个 renderer JS 内容相同。生产版本仍是 `0.1.0`，两个测试版本均未公开发布。

实际 updater 已将 `0.1.1-qa1` 升级到 `0.1.2-qa1`，退出 0，安装 ASAR 和 updater 均匹配更新源。初次升级后检查与另一套窗口回归发生重叠，因仍有测试进程而拒绝标为已核验；原 started/finished 回执及失败保留。全部窗口结束后只读重新核验源包、RELEASES、ASAR、updater、进程和原 profile，通过后另存 `upgrade-0.1.2-qa1-reverified.json`，未再次执行升级器。后续不再并行安装生命周期与窗口测试。

`qa1-default-launch-after-ime.log` 通过真实桌面快捷方式目标的根启动器，核对实际 `0.1.2-qa1` exe、版本与隔离 profile。`qa1-installed-flow-after-ime.log` 对同一持续数据重开，便签、标签、三张卡片及箭头还原，三文件 bytes/mtime 不变，完整 2180×634 PNG 成功。`qa1-installed-ime-ux7.log`、`qa1-installed-ime-ux8.log` 与 `qa1-installed-ime-dpr.log` 均退出 0，执行文件由主进程路径独立核验。四档软件缩放控件无裁切，DPR 不作为物理跨屏证据。

实际最终卸载退出 0，`qa1-lifecycle-uninstall.log` 与 manifest 保留 2 秒及 20 秒检查。20 秒后无 MerMarkd 进程、ASAR、卸载注册项或桌面/开始菜单快捷方式，默认 Roaming 57 文件的长度、摘要、修改时间全部保持基线。安装目录仍有 `.dead`、`Update.exe`、`app-0.1.2-qa1/squirrel.exe` 与 `v8_context_snapshot.bin` 四文件，共 4,541,241 字节；含安装根及子目录共六项。未手工清理这些残留，不把入口卸载成功描述为零残留，也不据此代替干净 Windows 验收。

当前物理设备只有一块 `NE160QDM-NZB` 显示器，Electron 报告缩放 1.25、逻辑边界 2048×1280。用户确认只有当前单屏电脑且无额外干净 Windows 环境。本机带有开发工具和既有应用数据，软件强制 DPR、本机隔离 profile、重新安装与升级都不能替代真实跨屏 DPI 或无开发工具的干净机验收。这两项继续等待外部设备条件。

## 正式性能 A、B 轮与环境范围

当前生产 ASAR `8659…` 的正式 A 轮使用前缀 `qa1-ime-final-perf-a`。最终构建工作树的 `out/qa/qa1-ime-final-perf-a-canvas-manifest.json` 与 `qa1-ime-final-perf-a-loaded-manifest.json` 均为 `complete`，20 份画布流程与 20 份查找/输入流程共 40 份功能完成。对照仍为 PERF3G 基线 ASAR `25427ce0…`，当前包固定为 `86596030…`；1/5 MiB 各五对，原操作与预算沿用既定口径。

功能完成没有通过性能预算。`qa1-ime-final-perf-a-measurements.json` 明确为 `budgetStatus: not-met`，有 44 项超限观察，其中 37 项是正常交互帧间隔超过 100 ms，7 项是实际输入到就绪超过对应预算。这是 44 项指标观察，不能描述为 44 份样本。5 MiB 第五次首次打开的交互帧间隔为 558 ms，重复打开为 546 ms；查找/输入组第一轮返回阅读为 659 ms、交互帧间隔为 550 ms。A 轮全部样本、原始帧窗口、汇总及失败状态保留，不删除、不作废，也不由后续采样覆盖。

正式组完成后，以同一包的新空白进程读取实际辅助功能状态。`out/qa/qa1-accessibility-after-native.json` 报告 `features: [nativeAPIs, webContents, extendedProperties]`，当时 `app.accessibilitySupportEnabled` 为 false，说明仅记录这个布尔值不足以描述实际 features。随后通过官方 `node_repl` 会话重置结束本次自动化的 Sky 客户端，再启动新空白进程，`qa1-accessibility-after-reset.json` 报告 features 仅为 `[nativeAPIs]`，布尔值仍为 false。全程未关闭或强制禁用产品、系统辅助功能。

在这一会话重置后，同一 `8659…` ASAR 的单次 5 MiB 复核 `qa1-ime-ax-reset-5m.json` 保持 200 标题、200 张卡片、500 高亮，`hideGrid` 与 `profile` 均为 false。首次打开、重复打开、返回阅读的正常交互帧间隔分别为 75、50、50 ms；进入 200 卡片的实际输入到就绪为 246 ms。该次观察恢复相应预算，只是一份环境复核，不是正式五轮退出结果。

A 轮当时没有为每份样本记录实际 features，不能追溯断言每一份都处于增强状态，也不能据上述前后变化证明每个慢帧的根因。现有证据支持环境状态与性能变化的相关性；辅助功能增强路径下的大文档性能仍列为未解决，正式 A 轮的预算失败继续有效。

正式 B 轮使用独立前缀 `qa1-ime-final-perf-b`，按画布组、查找/输入组、汇总顺序串行完成 40 份。两个 manifest 均为 `complete`、每份功能退出 0；报告退出 0，`qa1-ime-final-perf-b-measurements.json` 为 `met-for-recorded-actions`，`failures` 为空。产品 ASAR 仍为 `8659…`，测试元数据提交 `4a2d4b0` 只在计时操作前后读取环境，没有改变动作、计时区间或预算。完整逐次值、A/B 统计、环境及探针证据汇集于 [QA1_PERF_METRICS.json](QA1_PERF_METRICS.json)。首次打开指新应用进程与隔离 profile，不等于清空操作系统文件缓存。

逐份核对 40 份结果中的前后环境，共 80 个快照，无缺失：全部 features 为 `[nativeAPIs]`、240 Hz、可见且未最小化，`accessibilitySupportEnabled` 均为 false。79 个快照报告聚焦；查找/输入组 `loaded-after-1m-1` 的终末快照报告失焦。前后点采样不能证明整个动作期间的焦点或 AX 状态始终不变，也不能将这些结果扩大到 `webContents`、`extendedProperties` 增强路径。

下表均为当前 `8659…` 包 B 轮的五次结果，单位 ms。「实际」为实际输入到完整就绪后一绘制帧；自动化列另外包含 CDP 与动作准备。画布组返回阅读与查找/输入组编辑、撤销后的返回是不同操作。

| 文档 / 流程 | 自动化中位数 | 实际中位数 | 实际最差 | 正常交互帧间隔最差 |
| --- | ---: | ---: | ---: | ---: |
| 1 MiB 首次打开 | 1149 | 1100 | 1113 | 54 |
| 1 MiB 重复打开 | 1171 | 1098 | 1150 | 50 |
| 1 MiB 进入 200 卡片 | 294 | 248 | 252 | 54 |
| 1 MiB 画布返回阅读 | 97 | 44 | 45 | 46 |
| 5 MiB 首次打开 | 2047 | 1999 | 2073 | 75 |
| 5 MiB 重复打开 | 1948 | 1935 | 1955 | 54 |
| 5 MiB 进入 200 卡片 | 340 | 246 | 255 | 54 |
| 5 MiB 画布返回阅读 | 96 | 47 | 87 | 46 |
| 1 MiB 编辑、撤销后返回阅读 | 203 | 97 | 100 | 50 |
| 5 MiB 编辑、撤销后返回阅读 | 255 | 96 | 155 | 54 |

B 轮通过只适用于上述普通 40 份在实际记录环境中的动作，正式 A 轮的 44 项超限继续有效，辅助功能增强路径下的大文档性能仍未解决。后续 pending 与内存分别记录，不能把普通 40 份的预算结论扩展到全部专项；历史 PERF3 AU2 继续仅作基线。

## 后续 pending 与内存专项

`qa1-ime-final-perf-b-pending-manifest.json` 保留了前四次完整通过和第五次退出 1，整轮没有完成标记。第五次先完成 Worker 尚未回复时切源码，日志记录 `pending-source` 自动化壁钟 36 ms；其后第一次画布拖动将 `card-0` 移出画面，第二次拖动前的命中断言得到 `undefined`，预期为 `card-0`，整项失败。`qa1-ime-final-perf-b-pending-5m-5.log` 的时序和几何诊断保留，不能把 pending 步骤自身完成写为整项通过。该单次拖动异常的原因尚未定位。

保持同一产品与脚本，使用独立前缀 `qa1-ime-final-probes-c` 重新完整执行五次，`qa1-ime-final-probes-c-pending-manifest.json` 为 `complete`，五项均退出 0，脚本 SHA-256 与前一尝试一致。实际输入到源码就绪分别为 7、7、7、7、9 ms，交互帧间隔分别为 8、8、13、8、8 ms；自动化壁钟分别为 34、37、41、42、30 ms。五次都完成后续卡片操作、三次拖动及返回阅读。10 个前后环境快照均为 `[nativeAPIs]`、240 Hz、聚焦、可见且未最小化。C 轮是独立复测，未删除、替换或解释掉 B 的未完成尝试与拖动异常。

独立 GC/应用进程内存四组已串行完成，`qa1-ime-final-probes-c-memory-manifest.json` 为 `complete`，旧包/当前包的 1/5 MiB 四项均退出 0。每组完成三轮卡片与阅读切换、显式 GC 后 renderer 堆及 Browser/GPU/Utility/Tab 应用进程点采样。8 个前后环境快照均为 `[nativeAPIs]`、240 Hz、聚焦、可见且未最小化。以下单位均为 MiB，原始逐进程数值及每次采样见 [QA1_PERF_METRICS.json](QA1_PERF_METRICS.json)。

| 文档 / 版本 | 卡片 renderer 堆 1→2→3 | 阅读 renderer 堆 1→2→3 |
| --- | ---: | ---: |
| 1 MiB 旧包 | 29.5 → 24.8 → 24.9 | 19.0 → 19.0 → 19.1 |
| 1 MiB 当前包 | 28.1 → 25.8 → 25.9 | 23.1 → 23.2 → 23.3 |
| 5 MiB 旧包 | 77.6 → 64.8 → 64.9 | 51.0 → 51.0 → 51.2 |
| 5 MiB 当前包 | 68.2 → 66.0 → 66.1 | 63.3 → 63.4 → 63.5 |

全应用进程另行求和，不把 renderer 堆当作应用总内存。下表「卡片 / 阅读」均为第三轮点采样；「采样最高」是六个 GC 后采样点中的最高合计，不是全程连续监测峰值。

| 文档 / 版本 | 工作集合计，卡片 / 阅读 | Private 合计，卡片 / 阅读 | 工作集 / Private 采样最高 |
| --- | ---: | ---: | ---: |
| 1 MiB 旧包 | 671.1 / 656.8 | 548.2 / 537.5 | 671.1 / 584.5 |
| 1 MiB 当前包 | 668.2 / 660.9 | 619.7 / 611.8 | 687.2 / 637.5 |
| 5 MiB 旧包 | 908.8 / 993.1 | 794.6 / 878.5 | 993.1 / 878.5 |
| 5 MiB 当前包 | 910.5 / 908.7 | 850.5 / 848.6 | 970.8 / 913.0 |

本次当前包末两轮卡片堆接近，阅读堆三轮各有约 0.1 MiB 增量；5 MiB 末轮阅读堆 63.5 MiB，高于旧包的 51.2 MiB。应用进程工作集与 Private 的比较并非全面下降，例如 1 MiB 末轮阅读 Private 为 611.8 MiB，对照为 537.5 MiB。四组采样完成不等于证明长期无泄漏；显式 GC、有限轮次及离散进程点采样的范围保留，不由 renderer 堆或某一项较低值推定全部内存风险已消除。

## 收口所需的具体证据

1. **组合输入修复与确定回归：本机通过。** `cc386b0` 的旧实现失败/新实现通过、源码与正文组合、撤销光标、重做、取消、跨模式和保存保护已有确定及实际 WeType 回执。保留旧失败及执行文件归属更正，不由工程插入中文替代物理输入。
2. **同源构建及完整窗口：本机通过。** `8659…` 包完成干净检出的 `npm ci`、类型检查、319 项单测、make、28 套窗口及实际 Vite UX7/UX8；`5b4093f` 记录实际执行文件身份，性能元数据 `4a2d4b0` 不改变产品包。
3. **最终包正式性能：本机记录范围完成，仍有未解决项。** A 轮保留 44 项超限；B 普通 40 份在记录的 `nativeAPIs` 环境中满足所测动作预算，含一个终末失焦快照；C pending 五次完整通过、内存四组采样完成。B pending 的单次拖动异常、增强 AX 性能、内存退化及有限采样范围全部保留，不由重采宣布风险消除。
4. **实际安装版：本机通过。** 两次真实升级、根启动器与版本、最终安装版 UX7/UX8/四档软件 DPR、持续数据和完整导出已核验；原默认 profile 57 文件保持基线。
5. **本轮真实卸载：入口清除，有残留。** 退出码、进程、注册项、两处快捷方式、安装目录及默认 profile 已记录；保留四个文件共 4,541,241 字节，未手工清理，不宣称零残留。
6. **外部设备与发布边界。** 真实跨屏 DPI 与无开发工具的干净 Windows 安装、打开、保存、导出及卸载仍需相应设备。软件 DPR、隔离目录或本机升级不替代它们；公开发布的签名、许可证清单与渠道另行验收。

本轮已完成上述本机软件、原生输入、安装生命周期及记录环境下的性能与专项采样。第 3 项仍保留 A 轮预算失败、增强 AX 路径、单次拖动异常、终末失焦快照及内存观察限制；第 5 项保留卸载残留，第 6 项设备与发布门槛未完成。因此 QA1 与 P0 不作整体退出结论。
