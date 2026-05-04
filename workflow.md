# LSEG Research Next Downloader 工作流与技术架构

本文是当前 TypeScript + Playwright 重写版的项目工作流说明。它记录稳定运行约定、技术架构、关键实现路线和后续开发方向，优先级高于历史 Python 自动化经验。

核心目标：在用户已经手动登录 LSEG Workspace 的浏览器中，可靠完成 Research Next 报告筛选、结果复核、批量下载、PDF 落盘验证、页数配额控制和断点续跑。

## 1. 总体运行模型

自动化不负责登录，也不绕过平台限制。用户先手动打开带 CDP 调试端口的 Chrome/Edge 并登录 LSEG Workspace，脚本通过 `cdp_endpoint` 附着到这个已有浏览器。

标准运行链路：

1. 读取任务文件并生成任务队列。
2. 读取 `logs/task_status.jsonl`，用每个任务的最新状态决定是否跳过。
3. 通过 CDP 连接已有浏览器。
4. 找到真正可操作的 Research Next frame。
5. 打开 Search options 筛选面板。
6. 应用全局筛选条件：Contributor、Country/Region、Industry。
7. 应用单任务筛选条件：Company/Ticker 与 Date Range。
8. 点击 `SEARCH` 并分类结果状态。
9. 从结果网格抽取真实行数据，做公司、日期、Contributor、页数、Ticker 分类复核。
10. 在进入下载前计算将要勾选报告的页数，先做每日限额守卫。
11. 若不超限，勾选符合条件的行，点击 `DOWNLOAD`。
12. 点击 `Save Documents to PC`。
13. 进入 `BatchSavePrint` 后断开 CDP，让浏览器原生下载 PDF。
14. 等待所有预期 PDF 落盘，再重新连接 Research Next 主页面继续下一任务。

关键原则：脚本负责筛选、复核和触发；浏览器负责原生下载。不要在 CDP 附着状态下强行接管 `BatchSavePrint` 的 PDF 保存链路。

## 2. 技术架构

代码主体在 `src/` 下，按职责分层。

### 2.1 CLI 层

入口：`src/cli.ts`

职责：
- 提供 `inspect` 和 `run` 命令。
- 支持 `--dry-run`、`--start-from-task`、`--max-tasks`、`--max-downloads`。
- 支持 `--include-done`，用于从已终态任务重新跑验证。

常用命令：

```powershell
node dist/src/cli.js inspect
node dist/src/cli.js run --dry-run --max-tasks 5
node dist/src/cli.js run --start-from-task T0004 --max-downloads 0
node dist/src/cli.js run --include-done --start-from-task T0001 --max-downloads 0
```

说明：当前任务文件的第一个真实任务是 `T0002`，`T0001` 通常对应表头或被解析跳过的输入行。因此从 `T0001` 语义起点重跑时，实际队列会从 `T0002` 开始。

### 2.2 编排层

入口：`src/automation/engine.ts`

职责：
- 加载任务。
- 根据最新任务状态选择 pending queue。
- 管理浏览器连接、断线重连和任务主循环。
- 管理 `PageGuard` 页数配额。
- 写入任务状态、mapping 和 run log。

重要语义：
- 默认跳过最新状态为终态的任务。
- `--include-done` 会把已终态任务也纳入队列，适合从头验证。
- `page_limit` 是运行级停止条件，不只是单任务状态。
- `max_downloads=0` 表示不按下载次数限制运行。

### 2.3 浏览器会话层

相关文件：
- `src/browser/session.ts`
- `src/browser/scope.ts`
- `src/browser/state.ts`

职责：
- 通过 CDP 连接已有浏览器。
- 在多个 workspace 页面中优先选择 Research Next，而不是 BatchSavePrint 临时页。
- 定位 Research Next 内层 frame。
- 分类当前页面状态。

Research Next 的真实操作 frame 通常形如：

```text
https://workspace.refinitiv.com/Apps/research-next/2.22.3/#/?st=OAPermID
```

BatchSavePrint 的页面只是临时下载反馈页面，不能作为后续筛选操作页。重连时必须回到 Research Next 主页面。

### 2.4 筛选器层

相关文件：`src/browser/filters.ts`

职责：
- 打开 Search options。
- 应用全局筛选。
- 应用公司和日期筛选。
- 点击 SEARCH。

关键实现事实：
- Search options 不能只点击外层 `app-button` 或铅笔图标。
- 当前最可靠触发器是内层：

```text
app-button.edit-filters-button coral-button[icon='filter']
```

全局筛选：
- Contributor 必须选中 `Morgan Stanley`。
- Country/Region 必须选中 `United States of America`。
- Industry 保持空。
- Preferred contributors 必须关闭。

Contributor 选择必须通过真实 shadow input 输入搜索词，等待建议池刷新，再选择精确 label。不能只写组件的 `query` 属性，否则可能沿用 stale suggestions，例如只看到 `Morningstar, Inc.`。

公司选择：
- 优先 ticker 查询。
- 候选项按 ticker exact、ticker suffix、company exact、company contains 等规则评分。
- 对于不可靠的 `label_contains_ticker`，需要继续尝试公司名；不能轻易下载无关公司。

日期选择：
- 必须处于展开的 Search options 面板。
- 选择 `Custom...`，输入 from/to，点击 OK。
- 校验摘要中包含两个格式化日期。
- 若全局筛选后面板收起，必须再次打开 Search options 再填任务筛选条件。

### 2.5 结果抽取与复核层

相关文件：`src/browser/results.ts`

Research Next 结果表不是普通 HTML table，而是 `emerald-grid` Web Component。真实结构：

```text
app-main-grid
  app-tr-grid
    emerald-grid.refi-tr-grid
      #shadow-root
        .tr-lg.title .grid-pane.columns .column
        .tr-vlg.content .grid-pane.columns .column .cell
```

抽取方法：
- 从 title 区读取列头。
- 从 content 区按列读取 cell。
- 用相同 cell index 组合为一行。

关键列：
- `Date`
- `Available`
- `Company Name`
- `Ticker`
- `Title`
- `Pages`
- `Contributor`

结果复核规则：
- Company Name 必须支持目标公司。
- Contributor 必须为 Morgan Stanley。
- Pages 必须小于等于配置中的 `filters.max_pages`，当前为 `23`。
- Date 和 Available 都要满足窗口要求。
- 结果行按下载类别分类。

下载类别：
- `ticker_matched`：严格 ticker 符合，且无 `+N` 多公司/多 ticker 歧义。
- `ticker_mismatch`：公司名和日期等核心条件符合，但 ticker 不严格或存在多公司歧义。
- `none`：日期、Contributor、页数、公司等硬条件失败。

当前业务规则：`ticker_matched` 和 `ticker_mismatch` 都下载，但必须在日志里区分。后续可根据日志重新归档。

### 2.6 下载层

相关文件：`src/browser/download.ts`

职责：
- 根据复核结果选择行。
- 下载前做页数预占。
- 点击 DOWNLOAD。
- 点击 Save Documents to PC。
- 进入 BatchSavePrint 后断开 CDP。
- 等待全部预期 PDF 落盘。
- 归档 PDF 并写入 artifact/mapping。

关键规则：
- 能解析可见行时，只勾选 auto-select 行。
- 不能把 checkbox click 当成成功，必须验证真实 selected 状态。
- 若真实选中数为 0，不允许继续点击 DOWNLOAD。
- 若页数超限，不允许勾选行，也不允许点击 DOWNLOAD。

BatchSavePrint handoff：
- 一旦检测到 `/Apps/BatchSavePrint/` 或 `/web/Apps/BatchSavePrint/`，立即断开 CDP。
- 断开后等待浏览器原生 PDF 落盘。
- 等待逻辑必须等待所有预期 PDF，而不是看到第一个 PDF 就进入下一轮。
- 预期 PDF 数量来自已选中行数。

临时页限制：
- `Batch Save Print Service` 是临时下载反馈页。
- 它可能有残留筛选器 UI，但不能作为继续筛选和下载的工作页。
- 下载完成或超时后，必须重新回到 Research Next 主页面继续。

### 2.7 IO 与记录层

相关文件：
- `src/io/records.ts`
- `src/io/runLogger.ts`
- `src/io/pdf.ts`
- `src/io/csv.ts`
- `src/io/jsonl.ts`

主要文件：
- `logs/run_log.jsonl`：结构化运行事件。
- `logs/task_status.jsonl`：任务状态事实表。
- `output/task_progress.csv`：进度 CSV。
- `output/task_file_mapping.csv`：PDF 归档 mapping。
- `output/downloads/by_task/<taskId>/`：按任务归档 PDF。

状态语义：
- `download_started`：已经通过页数守卫并准备进入平台下载队列，页数已预占。
- `downloaded`：PDF 已落盘并归档。
- `no_rows`：没有可见结果行或记录数超时。
- `no_results`：页面明确显示无结果。
- `no_downloadable_report`：有结果但无可下载报告。
- `filter_not_applied`：筛选器未正确应用。
- `special_company_case`：需要人工 review。
- `page_limit`：本任务将超出每日页数限额。
- `task_failed`：自动化异常失败。

最新状态用于决定任务是否完成。页数统计则使用最新的 `download_started` 或 `downloaded` 记录，避免进入平台下载队列后因为后续 CDP 断线而丢失已消耗页数。

## 3. 页数配额设计

平台有每日下载页数限制。项目必须在本地先做保守配额控制，避免超过平台限制。

当前支持：
- 配置默认 `daily_page_limit: 700`。
- 运行时可通过加载 config 后临时覆盖，例如今天临时设为 500。
- `PageGuard` 管理当前已用页数和剩余页数。

重要实现：
- 下载前，从 selected rows 的 `Pages` 列求和。
- 如果 `selectedPages > remainingPages`，直接写 `page_limit`，不勾选、不下载。
- 如果不超限，先写 `download_started`，占用页数。
- 下载成功后写 `downloaded`，同一任务不会重复计入日用量。
- 一旦某任务返回 `page_limit`，外层 run 立即停止。

今天 2026-05-04 的运行状态：
- 临时限额：500 页。
- 已使用：495 页。
- 剩余：5 页。
- 从 `T0045` 起出现多个候选报告超过剩余 5 页的任务。
- 已修复为命中 `page_limit` 即停止，避免继续筛选/勾选后续任务。

## 4. 推荐运行路线

### 4.1 常规验证

```powershell
npm test
npm run lint
npm run typecheck
npm run build
node dist/src/cli.js inspect
node dist/src/cli.js run --dry-run --max-tasks 5
```

### 4.2 从某个任务继续

```powershell
node dist/src/cli.js run --start-from-task T0063 --max-downloads 0
```

### 4.3 从头重新验证，包括已终态任务

```powershell
node dist/src/cli.js run --include-done --start-from-task T0001 --max-downloads 0
```

### 4.4 今日临时页数限额运行

如果不想修改主配置，可以用 Node wrapper 临时覆盖：

```powershell
@'
import { loadConfig } from './dist/src/config.js';
import { runAutomation } from './dist/src/automation/engine.js';
const config = await loadConfig('config/lseg.yaml');
config.daily_page_limit = 500;
config.max_downloads = 0;
await runAutomation(config, {
  dryRun: false,
  startFromTask: 'T0004',
  includeDone: true,
  maxDownloads: 0
});
'@ | node --input-type=module -
```

运行前必须确认：

```powershell
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*dist/src/cli.js run*' -or $_.CommandLine -like '*runAutomation*' }
```

如果已有自动化进程，不要启动第二个进程控制同一个 Chrome。

## 5. 当前已验证里程碑

已完成并验证：
- 能连接用户已登录的 Chrome CDP。
- 能稳定选中 Research Next 主页面，而不是 BatchSavePrint 临时页。
- Search options 可通过内层 filter button 重新打开。
- Contributor 能真实搜索并选择 Morgan Stanley。
- 公司筛选支持 ticker 和公司名 fallback。
- Date Range 自定义输入可用。
- `emerald-grid.shadowRoot` 结果行抽取可用。
- T0065 多 PDF 下载已验证，能等待所有 PDF 完成后再继续。
- T0066/T0067 已验证到 `no_rows` 终态。
- T0003 已真实下载 3 个 PDF，共 39 页。
- 页数预占已生效：`download_started` 会写入页数。
- `page_limit` 已升级为运行停止条件。

最近提交：
- `7a7f502 fix: reopen search options after global filters`
- `b86c139 fix: reserve selected pages before download`
- `6626345 fix: stop run at page limit before selecting rows`

## 6. 后续实现路线

### 阶段 A：稳定继续跑批

目标：在每日限额内持续下载，不超页数、不重复下载、不误用 BatchSavePrint 临时页。

任务：
- 在每天开始前设置正确 `daily_page_limit`。
- 从最新未完成任务继续。
- 每轮下载后检查 `task_status.jsonl` 的 `dailyTotalPages`。
- 达到 `page_limit` 后当天停止。

### 阶段 B：提高公司选择精度

当前公司选择对部分 ticker 可能降级到 `label_contains_ticker`，例如 AK Steel、AMC Networks、ARRIS 等历史实体容易误选。下一步应：
- 降低 `label_contains_ticker` 的自动通过权限。
- 对历史退市、改名、并购公司加入别名表。
- 将不确定公司选择写入 `special_company_case`，而不是继续搜索无关实体。

### 阶段 C：BatchSavePrint 状态解析

后续应读取 BatchSavePrint 内层 frame，区分：
- 文档数为 0。
- 正在生成。
- 已生成但未落盘。
- 平台限额或权限拒绝。
- 文件太大或报告不可下载。

这能减少把下载失败都归为 PDF landing timeout。

### 阶段 D：本地归档分类

当前下载时不分文件夹，统一下载并在日志中区分：
- `ticker_matched`
- `ticker_mismatch`

后续可基于 `logs/run_log.jsonl` 或 `task_file_mapping.csv` 重新归档：
- strict ticker matched
- company/date matched but ticker ambiguous
- human review needed

### 阶段 E：运行仪表盘

建议增加一个只读汇总命令或脚本，输出：
- 今日已用页数。
- 剩余页数。
- 最新任务。
- 最近下载 PDF 数。
- 最近 `page_limit` / `special_company_case` / `task_failed`。

## 7. 操作约束

必须遵守：
- 不同时运行两个自动化进程。
- 每次真实跑前先 `inspect`。
- 当前页面若是 BatchSavePrint，必须先恢复到 Research Next。
- 命中 `page_limit` 后当天不继续跑下载，除非人工明确要寻找小于剩余页数的报告。
- 任何下载成功都必须能在 `output/downloads/by_task/<taskId>/` 找到 PDF，并在状态日志中有 artifact。

推荐每次改代码后运行：

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```
