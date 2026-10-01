---
title: FindProbe frontmatter must stay hidden
extensionSamples: "$$ [[frontmatter]] :::note"
---

# FindProbe 章节

FindProbe 正文第一处，包含 *强调*、**加粗**、[安全链接](https://example.com) 与 `行内代码`。

转义后的 \*星号\* 与实体 &amp; 保留为可读文字。
软换行的第一行
仍属于同一段落；这里使用硬换行。  
下一行前应有换行元素。

Cross<strong>Inline</strong>Probe 可跨内联节点查找。

NoCross  
Boundary 不得跨越可见换行查找。

Setext 二级标题
----------------

> CommonMark 引用内容。

1. 有序列表
2. 第二项

- 无序列表
- [x] 已完成任务
  - 嵌套任务内容

[引用链接][dialect-reference] 与 ![引用图片替代文字][dialect-image]。

[dialect-reference]: https://example.net/reference "引用标题"
[dialect-image]: missing-dialect-image.png

~~GFM 删除线~~，以及自动链接 https://example.org/path 。

| 中文列 | English |
| --- | ---: |
| 全角ＡＢＣ | value |

---

```txt
const mixedWidthProbe = "中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３中文ABC１２３";
$$
[[code-only]]
:::inside-code
```

    indentedCodeProbe = "缩进代码仍是代码";

<mark id="attacker-id" class="attacker-class" style="position:fixed" onclick="globalThis.__MER_RAW_EVENT__=true" aria-label="spoofed" title="保留标题">FINDPROBE 允许 HTML 文字</mark>

<a href="javascript:globalThis.__MER_BAD_LINK__=true" target="_blank">已净化链接</a>

<span class="html-placeholder" role="note">A72_RESERVED_PLACEHOLDER_CLASS_VISIBLE</span>

<h2>允许的 HTML 标题</h2>

<details>
<summary>折叠内容</summary>
findprobe 此处默认不可见，不应进入查找结果。
</details>

<video src="__MERMRKD_SENTINEL_ORIGIN__/video"><source src="__MERMRKD_SENTINEL_ORIGIN__/source">A72_DANGER_VIDEO_7F1C findprobe</video>

<video src="__MERMRKD_SENTINEL_ORIGIN__/foster-video">
<table>A72_FOSTER_VIDEO_TABLE_TEXT_6C21<tr><td>A72_FOSTER_VIDEO_CELL_TEXT_9B4E</td></tr></table>
<img src="__MERMRKD_SENTINEL_ORIGIN__/foster-video-image" alt="A72_FOSTER_VIDEO_IMG_ALT_31AF">
</video>

<audio src="__MERMRKD_SENTINEL_ORIGIN__/foster-audio">
<table>A72_FOSTER_AUDIO_TABLE_TEXT_D502<tr><td>A72_FOSTER_AUDIO_CELL_TEXT_74CB</td></tr></table>
<img src="__MERMRKD_SENTINEL_ORIGIN__/foster-audio-image" alt="A72_FOSTER_AUDIO_IMG_ALT_A83D">
</audio>

<iframe src="__MERMRKD_SENTINEL_ORIGIN__/frame">A72_DANGER_IFRAME_82D9 findprobe</iframe>

<object data="__MERMRKD_SENTINEL_ORIGIN__/object">A72_DANGER_OBJECT_1BC4 findprobe</object>

<script>globalThis.__MER_RAW_SCRIPT__ = true; fetch('__MERMRKD_SENTINEL_ORIGIN__/script-fetch'); 'A72_DANGER_SCRIPT_C930 findprobe';</script>

<style>body::before { content: "A72_DANGER_STYLE_E27A findprobe"; }</style>

<svg><text>A72_DANGER_SVG_5AD6 findprobe</text></svg>

<section>
<table>A72_UNSUPPORTED_SECTION_4E6B<tr><td>A72_UNSUPPORTED_CELL_0D73</td></tr></table>
<img src="__MERMRKD_SENTINEL_ORIGIN__/unsupported-image" alt="A72_UNSUPPORTED_IMG_ALT_6E14">
</section>

$$
扩展数学内容
$$

[[Wiki Target]]

:::note

结尾正文。
