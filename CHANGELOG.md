# CHANGELOG

## 0.2.1

**四个工具从来没在真实宿主里挂上过。**

宿主对工具的校验是 `output` 里必须同时有 `schema` 与 `render`，缺一个就拒收，且只报 warn 级：

```
warn cogdebt: 工具 cogdebt_owe 挂不上：
tool "cogdebt_owe" must declare output { schema, render, presentationMeta? }
```

0.1.0 起 `render` 一直被放在工具对象顶层，而宿主要求它在 `output` 里面。插件加载成功、没有异常、日志只有一行不起眼的警告，但 `cogdebt_owe` / `cogdebt_pay` / `cogdebt_list` / `cogdebt_stat` 一个都调不到。0.2.0 的 91 个用例用自建替身，形状没人校验，所以全绿。

- `render` 移进 `output`，返回值改为内容块数组 `[{ type: 'text', text }]`。
- 默认 render 补失败前缀 `✗`，与 taskpilot 同形。
- 测试加四条锁住形状：`output.schema` 与 `output.render` 都必须在 `output` 里、顶层不得再有 `render`、默认 render 输出内容块数组、失败带 `✗`。91 → 93 个用例。

## 0.2.0

第一版能记账能算利息；这一版把「静默出错」的路子堵上，并且第一次带测试。

### 修

- **`normReason` 把所有认不出的输入都当成 `later`**：传 `'xx'`、或者把 `hard` 拼成 `haard`，都会被静默记成「明天再说」，按 0.5 的系数算利息。用户以为自己标了「太难不敢碰」，账本按「只是往后拖」收利息。现在 `normReason` 认不出就返回空串表示「没指定」，由 tool 层区分「没填」与「填错了」——填错直接报错并列出五个合法值。
- **`normStatus` 是死代码**：返回空串，仓库内无任何调用点，`pay` / `owe` 全是硬编码状态。已删除，归一化职责搬进 `read()`（顺带让拼错状态的历史脏数据在读取时被纠正回 `open`，而不是从利息排序、汇总、还款三处同时消失）。
- **利息全为 0 时谎报「欠得最狠的是 X」**：`worstSum` 初值是 `-1`，所以刚记下、一个字都没拖的债也会被选中并写进汇总文案。改成 `0` 起步，只有真的算出正的利息和才认这一类。
- **`summaryText` 与 `summary` 各用各的时钟**：两处都调 `Date.now()`，中间隔了毫秒级差异时「最久拖了 N 天」会跟利息合计对不上（测试里构造出的极端差异是 1108 天）。现在时钟可注入，`stat` 把同一个 `now` 传给两处。
- **显式 `limit: 0` 被吞成默认 8**：`Number(v) || 8` 对 0 返回默认值。新增 `pickInt()` 区分「没给」和「给了 0」。
- **`list` 的 `all` 分支把上限放大 3 倍**：`.slice(0, lim * 3)` 让默认 8 变成 24，与说明里的「最多 8 笔」不符。改为独立的 `allLimit`（默认 50，上限 500），并在输出里补「还有 N 笔没列」与 `shown` 计数。

### 加

- **测试套件（从 0 到 91 个用例）**：`lib/store.js`、`lib/interest.js`、`lib/tool.js`、`lib/index.js`、`package.json` 五层，store 用 `mkdtempSync` 造临时目录，全程离线。
- `package.json` 补 `scripts.test`、`files` 白名单、`keywords`、`repository`、`engines`。
- `lib/store.js` 导出 `REASON_KEYS`，tool 层的报错文案直接由它拼，枚举只存在一处。

## 0.1.0

首个版本。

- 记账：`cogdebt_owe` 记下「先跳过、回头再看」的东西，可标原因与痒度
- 利息：痒度 × 拖了几天 × 原因系数，拖越久越不想碰的排越前
- 还账：`cogdebt_pay` 结清，`cogdebt_drop` 划掉
- 清单：`cogdebt_list` 按利息倒序，可只看某一类原因
- 汇总：`cogdebt_stat` 欠几件、利息合计、欠得最狠的是哪类、最近 30 天还了几件
- 定时提醒：按 `scanIntervalMinutes` 扫描，跳过 `quietHours` 静默时段，受 `nagCooldownHours` 冷却
