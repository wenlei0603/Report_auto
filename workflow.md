# LSEG Research Next 下载工作流

本文描述当前自动下载项目的完整工作流，以及为保证任务选择、筛选、下载和续跑准确性所设置的兜底机制。这里记录的是项目运行约定和操作原则，不是某一次临时调试步骤。

## 1. 总体目标

系统目标是从任务文件中逐条读取公司和日期窗口，在用户已登录的 LSEG Workspace 浏览器中自动完成：

1. 连接已有浏览器会话。
2. 定位 Research Next 内层应用。
3. 应用固定全局筛选条件。
4. 应用单条任务的公司和日期窗口。
5. 执行搜索并判断结果状态。
6. 在确认可下载后触发下载。
7. 下载进入 `BatchSavePrint` 后断开 CDP，让浏览器原生下载链路稳定落盘。
8. 落盘结束后重新连接 CDP，进入下一条任务。

核心原则是：脚本负责精确填筛选器和触发下载，浏览器负责原生 PDF 落盘。不要在 CDP 附着状态下强行接管 `BatchSavePrint` 的下载事件。

## 2. 浏览器连接模型

用户先打开带远程调试端口的 Chrome/Edge，并手动登录 LSEG Workspace。脚本通过配置中的 CDP endpoint 附着到这个已有浏览器。

连接后，自动化不会把外层 Workspace URL 当成真正的操作对象，而是寻找内层 Research Next frame。可操作的 Research Next frame 通常形如：

```text
/Apps/research-next/2.x/
```

如果当前浏览器停留在 `BatchSavePrint`，说明上一轮下载流程尚未回到 Research Next。系统需要先恢复到 `workspace_url`，等待 Research Next frame 重新就绪，再继续下一条。

## 3. 任务队列与跳过规则

任务来自配置中的输入文件，每行包含公司、ticker、call date 和搜索窗口。真正用于搜索的是输入文件给出的 `dateFrom/dateTo`，不是简单的 `cc_date + 7 days`。

启动时系统读取：

- `logs/task_status.jsonl`
- `output/task_progress.csv`
- `output/task_file_mapping.csv`

已经有最终状态的任务会被视为完成，不再重复执行。未完成任务按照文件顺序进入 pending queue。调试时应优先使用：

```powershell
node dist/src/cli.js run --dry-run --max-tasks 5
```

确认下一批任务，再实跑。

## 4. 全局筛选流程

全局筛选只在需要时应用，默认可复用上一轮状态：

- Contributor: `Morgan Stanley`
- Country/Region: `United States of America`
- Industry: empty / none
- Preferred contributors: 必须关闭

系统通过 Web Component 内部状态设置 contributor、country 和 industry，而不是只依赖可见文本输入。应用后必须记录实际选中的 labels 和 values。

兜底要求：

- 如果 contributor 没有选中 `Morgan Stanley`，不能继续下载。
- 如果 country 没有选中美国，不能继续下载。
- 如果 preferred contributors 仍被勾选，不能继续下载。
- 如果全局筛选失败，任务状态应为 `filter_not_applied`，而不是 `no_rows`。

## 5. 单任务筛选流程

每条任务只改变两个核心条件：

- 公司 / ticker
- 自定义日期窗口

公司筛选优先使用 ticker 搜索，同时校验候选项是否真的对应目标公司。系统会读取候选项 label/value，并根据以下信号打分：

- value 与 ticker 完全一致。
- value 是 ticker 加交易所后缀，且 label 支持该公司。
- label 与公司名完全匹配。
- label 包含公司名核心 token。

如果候选项存在但不可信，任务应进入 `special_company_case` 或 human review，而不是下载无关公司结果。

日期筛选使用已验证的稳定路径：

1. 打开 `Date Range`。
2. 选择 `Custom`。
3. 聚焦日期 picker 的 shadow input。
4. 输入 from date。
5. Tab 到 to date。
6. 输入 to date。
7. 点击 OK。
8. 校验摘要中包含两个格式化日期。

关键约束：日期完成后，在点击 `SEARCH` 之前必须断开公司输入控件的 query/opened 状态，避免输入控件继续保持链接或焦点，干扰后续复选框和下载按钮。

## 6. 搜索后结果判定

点击 `SEARCH` 后，系统进入结果判定。不要只依赖传统表格行，因为当前 Research Next 的结果列表不是普通 `table/tr/td`，而是 `emerald-grid` Web Component 的 Shadow DOM 列式网格。

有效结果信号包括：

- 可见 result rows。
- 页面文本中出现 `1-1 of N records` 这类记录计数。
- 页面进入 Document Information / download-ready 模式。
- `app-main-grid emerald-grid` 的 `shadowRoot` 中出现列头和列数据。

失败状态必须分开记录：

- `no_results`: 页面明确显示无结果。
- `no_rows`: 结果行或记录计数超时不可见。
- `filter_not_applied`: 筛选条件没有正确应用。
- `special_company_case`: 公司候选或结果公司不可信，需要人工判断。

如果页面显示记录计数但普通 DOM 无法采样结果行，不应立即认为没有结构。需要继续穿透 `app-main-grid emerald-grid.shadowRoot`，从列式网格中抽取行数据做公司审查和下载复筛。

## 7. 下载触发流程

结果确认后进入下载阶段：

1. 再次断开输入控件链接，避免焦点残留。
2. 对可见结果行做 `ccDate..ccDate+7` 二次复筛；这是闭区间，包含 `ccDate` 当天和 `ccDate+7` 当天。
3. 复筛必须使用结果行的 `Date` 字段，而不是 `Available Date`。
4. 勾选所有 `Date` 落在事件窗口内的报告；窗口外的行如果已勾选，必须取消。
5. 如果可见行可解析但没有任何 eligible 行，记录 `no_eligible_rows_selected_for_event_window`，不要下载。
6. 如果无法采样可见行，才退回 select-all checkbox 兜底。
7. 点击页面级 `Download`。
8. 等待 `Save Documents to PC` 出现。
9. 点击 `Save Documents to PC`。
10. 检测是否进入 `BatchSavePrint`。

这里最重要的准确性保证是：勾选不是“点过就算成功”。能解析可见行时必须按 `Date` 字段复筛；不能解析时，select-all 兜底也必须看到 `N Checked`。行级复选框点击后必须再次读取真实 checked 状态；如果真实选择数为 0，不能继续点击 `Download`。

## 8. BatchSavePrint 后的 CDP 断开策略

当前实测发现：当脚本保持 CDP 附着时，`BatchSavePrint` 下载链路会不稳定。表现为点击流程正常，但 Playwright 可能收不到 download event，或者浏览器只留下下载记录但 PDF 不稳定落盘。

因此当前工作流采用明确的 handoff 策略：

1. 自动化必须先完成真实行勾选，再点击页面级 `Download`。
2. 自动化必须看到并点击 `Save Documents to PC`。
3. 一旦检测到真正的 `BatchSavePrint` app URL，立即关闭 Playwright browser connection，也就是断开 CDP 附着。
   - 应匹配 `/Apps/BatchSavePrint/` 或 `/web/Apps/BatchSavePrint/`。
   - 不应把 `BatchSavePrintService` 文本或 service 容器名误判为成功下载。
4. 断开后让原生浏览器继续完成 PDF 保存。
5. 断开前记录落位目录中已有 PDF；断开后最多轮询 150 秒。
6. 如果出现新的、大小稳定的 PDF，将其归档到 `output/downloads/by_task/<taskId>/`，写入 mapping 和 artifact。
7. 如果 150 秒内没有对应 PDF 稳定落盘，记录：
   - `human_review_required:pdf_landing_timeout_after_batchsaveprint`
8. 落盘成功或 human review 标记完成后重新连接 CDP。
9. 重新定位 Research Next frame，继续下一条任务。

这不是异常路径，而是当前项目阶段的稳定下载交接策略。不要在这一阶段改成多页级 download listener，除非后续实验证明 CDP 附着不再影响落盘。

## 9. 落盘后重连与续跑

断开 CDP 后，主循环必须能识别当前 session 已断开。下一条任务开始前执行：

1. 重新通过 CDP endpoint 连接浏览器。
2. 查找 Workspace / Research Next 页面。
3. 如果浏览器仍停在 `BatchSavePrint`，先恢复到 Research Next URL。
4. 等待内层 Research Next frame 就绪。
5. 重新分类当前 app state。
6. 确认不是 auth/session-expired。
7. 进入下一条任务的 query mode。

如果重连后遇到登录态失效，应暂停并要求用户重新登录，而不是继续点击。

## 10. 任务状态与产物记录

每条任务至少写入：

- task id
- company
- date window
- final status
- note
- page URL
- artifacts，如果已经由脚本直接验证 PDF

当前 handoff 策略下，PDF 可能由浏览器原生落盘而不是 Playwright `download.saveAs()` 保存。因此系统会在断开前后比较落位目录 PDF 清单，确认新 PDF 稳定后再归档并回填 `output/task_file_mapping.csv`。

## 11. 精准实现的兜底清单

为避免“看似跑完但结果不可靠”，每一层都必须有 postcondition：

- 浏览器连接：必须找到 Research Next 内层 frame。
- 登录状态：不能处于 auth/session 页面。
- 全局筛选：Contributor/Country/Industry/Preferred 状态必须与配置一致。
- 公司筛选：选中的 label/value 必须能解释为目标公司。
- 日期筛选：日期摘要必须包含 from/to。
- 搜索触发：点击前必须断开输入 query/opened 状态。
- 结果判断：区分 no results、no rows、record count visible、document info；普通 DOM 采样失败时必须继续检查 `emerald-grid.shadowRoot`。
- 公司结果审查：能采样时必须检查列表公司；不能采样时必须记录 bypass。
- 勾选下载：可见行按 `Date` 字段执行 `ccDate..ccDate+7` 复筛；行 checkbox 点击后必须验证真实 checked；select-all 兜底后必须验证 `N Checked`。
- 保存按钮：必须看到并点击 `Save Documents to PC`。
- BatchSavePrint：出现后立即断开 CDP，并最多 150 秒轮询新 PDF 是否稳定落盘。
- 重连续跑：下一条任务前必须重新 attach 并恢复 Research Next scope。

## 12. 当前已知风险

当前流程仍有几个需要后续完善的点：

- 如果浏览器原生下载目录不在配置候选目录内，150 秒轮询可能无法发现 PDF，需要人工检查下载设置。
- 如果当天 LSEG 下载页数限额已到，点击链路可能仍能进入 `BatchSavePrint` / `Batch Save Print Service`，但内层页面显示 `Number of documents: 0`，不会落 PDF。这不是普通选择器失败，应记录为限额/外部下载不可用边界。
- 当前需要继续增强对 `BatchSavePrint` 内层状态的读取：区分“文档数为 0”“正在生成”“已生成但未落盘”“下载目录未覆盖”。
- 行级勾选虽然已经能定位 `emerald-grid.shadowRoot`，但还需要在实盘可下载日继续验证：勾选后页面选择计数、`Download` 菜单、`Save Documents to PC`、`BatchSavePrint` 文档数应逐层一致。

这些风险不影响当前“先稳定下载、再重连续跑”的策略，但必须在日志中透明保留。

## 13. 推荐调试节奏

调试时不要直接大批量跑。推荐顺序：

1. `npm run build`
2. `npm test`
3. `node dist/src/cli.js run --dry-run --max-tasks 3`
4. `node dist/src/cli.js run --start-from-task Txxxx --max-tasks 1 --max-downloads 1`
5. 人工确认 PDF 是否原生落盘。
6. 查看 `logs/run_log.jsonl` 和 `logs/task_status.jsonl`。
7. 确认重连后再跑下一条。

只有当连续多条任务都能完成“筛选准确 -> 下载交接 -> PDF 落盘 -> 重连续跑”后，才提高 `--max-tasks`。

## 14. 2026-05-03 页面结构与运行知识归档

本节记录本次 live 调试确认的页面事实，供下次 revise 和新增 feature 使用。

### 14.1 Research Next frame 层级

外层 Workspace 页面通常是：

```text
https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID
```

真正可操作的 Research Next 应用在内层 frame，当前观察版本为：

```text
https://workspace.refinitiv.com/Apps/research-next/2.22.3/#/?st=OAPermID
```

外层页面 body 可能为空，不能用外层 DOM 判断结果。必须在 `2.22.3` frame 内做筛选、结果判定和下载前复筛。

### 14.2 结果列表真实结构

结果列表不是普通表格。页面上看起来像表格，但 DOM 结构是：

```text
app-main-grid
  app-tr-grid
    emerald-grid.refi-tr-grid
      #shadow-root
        .tr-lg.title
          .grid-pane.columns
            .column  // 列头
        .tr-vlg.content
          .grid-pane.columns
            .column  // 每一列的数据
              .cell  // 每个 cell 按 y 坐标对应同一行
```

列头示例：

```text
Date
Available
Info
Company Name
Ticker
Title
Pages
Retail Value
Contributor
Analyst
Countries/Regions
Industry
```

数据是按列渲染，不是按行渲染。例如第 0 个数据列是 `Date`，第 1 个数据列是 `Available`，第 4 个数据列是 `Company Name`，第 5 个数据列是 `Ticker`，第 6 个数据列是 `Title`。要还原行，需要按同一 row index 组合各列 `.cell`。

### 14.3 已确认的行抽取方式

从 `emerald-grid.shadowRoot` 抽取：

1. 用 `.tr-lg.title .grid-pane.columns .column` 读取列头。
2. 用 `.tr-vlg.content .grid-pane.columns .column` 读取数据列。
3. 每个数据列下直接子节点 `.cell` 是可见行 cell。
4. 用相同 cell index 合并为一条结果行。

示例抽取行：

```text
Date: 20-Apr-2016
Company Name: Abbott Laboratories
Ticker: ABT.N
Title: RequestAbbott Laboratories: Growth Implies Stability; Our Take on Alere
Contributor: Morgan Stanley
```

这个结构解释了此前 `record_count_visible` 但普通 `tbody tr` / `[role=row]` 采样不到行的原因：不是没有结构，而是结构藏在 Web Component 的 Shadow DOM 中。

### 14.4 公司审查逻辑

公司审查应优先从 `emerald-grid.shadowRoot` 抽样真实结果行：

- `Company Name` 包含目标公司或核心 token。
- `Ticker` 匹配目标 ticker 或 ticker 后缀形式，例如 `ABT.N`。
- 若列表包含多家公司和多 ticker，不能只看侧边 facet 中的公司名，因为 facet 会显示相关公司集合。

这次验证中，`Abbott Laboratories / ABT` 页面可抽取到 `ABT.N` 行和若干关联医疗公司行。公司审查通过的关键是至少存在目标公司/ticker 行，并且抽样结果整体可解释。

### 14.5 下载前复筛逻辑

下载前最终准入规则：

```text
结果行 Date 字段 ∈ ccDate..ccDate+7
并且 ticker 匹配目标 ticker
```

注意：

- 不使用 `Available` 字段做事件窗口判断。
- `Available` 是发布时间/可用时间，可能晚于报告 `Date`。
- 搜索框中的 `Date-customize` / `dateFrom..dateTo` 是候选池范围。
- `ccDate..ccDate+7` 是下载前准入范围。

### 14.6 复选框结构

结果网格中的复选框也在 `emerald-grid.shadowRoot` 中：

```text
coral-checkbox.select-doc-checkbox      // 表头 select all
coral-checkbox.selected-doc-checkbox    // 行级 checkbox
```

行级 checkbox 的 y 坐标与各列 `.cell` 的 y 坐标对应。按 row index 选择时，`selected-doc-checkbox[rowIndex]` 对应同 index 的结果行。

重要约束：

- 不能把 `checkbox.click()` 当成选中成功。
- 点击后必须等待前端状态同步，再读取 `checked` / `aria-checked` / `checked` attribute。
- 真实选中数为 0 时，不允许继续点 `Download`。

### 14.7 Download 与 Save To PC

正确后半段必须是：

```text
真实勾选符合条件的行
-> 点击页面级 Download
-> 点击 Save Documents to PC / Save to my PC
-> 进入 BatchSavePrint
-> 断开 CDP
-> 轮询 PDF 落盘
```

如果进入 `BatchSavePrint` 后内层页面显示：

```text
Number of documents: 0
```

说明本次没有可保存文档进入 BatchSavePrint 队列。可能原因包括：

- 行 checkbox 实际没有被选中。
- 当天下载页数限额已到，站点拒绝创建新的 batch 文档。
- 当前报告因权限、大小、页数或账户限制不可下载。

今天的 live 调试中，用户确认当天页数下载限额已到，因此这类 `Number of documents: 0` 应优先归档为运行边界/限额状态，而不是立即判定选择器或 CDP 逻辑错误。

### 14.8 BatchSavePrint 与 BatchSavePrintService

Workspace 外层 URL 可能是：

```text
/web/Apps/BatchSavePrint/?ws=true&batchmode=basic...
```

AppContainer 文本可能显示：

```text
Batch Save Print Service
```

真正内层 app frame 可形如：

```text
/Apps/BatchSavePrint/1.3.4/
```

因此：

- `Batch Save Print Service` 是容器/服务标题，不等于 PDF 已开始下载。
- 只能把明确的 `/Apps/BatchSavePrint/` 或 `/web/Apps/BatchSavePrint/` URL 当作 handoff 页面。
- 后续 feature 应读取内层 BatchSavePrint 状态，包括文档数、状态列、Action 列和错误提示。

### 14.9 今日测试结论

本轮 live 测试确认：

- CDP 能进入 Research Next query 页面。
- 公司筛选 `Abbott Laboratories / ABT` 可正确选中。
- 搜索结果可从 `emerald-grid.shadowRoot` 中解析出来。
- 公司审查可基于 Shadow DOM 结果行通过，不再需要把 `record_count_visible` 当作无法采样。
- 当前下载失败与 PDF 不落盘主要受当天下载页数限额影响；不能据此否定整体筛选、结果定位和后半段设计。

下次继续开发时，优先新增：

- BatchSavePrint 内层状态解析。
- 下载限额识别状态，例如 `download_limit_reached` 或 `human_review_required:download_limit_or_zero_documents`。
- 行级 checkbox 选择计数日志。
- `Download` 菜单打开后可下载文档数验证。
- 更细的 run log：selected rows、eligible rows、clicked save、BatchSavePrint document count、PDF polling directories。
