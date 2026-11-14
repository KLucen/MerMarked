# QA2：保存布局恢复与增强无障碍路径诊断

> 2026-11-14 更新，本批于 2026-11-13 开始。布局恢复修复的本地退出条件已通过；增强特性对照和独立 trace 已完成，真实辅助客户端性能仍未解决。基于已合并 [PR #20](https://github.com/KLucen/MerMarked/pull/20) 的 main `2e6a04f3f99b0dfe8c94700aa5aa6726576902cc`，分支 `codex/qa2-layout-recovery`；实现提交 `def66de5303b00a1c4d527054df7f70450fbc834`。全部逐次数据见 [QA2_EVIDENCE.json](QA2_EVIDENCE.json)，交付状态以 [开发进度](PROGRESS.md) 和开发日志为准。

本批处理一个已经从源码确认、可独立复现的布局恢复缺陷，并为增强无障碍特性下的大文档长帧建立受控诊断。两部分的证据分别记录。QA1 的原始失败、环境限制及未完成项继续保留在 [QA1 验收](QA1_ACCEPTANCE.md)，本批不能自动解除这些限制。

## 问题与本批边界

旧版 CanvasView 以「已绑定卡片全部位于原点」或「任一根卡片靠近左上角」推断布局没有初始化。即使画布 sidecar 有效、源版本及章节身份匹配，合法的 `(0,0)`、重叠位置或负坐标也可能触发整图自动整理，导致重开后的实际画面偏离已保存布局。

本批候选改动移除这两项坐标启发式。已保存坐标本身不表示缺少初始化。缺失布局、出现新卡片，以及源码变化后存在未匹配身份时的现有处理继续保留；用户显式「自动整理」仍是独立操作。本批不新增 schema、preload 接口或持久化字段，不修改 Markdown 章节树与源文本。

同一专项还复现了相邻的初始化等待缺陷：旧版等待全部绑定卡片上报实际高度，但折叠后隐藏的子卡不会挂载，因而可永久停留在布局准备状态。候选实现只等待 scene 中全部非 hidden 卡片的实际尺寸；仍须等本次可见卡片全部完成测量，不提前开放尚未完成的可见批次，也不为了测量而展开隐藏子卡。

QA1 中一次拖动把 `card-0` 保存到异常远处的事件，与本批的重开布局误判是两个问题。前者尚缺逐事件坐标、transform 与 auto-pan 等证据；不能因为本批布局恢复通过，就宣布原始拖动大跳已经定位或修复。

## 布局恢复验收

以下候选包专项结果已经实际执行，旧包对照结果另列。只读流程比较 `.md`、`.annotations.yaml` 与 `.mermarkd.json` 的精确 bytes、摘要、mtime，以及原先缺失状态；实际画面还独立核对卡片世界坐标，不能仅凭磁盘 JSON 未变或节点数量相同判断恢复正确。源编辑、dirty、冲突和恢复等更广回归的实际覆盖见后文原日志对照。

| 场景 | 必须核验的结果 | 当前状态 |
| --- | --- | --- |
| 有效 v1 sidecar，单卡原点 | 打开、切模式、重开后实际位置保持；不触发隐式整理，三文件不变 | 专项通过 |
| 有效 v2 sidecar，单卡原点 | 位置、合法自定义尺寸及正文显示偏好保持，三文件不变 | 专项通过 |
| 有效 v1/v2 sidecar，多卡原点或重叠 | 保留有意重叠及卡片身份，不以重叠猜测初始化状态 | 专项通过 |
| 有效 v1/v2 sidecar，根卡片负坐标 | 保留合法世界坐标，父子关系和子卡相对坐标不变 | 专项通过 |
| 已保存且有效的视口 | 恢复保存的平移与缩放；不以自动适应全图替换该视口 | 专项通过 |
| 已保存视口不再覆盖卡片 | 允许现有提示和临时定位，但卡片世界坐标、磁盘视口及三文件不被改写 | 专项通过 |
| 箭头、折叠与尺寸 | 端点 ID、标签、折叠状态与合法尺寸保持，隐藏子卡仍按原模型恢复 | 专项通过 |
| 没有画布 sidecar 的首次打开 | 仍能生成可用临时布局；普通打开不创建或写入内容文件 | 专项通过 |
| 新增章节初始化 | 新章节仍触发初始化，三文件不变 | 专项通过 |
| 源变化后的身份安全 | 既有保守匹配路径保留；受测结构变更保持卡片 ID 与箭头，批注安全映射或保留未解析，不静默改接 | 受测回归通过；具体覆盖见后文 |
| 已折叠父卡同时新增章节 | 新章节正常整理，全部可见卡片测量后就绪；隐藏子卡继续折叠，隐藏端点继续投影到可见祖先，三文件不变 | 专项通过 |
| 用户显式自动整理 | 命令仍可改变布局，Markdown/YAML 不变；模型内容、折叠、尺寸、链接及源版本保持，保存结果重开稳定 | 专项通过；相关冲突/恢复回归通过 |
| dirty、冲突及恢复状态 | 既有写入冻结和恢复门槛不被布局恢复绕过 | 受测回归通过；具体覆盖见后文 |

旧包失败和候选包通过应分别绑定真实执行文件、ASAR 与测试脚本。旧版预期失败用于证明缺陷，不计入新版通过数；失败日志保留，不靠放宽几何或文件断言让测试通过。

专项脚本为 `tests/e2e/qa2-layout-recovery-packaged.mjs`，SHA-256 `fdb4329592deeb5b41c2d3f237dbc2886069d6b74e76b0d4c5718f4aeb6fd7da`。最终旧版对照使用 QA1 最终包 `C:/Users/KLucen/.codex/worktrees/mermarkd-qa1-ime-final/out/MerMarkd-win32-x64/MerMarkd.exe`，ASAR SHA-256 `86596030fa1e4b1b40deeb02fbf50384145e459bb35e4a398eabbb695e938033`；记录保存在 `out/qa/qa2-layout-old-red-c.json` 与同名 `.log`，共 11 项，2 项通过、9 项失败：

| 旧包场景 | 实际结果 | 证据含义 |
| --- | --- | --- |
| v1/v2 单卡原点、全部原点重叠，共 4 项 | 失败：实际坐标或尺寸被重排 | 已保存有效布局被坐标启发式误判 |
| v1/v2 负坐标且有折叠、失效视口临时定位、折叠父卡新增章节、显式整理，共 5 项 | 失败：等待可测量且可写画布超时 | 折叠隐藏子卡参与初始化测量等待，阻止后续场景完成；这些失败不能证明后续保存断言已被执行 |
| 缺失 sidecar 首次初始化、无折叠的新增章节，共 2 项 | 通过 | 证明旧版仍有可用的初始化路径；缺失 sidecar 案例还验证了显式保存仅创建 canvas JSON |

候选最终 ASAR 的专项已全部通过，报告为 `C:/Users/KLucen/.codex/worktrees/mermarkd-qa2-final/out/qa/qa2-bound-a-qa2.json`，执行时间为 `2026-11-13T15:39:36.151Z` 至 `15:39:58.620Z`。11 项包括 v1/v2 单卡、原点重叠、负坐标六项，以及失效视口临时定位、缺失 sidecar、新章节、折叠父卡新增章节、显式自动整理五项。前六项同时通过打开、模式往返、独立进程重开后的几何与三文件核验；失效视口保留世界坐标和磁盘内容，仅临时适应全图；显式整理结果保存并稳定重开。

候选报告绑定的脚本 SHA-256 为 `0bfade25a69299028216ac1a26d0f37382ba8a025b9475ca72c4b22dd3919512`，与旧包对照主工作区脚本的字节摘要不同。只读比较确认，两份脚本将 CRLF 归一化为 LF 后文本完全一致；主工作区为 18,289 bytes、干净 checkout 为 18,518 bytes，差异仅为 229 行换行。脚本断言没有为候选放宽，两个实际摘要分别保留。旧包负坐标等超时与原始拖动大跳没有同一根因的结论。

## 候选构建身份

干净 detached worktree `C:/Users/KLucen/.codex/worktrees/mermarkd-qa2-final` 从 `def66de5303b00a1c4d527054df7f70450fbc834` 构建；`out/qa/qa2-final-build-manifest.json` 已记录 `npm.cmd ci`、`npm.cmd run typecheck`、`npm.cmd test`（319/319，0 失败）和 `npm.cmd run make` 全部通过。前后源码状态均干净，lockfile 摘要不变；主工作区索引及既有 QA1 validation 冻结产物均未被构建改变。

候选可执行文件为 `C:/Users/KLucen/.codex/worktrees/mermarkd-qa2-final/out/MerMarkd-win32-x64/MerMarkd.exe`，其 `resources/app.asar` 为 4,069,561 bytes，SHA-256 `5ac8b1a5646d11fcc947d613ec9bd967358baf3b28751405f094ae68a9130af6`，与上述 11/11 窗口专项报告一致。构建通过仅证明安装依赖、静态检查、单测与制品生成；专项结果也不能替代其余窗口回归、安装生命周期或原生导出验收。

## 同包 30 套回归

`out/qa/qa2-bound-a-regression-manifest.json` 已记录全部 30 套命令退出码为 0，整体 `status: passed`。记录绑定同一实现提交 `def66de5303b00a1c4d527054df7f70450fbc834`、同一干净 worktree 及上述 `5ac8…` ASAR；执行时间 `2026-11-13T15:39:35.367655Z` 至 `2026-11-13T15:43:02.5924983Z` 为原报告的 UTC 时间。每套实际命令均为 `npm run test:e2e:<名称>`，对应原日志 `out/qa/qa2-bound-a-<名称>.log` 的路径与 SHA-256 保存在 manifest。

通过的 30 套名称为 `qa2`、`source-composition`、`ux8`、`ux7`、`ux6b`、`a6`、`a7-1`、`a7-2`、`a7-3b`、`a7-4`、`a7-5`、`a8-2`、`a8-3`、`a8-4`、`a8-5`、`b1`、`ux1`、`ux2`、`ux3`、`ux4`、`ux5`、`perf1`、`ux6a`、`perf2`、`perf3a`、`perf3b`、`perf3c`、`perf3d`、`perf3e`、`perf3g`。此处的「30 套」是这份 manifest 所列范围，不表示真实设备、安装生命周期和全部性能退出条件均已通过。

| 相邻门槛 | 本次原日志对照 | 实际通过范围 |
| --- | --- | --- |
| 源文本、版本与身份 | `qa2-bound-a-a7-3b.log`、`qa2-bound-a-a7-4.log`、`qa2-bound-a-a7-5.log`、`qa2-bound-a-a8-4.log`、`qa2-bound-a-perf3c.log` | BOM/CRLF 精确保留、干净切模式零写入；批注 3 项映射、1 项保持未解析并重启核验；结构预览 stale 门槛、卡片 ID/箭头保持、拒绝后的草稿恢复和有序源版本保存 |
| dirty 写入冻结 | `qa2-bound-a-a7-3b.log`、`qa2-bound-a-a7-4.log`、`qa2-bound-a-a7-5.log`、`qa2-bound-a-a8-2.log`、`qa2-bound-a-a8-3.log`、`qa2-bound-a-a8-4.log` | dirty 预览不写 sidecar；renderer 与主进程画布 guard、批注冻结、结构变更待保存期间冻结，以及 dirty 导出冻结 |
| 外部冲突与草稿 | `qa2-bound-a-a7-3b.log`、`qa2-bound-a-a8-5.log`、`qa2-bound-a-ux1.log`、`qa2-bound-a-ux3.log`、`qa2-bound-a-ux6b.log` | 外部变化保留，画布冲突不覆盖，保存冲突保留草稿与三文件，冲突后重试打开及关闭窗口保护 |
| 事务恢复与异步失效 | `qa2-bound-a-a8-5.log`、`qa2-bound-a-ux6a.log`、`qa2-bound-a-ux6b.log`、`qa2-bound-a-perf3g.log` | 缺失源文件/部分 YAML 恢复、取消零写入、待恢复写入冻结、活动锁、历史回执、live failure 冻结、dirty 自有事务恢复、恢复模态快捷键隔离，以及文档/dirty 变化后的 worker 取消与过期回复 |

A7-4 的「未解析」是批注锚点；A8-4 验证的是已匹配卡片身份随显式结构变更保持。不能据此扩大为所有源码变化下未匹配卡片或歧义章节都已逐一覆盖。本批新专项直接验证的是有效布局恢复及新增章节初始化，原有保守匹配分支继续保留。

2026-11-14 复核主工作区三项原有用户修改的 SHA-256 仍分别为：`src/renderer/index-3b82dd4d61e8.html` 的 `9EA97C911A3482916CD4FF4DE75BE500AC42F9B6E907D1C4D5F0FFD250C49196`、`tests/fixtures/reader/mixed-layout.md` 的 `C5D4F6F798E11A3550DDD494F020413020B8FDE27FEA89E46146BE1C909AEAD1`、其 `.mermarkd.json` 的 `D62CAA49B9B81B665DCF636CC620E8A1D5229EE9E30A1A2A86D88CCE0EEF691F`，与本批开始时保护值一致；提交和上传仍须排除这三项用户修改。

## Vite 验证与测试服务停止

`out/qa/qa2-final-vite-manifest.json` 的 `status: passed`，记录在同一干净 worktree、实现提交和 `5ac8…` 包体身份下，`npm run test:e2e:qa2` 与 `npm run test:e2e:ux8` 均退出 0。QA2 的 `C:/Users/KLucen/.codex/worktrees/mermarkd-qa2-final/out/qa/qa2-final-vite-qa2.json` 为 11/11 通过，并绑定脚本摘要 `0bfade25…`。UX8 通过结构化预览/完整正文、源码顺序搜索、折叠定位零写入、显式展开仅写 canvas、几何与端点保持、精确阅读定位和窄窗等断言。两份日志 `out/qa/qa2-final-vite-qa2.log`、`out/qa/qa2-final-vite-ux8.log` 的实际摘要均与 manifest 相符；该轮记录时间为 `2026-11-14T03:16:53.6323324Z` 至 `03:17:45.5092793Z`。

原 manifest 的 `serverStopped: false` 继续原样保留：nvm shim 父进程停止后，实际 Vite node 子进程仍监听，不能将测试通过等同于服务已停止。随后核验测试自有子进程 `37752`、父进程 `29792` 和精确的 `vite.renderer.config.mjs --host 127.0.0.1 --port 5178 --strictPort --force` 命令后，清理该测试进程树。独立回执 `out/qa/qa2-final-vite-stop.json` 于 `2026-11-14T03:18:27.3901702Z` 记录 `portListening: 0`、`childPresent: false`，作为实际停止证据，不回写覆盖原 manifest 的停止状态字段。

## 增强无障碍特性的受控诊断

QA1 在原生检查客户端连接后观察到额外的 `webContents`、`extendedProperties`，结束该客户端后新进程仅报告 `nativeAPIs`。环境变化与大文档长帧具有相关性，但 QA1 A 轮没有逐样本 features，尚不能证明每个慢帧的具体原因；A 轮 44 项超预算观察继续有效。

本批在隔离测试进程中，通过 Electron 的公开 API 仅添加已观察到的 `webContents` 和 `extendedProperties`，保留该进程既有特性。普通路径不调用 setter，不关闭产品或系统辅助功能，不以 `accessibilitySupportEnabled` 单一布尔值替代实际 features，也不通过开启另一组更强特性冒充原观察条件。启用发生在计时前，诊断不包含该 API 调用本身的耗时。

| 诊断门槛 | 记录要求 | 当前状态 |
| --- | --- | --- |
| 同包对照 | default/observed 各五份 5 MiB 样本交替运行，全部绑定同一 ASAR 与明确脚本摘要 | 完成，10/10 功能通过 |
| 特性设置边界 | 保存添加前、请求值及添加后的实际集合，证明既有特性没有被移除 | 五对形成预期差异，前后稳定 |
| 实际环境 | 每份计时前后记录 AX features、窗口焦点、可见/最小化和刷新率；不从角色标签推断环境 | 20 快照均聚焦、可见、未最小化、240 Hz |
| 功能完整性 | 200 标题、200 张实际可见卡片、500 高亮及三文件边界继续核验 | 全部通过 |
| 普通采样 | 不带 CPU profiler、trace 或强制 GC；动作与原计时预算保持，超限如实记录 | 十份所测动作无预算超限，原始 null 保留 |
| 单次 trace | 与普通对照分开执行，先发现可用类别，再记录相关渲染/AX 工作 | 完成，实际发现 accessibility 类别，七份 profile/trace 产物摘要已绑定 |
| 结果解释 | 区分可重复特性差异、具体长任务归因与尚未证明的推断；对照失败同样保留 | 未复现 QA1 严重长帧，不作真实客户端问题已修复结论 |

若 default 进程也被外部客户端激活额外特性，或两组实际集合没有形成预期差异，结果需按真实集合说明，不能仅按 default/observed 命名声称建立受控差异。测试进程的添加特性诊断也不等同于真实屏幕阅读器兼容性验收。

协调器为 `tests/e2e/qa2-accessibility-observed-packaged.mjs`。在干净 worktree 指定绝对 `MERMARKD_QA_EXE` 与 `MERMARKD_QA_BUILD_MANIFEST` 后，分别执行 `node tests/e2e/qa2-accessibility-observed-packaged.mjs timings qa2-ax-a`、`node tests/e2e/qa2-accessibility-observed-packaged.mjs trace qa2-ax-trace-a`，均退出 0。原始 manifest 位于该 worktree 的 `out/qa/qa2-ax-a-timings-manifest.json` 与 `out/qa/qa2-ax-trace-a-trace-manifest.json`；[提交证据](QA2_EVIDENCE.json)保留全部十份 measurements、环境、配置、预算检查，以及独立 trace 的身份摘要。

普通组始终只有 `nativeAPIs`；observed 组始终为 `nativeAPIs/webContents/extendedProperties`，`accessibilitySupportEnabled` 均为 false。十份计时前后快照构成稳定特性对照，但不能证明任意时刻的焦点或屏幕阅读器行为。新进程和隔离 profile 不等于清空操作系统文件缓存。

下表单位 ms，实际就绪指 `inputToReadyPaintMs`，包含自动化等待的打开耗时另用 `elapsedMs` 标出。仅描述每组五次样本，不做显著性或长期可靠性推断。

| 动作 / 口径 | default 中位数 | observed 中位数 | default 最差 | observed 最差 |
| --- | ---: | ---: | ---: | ---: |
| 首次阅读打开，自动化 elapsed | 2039 | 2099 | 2085 | 2118 |
| 重复阅读打开，自动化 elapsed | 2024 | 2190 | 2049 | 2202 |
| 切 200 张卡片，实际就绪 | 246 | 260 | 248 | 261 |
| 卡片查找，实际就绪 | 146 | 184 | 187 | 190 |
| 返回阅读，实际就绪 | 82 | 87 | 86 | 144 |

上述全部动作的互动帧间隔按原 100 ms 门槛检查；不把 `maxFrameGapMs` 与稍后读取的 `interactionMaxFrameGapMs` 强制当作同一截面。`annotations-ready` 与三次拖动没有 ready 字段属于原测量合同，证据保留 null，不能据过滤后的摘要宣称未测字段也通过。单次 profiling 不参与普通预算，trace 只覆盖首次打开、卡片与返回阅读，不覆盖重复打开；renderer 的 performance 时钟与 trace 时钟没有同步 marker，不能直接用时间数字将不同运行的帧间隔对齐。

本批没有产品级 AX 性能优化。五对结果只证明仅添加这两项特性没有在本次样本复现 QA1 的严重长帧；QA1 A 轮失败保留，真实原生客户端连接与实际 AX 查询仍需可重复验收。

离线工具 `tests/e2e/qa2-accessibility-analysis.mjs` 校验十份结果、十份起始证据及七份 profile/trace 的实际摘要，重算预算和字段覆盖；结果见 [QA2_AX_ANALYSIS.json](QA2_AX_ANALYSIS.json)。100 个动作中 ready 为 60 个数值、40 个预期 null，feedback 为十个打开数值及 90 个缺省字段，均没有用缺字段补零。其他五个常用数值指标各 100 个有限值。原始计时、逐帧停顿和不一致截面均保留。

独立 trace 确实记录原生 AX 工作：首次打开时，Renderer / CrRendererMain 的 `SerializeLifecycleStage` 为 65.285 ms；Browser / CrBrowserMain 的 `HandleAXEvents` 为 66.169 ms，其内部 `OnAccessibilityEvents` 为 65.148 ms，嵌套事件不能相加。返回阅读时对应两个主线程事件为 52.368 / 70.358 ms。卡片阶段有 toplevel：渲染主线程最长 `RunTask` 34.519 ms，其中实际 AX 区间交叠 10.331 ms；浏览器 20.084 ms 任务中的 `HandleAXEvents` 为 19.771 ms。这些事件证明 AX 处理具有实际成本，不能据此证明某个普通样本帧停顿的原因。

open/return trace 没有采 toplevel 类别，不能声称完整外层长任务已定位。DedicatedWorker 的 `HandlePostMessage` 1056.113 ms / `FunctionCall` 974.804 ms 属于 Worker 线程，不是 UI 主线程长帧；本次两个主线程 trace 未见 500 ms 事件，也不能覆盖未记录类别。CPU profile 的 `(program)` 不解析原生调用栈，返回阶段的 `removeAttribute` 自身采样 25.685 ms 仅为线索，不证明修改该处即可解决真实客户端问题。

后续按独立切片推进：先在实际原生辅助客户端连接和查询期间记录同包特性、请求、完整主线程任务与同步标记，再决定阅读树分批暴露或编辑宿主策略；原拖动大跳另补逐事件指针/transform/auto-pan/保存模型记录。卸载残留需先明确并验证支持范围，不凭手工删除宣称生命周期退出。硬件与公开发布条件继续单独验收。

## 本批退出条件与证据状态

| 项目 | 当前状态 | 完成所需证据 |
| --- | --- | --- |
| 旧版布局缺陷复现 | 已完成 | 最终同脚本 11 项：2 通过、9 失败；坐标重排与折叠测量超时分别记录，旧 ASAR 和脚本摘要已绑定 |
| 候选布局恢复专项 | 通过，11/11 | 最终 ASAR 的 qa2-bound-a-qa2.json 已绑定脚本、包体和各场景结果；三文件、实际坐标、视口及保留状态断言通过 |
| 干净构建与单测 | 已完成 | ci、typecheck、319/319 tests、make 均通过；源、lockfile、包体身份及冻结产物保护见构建 manifest |
| 同包 30 套回归 | 通过，30/30 | qa2-bound-a-regression-manifest.json 绑定同提交/ASAR、逐套 exit 0 及原日志摘要；相邻数据安全门槛按实际覆盖记录 |
| Vite 验证与服务停止 | 通过 | QA2 11/11 与 UX8 均 exit 0；原 manifest 保留 serverStopped false，独立 stop 回执确认测试子进程和 5178 监听均已退出 |
| AX 受控诊断 | 完成，非真实客户端验收 | 同包十份对照所测预算内，五对特性差异成立；独立 trace 不计普通预算，原始数据与未复现限制保留 |
| 工作区与交付 | 待收尾 | 原三项用户修改保持并排除提交，更新实际命令、失败、下一步及 GitHub 状态 |

本批布局恢复通过只能说明该切片的已测范围。增强 AX 大文档性能、QA1 原始拖动异常、内存观察限制和卸载残留在取得各自证据前继续未解决。用户目前只有当前单屏电脑，真实跨屏 DPI 和无开发工具的干净 Windows 验收仍等待设备；许可、签名和发布渠道另验。QA1 与 P0 不据本批实施或诊断直接标为整体完成。
