---
name: weflow
description: 查询与分析微信数据（聊天记录、会话、群成员、媒体下载、特殊消息解析）时使用。触发场景：用户提到微信聊天记录/微信消息/某个联系人的聊天/群成员/微信群/某人所在的群/微信导出/聊天统计/下载聊天中的图片视频语音文件，或要求基于聊天内容做分析、总结、画像、找证据时。数据来自 WeFlow 微信数据服务（HTTP API），通过 weflow_* 系列工具访问，实时读取、不做缓存。
---

# WeFlow 微信数据查询指南

## 前置条件

- 数据由 WeFlow 服务提供，**必须保持 WeFlow 运行且已开启 HTTP API**，通过配置的 `apiUrl` 访问。
- 配置文件：`~/.config/weflow/config.json`（Windows：`%USERPROFILE%\.config\weflow\config.json`）。必填 `apiUrl`、`token`；可选 `outputDir`（默认 `/tmp/weflow/exports`）、`mediaDir`（默认 `/tmp/weflow/media`）。
- 工具返回「WeFlow 服务不可达」时：**明确告知用户需在 WeFlow 所在机器上手动启动 WeFlow 并开启 HTTP API**，确认网络与配置后重试；不要尝试其他数据通道，也不要因此断言"没有消息"。
- 工具返回 401 时：提示用户检查配置文件中的 `token` 是否有效。
- 工具实时读取 WeFlow，**不做任何缓存**；同一数据在不同时间可能因微信新消息而变化。

## 数据特性（影响结果解释）

- **无消息总数**：`weflow_get_messages` 的 `total`/`totalPages` 恒为 `null`，用 `hasMore` 判断是否还有更早消息。
- 群成员数据由 WeFlow 服务端提供（可能命中其缓存）：`weflow_find_groups_by_member` 的 meta 中 `groupMembersFresh`/`groupMembersCached` 反映来源；需要最新数据可传 `forceRefresh=true`。
- `weflow_find_groups_by_member` 会全量枚举所有群的成员，通常 8~15 秒，属正常耗时；同一任务内不要反复调用。
- `senders` 表中当前账号统一为 `{"name":"我","isSelf":true}`；群成员名优先显示群昵称（`groupNickname`）。
- 媒体文件名由 WeFlow 提供，`weflow_resolve_message` 每次重新下载并覆盖同名文件，返回的 `savedTo` 为本地绝对路径。

## 工具参数说明

### weflow_search_sessions（查询会话，不含聊天记录）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `searchType` | string | 是 | — | `"byName"` 模糊 / `"byId"` 精确 |
| `keyword` | string | 是 | — | byName: 名称/备注/ID 片段；byId: 完整会话 ID |
| `sessionType` | string | 否 | 全部 | `"private"` / `"group"` / `"channel"` |
| `limit` | number | 否 | 50 | 返回上限，最大 500 |

返回：`username`（会话 ID）、`displayName`、`sessionType`、`lastTimestamp`、`lastTimestampText`、`unreadCount`；群聊附加 `memberCount`。

### weflow_find_groups_by_member（按成员找群）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `keyword` | string | 是 | — | 成员 wxid（精确）或姓名/备注/昵称/群昵称（模糊） |
| `limit` | number | 否 | 50 | 群返回上限，最大 200 |
| `forceRefresh` | boolean | 否 | false | 是否强制 WeFlow 刷新群成员数据 |

返回：`totalMatched`、`groups[]`（`username`、`displayName`、`memberCount`、`matchedMembers[]`），meta 含 `groupsScanned`、`elapsedMs`、`groupMembersFresh/Cached`（若有失败还有 `groupMembersFailed`）。

### weflow_get_messages（聊天记录查询，默认 10 条/页）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `sessionId` | string | 是 | — | 会话 ID（仅支持 ID 精确查询） |
| `page` | number | 否 | 1 | 页码（第 1 页为最新消息） |
| `pageSize` | number | 否 | 10 | 每页条数，1-100 |
| `start` | string | 否 | — | 起始时间（yyyyMMdd / yyyy-MM-dd / Unix 秒/毫秒） |
| `end` | string | 否 | — | 结束时间（日期型含当天全天） |
| `keyword` | string | 否 | — | 全文搜索关键词（服务端搜索） |

返回结构为**归一化两段式**：

- `senders`：发送者信息表，`{ "wxid_x": { name, groupNickname?, isSelf? } }`
- `messages`：`{ localId, createTime, createTimeText, sender, isSend?, typeLabel, content }`，`sender` 是 `senders` 表的键引用
- 分页元信息：`total` 与 `totalPages` 恒为 `null`，用 `hasMore` 判断

`typeLabel` 为中文类型标签（文本/图片/语音/视频/表情/位置/通话/链接/文件/引用/小程序/群公告/系统提示等）；非文本消息 `content` 为中文摘要占位符，完整内容用 `weflow_resolve_message`。

### weflow_export_messages（导出聊天，默认全量）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `sessionId` | string | 是 | — | 会话 ID |
| `format` | string | 否 | `"jsonl"` | `"jsonl"`（每行一条消息，供 query.py 检索）/ `"markdown"`（按日分节可读文档） |
| `start` / `end` | string | 否 | 不限 | 起止时间，收窄导出范围 |
| `outPath` | string | 否 | 自动生成 | 输出文件路径，默认 `outputDir` 下自动命名 |

返回 `outputFile`、`totalMessages`、`sizeBytes`、`timeRange`。

### weflow_resolve_message（特殊消息解析）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `sessionId` | string | 是 | — | 会话 ID |
| `items` | array | 是 | — | `[{localId, createTime}]`，**createTime 必填**（来自 `weflow_get_messages`） |

按消息类型分派：

- 图片/视频/语音/文件/表情 → 从 WeFlow 导出并下载到本地，返回 `savedTo` 文件路径（缓存目录 `mediaDir`，同会话下同名覆盖）
- 链接/引用/位置/小程序/群公告/视频分享 → 返回解析后的 `content` 与结构化 `parsed`
- **本地未下载的媒体** → `status: "not_downloaded"`，引导用户在微信中打开该消息完成下载后重试
- 缺少 createTime → `status: "missing_createTime"`，先调用 `weflow_get_messages` 获取后重试
- 消息不存在 → `status: "not_found"`

## 场景决策

### 用户提到某人/某群，想看聊天记录

1. `weflow_search_sessions(searchType="byName", keyword="名字")` 找到会话，让用户确认
2. `weflow_get_messages(sessionId=username)` 取第 1 页（最新 10 条）
3. 用 `senders` 表解析 `sender` 引用，以 `createTimeText` + 发送者名 + `content` 复述

### 用户想知道某人在哪些群里

`weflow_find_groups_by_member(keyword="人名或wxid")`，一次调用完成；首次约 8~15 秒，等待即可，不要重复调用。

### 用户想找历史消息

- 记得时间：`weflow_get_messages(sessionId, start=..., end=...)`
- 记得内容：`weflow_get_messages(sessionId, keyword="关键词")`，可叠加时间窗
- 翻页：`page=2, 3, ...` 向更早翻页，直到 `hasMore=false`

### 用户想看某条非文本消息的完整内容

1. 从 `weflow_get_messages` 结果拿到 `localId` 与 `createTime`
2. `weflow_resolve_message(sessionId, items=[{localId, createTime}])`
3. 媒体返回 `savedTo` 文件路径；链接/引用/位置/小程序等返回 `content` 与 `parsed`

### 用户想下载图片/视频/语音/文件

1. `weflow_get_messages` 中找到 `typeLabel` 为图片/视频/语音/文件的消息，记下 `localId` 与 `createTime`
2. `weflow_resolve_message(sessionId, items=[...])`（支持批量）
3. `status="ok"` 时 `savedTo` 为文件路径；`status="not_downloaded"` 时引导用户在微信中打开该消息下载后重试

### 用户需要大量聊天记录做分析

**不要将大量消息分页灌入上下文**。使用导出 + 脚本分析：

1. `weflow_export_messages(sessionId)` 全量导出（默认 jsonl 到 `outputDir`）
2. 用本 SKILL 目录下 `scripts/query.py` 检索该文件（见下节）
3. 根据精简结果向用户总结

## 检索脚本 query.py

位于本 SKILL 目录下 `scripts/query.py`（全局部署时为 `~/.config/opencode/skills/weflow/scripts/query.py`），分析 `weflow_export_messages` 导出的 jsonl 文件，通过 `bash` 调用。**优先使用此脚本，不要自行编写内联 Python 代码。**

```bash
# 基本统计（消息数、时间范围、类型分布、发言者排行）
python3 ~/.config/opencode/skills/weflow/scripts/query.py stats <导出文件>

# 提取文本对话（适合复述）
python3 ~/.config/opencode/skills/weflow/scripts/query.py texts <文件> --limit 100
python3 ~/.config/opencode/skills/weflow/scripts/query.py texts <文件> --sender wxid_xxx --keyword 关键词

# 时间范围过滤（--start/--end 支持 yyyyMMdd 或 yyyy-MM-dd）
python3 ~/.config/opencode/skills/weflow/scripts/query.py texts <文件> --start 20260701 --end 20260729

# 按时间分组统计
python3 ~/.config/opencode/skills/weflow/scripts/query.py timeline <文件> --by day
python3 ~/.config/opencode/skills/weflow/scripts/query.py timeline <文件> --by hour

# 搜索内容
python3 ~/.config/opencode/skills/weflow/scripts/query.py search <文件> --keyword 关键词 --limit 100

# 发言者统计
python3 ~/.config/opencode/skills/weflow/scripts/query.py senders <文件>

# 按类型/发送者过滤
python3 ~/.config/opencode/skills/weflow/scripts/query.py filter <文件> --type 文本 --limit 100
```

**若 query.py 无法满足需求，必须自行编写脚本时**：先用 `write` 工具写入 `/tmp/xxx.py` 再执行，禁止内联 `python3 -c "..."`。

## 错误处理

工具返回 `success=false` 时，用自然语言向用户说明，不要展示原始错误 JSON：

| 错误内容 | 应对 |
|----------|------|
| WeFlow 服务不可达 | 提示用户在 WeFlow 所在机器上手动启动 WeFlow 并开启 HTTP API，检查网络与配置后重试 |
| 无法读取配置文件 / 缺少 apiUrl 或 token | 指导用户创建 `~/.config/weflow/config.json` 并填写 |
| 401 token 无效 | 提示用户检查配置文件中的 token 是否有效 |
| 调用超时 | 数据量较大或服务繁忙，建议缩小范围重试 |
| missing_createTime | 先用 `weflow_get_messages` 获取该消息的 `createTime` 再解析 |
| not_found | localId 与 createTime 不匹配，确认参数来源 |
| not_downloaded | 媒体本地未下载，引导用户在微信中打开该消息后重试 |
