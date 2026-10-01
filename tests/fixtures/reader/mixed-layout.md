# 中英文混排与窄窗口验收样本

这是一份固定的阅读排版样本：中文 Chinese、半角标点 `,.:;!?`、全角标点 `，。：；！？` 同行出现。阅读、缩放和横向滚动均不应改写本文件。

## GFM 表格

第二列包含不同字宽的文字和一条长链接；第三列有意设置为右对齐的数值列。窄窗口中应能横向查看整张表，列头和每行单元格仍保持对应。

| 类型 / Type | 混排内容 / Mixed content | 数值 / Value |
| :--- | :--- | ---: |
| 半角 punctuation | A,B.C: 价格 ¥12.50；版本 v2.0 | 1.20 |
| 全角 punctuation | A，B。C：价格 ￥１２．５０；版本 ｖ２．０ | 12,345.67 |
| 字形边界 | 汉字 ABC 😀 é（这里的 é 是 e 加组合重音） | 0.09 |
| 长链接 / URL | [https://example.com/very-long-path-for-horizontal-table-overflow/segment-01/segment-02/segment-03/segment-04](https://example.com/very-long-path-for-horizontal-table-overflow/segment-01/segment-02/segment-03/segment-04) | 987,654.32 |

## 列表与标记

9. 九：中文与 ASCII 123 混排，标记应位于正文左侧。
10. Ten：两位数标记后，正文起始位置应与相邻项一致。
    1. Nested one：嵌套有序项，包括全角括号（甲）和半角括号 (A)。
    2. Nested two：😀 emoji 与 Café 组合字符不应挤压标记。
11. 十一：这是一段较长的列表文字，窄窗口换行时，第二行应与本项正文对齐，而不是跑到数字标记下面。继续加入中英 mixed words 和全角标点，观察自然换行。
12. Twelve：最后一项。

- [x] 已完成：同一层级的任务标记位置稳定。
  - [ ] 待办：嵌套任务缩进清楚，正文可自然换行。
  - [x] Done：中文、English 与 １２３／123 共存。
- [ ] 未完成：列表和下面的代码块之间有清楚的间距。

## 代码块与长行

下面的代码块第二行包含真实的 tab 字符；长行应在代码区域内横向滚动，不能撑开阅读正文或遮挡旁边内容。

```text
column-one	column-two	第三列
alpha	beta	中文与 ASCII
https://example.com/source/this-is-a-single-unbroken-code-line/segment-01/segment-02/segment-03/segment-04/segment-05/segment-06/segment-07/segment-08/segment-09/segment-10
```

代码块之后仍应正常显示这一段。独立长链接 [https://example.com/standalone/long-link/segment-01/segment-02/segment-03/segment-04/segment-05/segment-06](https://example.com/standalone/long-link/segment-01/segment-02/segment-03/segment-04/segment-05/segment-06) 应留在阅读区域内并可完整查看。
