---
name: weflow
description: 查询与分析本机微信数据（聊天记录、会话、群成员）时使用。触发场景：用户提到微信聊天记录/微信消息/某个联系人的聊天/群成员/微信群/微信导出/聊天统计，或要求基于聊天内容做分析、总结、画像、找证据时。数据来自本机运行的 WeFlow 服务，通过 weflow_* 系列工具访问。
---

# WeFlow 微信数据查询指南

## 工具参数说明

### weflow_search_sessions

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `searchType` | string | 是 | — | `"byName"` / `"byId"` / `"byMember"` |
| `keyword` | string | 是 | — | byName: 名称或备注；byId: 会话ID；byMember: 成员wxid |
| `sessionType` | string | 否 | 全部 | `"private"` / `"group"` / `"channel"` |
| `limit` | number | 否 | 50 | 返回上限，1-1000 |

### weflow_get_private_messages

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `talker` | string | 是 | — | 私聊用户ID（wxid_xxx 或自定义微信号） |
| `limit` | number | 否 | 50 | 返回条数，1-10000 |
| `offset` | number | 否 | 0 | 分页偏移 |
| `keyword` | string | 否 | — | 全文搜索关键词 |
| `start` | string | 否 | — | 起始时间（yyyyMMdd 或 Unix 秒/毫秒） |
| `end` | string | 否 | — | 结束时间（同上） |
| `truncate` | boolean | 否 | true | true=截断返回内容；false=输出完整JSON到文件 |
| `outputPath` | string | 否 | %TEMP% | JSON输出路径（仅truncate=false时生效） |

### weflow_get_group_messages

参数同 `weflow_get_private_messages`，但 `talker` 为群ID（`xxx@chatroom`）。

### weflow_get_message_details

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `talker` | string | 是 | — | 会话ID（wxid_xxx 或 xxx@chatroom） |
| `localIds` | number[] | 是 | — | 消息localId列表（单条时传入 `[id]`） |

### weflow_download_media

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `talker` | string | 是 | — | 会话ID |
| `localIds` | number[] | 是 | — | 消息localId列表（单条时传入 `[id]`） |
| `outputDir` | string | 否 | %TEMP% | 下载保存目录 |

## 返回字段说明

### 通用结构

所有工具返回 JSON：`{ success, data, meta }`。`meta.currentTime` 为当前系统时间，可直接用于判断"今天/昨天"。

### 会话对象（search_sessions 返回）

| 字段 | 含义 |
|------|------|
| `username` | 会话 ID，后续查消息时用此值作为 talker |
| `displayName` | 显示名（备注名或群名） |
| `sessionType` | `private`=私聊，`group`=群聊，`channel`=公众号 |
| `lastTimestamp` | 最后消息 Unix 秒时间戳 |
| `lastTimestampText` | 最后消息可读时间（本地时区） |
| `unreadCount` | 未读消息数 |
| `members` | 仅群聊有此字段，成员列表 |

### 消息对象（get_private_messages / get_group_messages 返回）

| 字段 | 含义 |
|------|------|
| `localId` | 消息 ID，用于 get_message_details 和 download_media |
| `localType` | 消息类型码（1=文本，3=图片，10000=系统提示等） |
| `typeLabel` | 中文类型标签（文本/图片/语音/视频/链接/文件等） |
| `createTime` | 消息 Unix 秒时间戳 |
| `createTimeText` | 消息可读时间（本地时区），直接用此字段表达时间 |
| `isSend` | 1=我发出，0=收到 |
| `senderUsername` | 发送者 wxid（群聊中为发言成员；系统消息为 null） |
| `content` | 消息摘要文本（非文本消息为中文摘要如 [图片]、[链接] 标题） |

## 场景决策

### 用户提到某人/某群，想看聊天记录

1. `weflow_search_sessions(searchType="byName", keyword="名字")` 找到会话
2. 根据 `sessionType` 选择：
   - `private` → `weflow_get_private_messages(talker=username)`
   - `group` → `weflow_get_group_messages(talker=username)`
3. 用 `createTimeText` 和 `content` 向用户复述

### 用户想找某个群但不确定名字

1. `weflow_search_sessions(searchType="byName", keyword="关键词", sessionType="group")` 模糊搜索
2. 列出匹配的群让用户确认

### 用户想知道某人在哪些群里

1. 先通过 `weflow_search_sessions(searchType="byName", keyword="人名")` 拿到该人的 wxid
2. `weflow_search_sessions(searchType="byMember", keyword=wxid)` 搜索包含该成员的群

### 用户想查看某条消息的完整内容（非文本消息）

1. 从消息查询结果中拿到 `localId`
2. `weflow_get_message_details(talker=会话ID, localIds=[localId])`
3. 返回包含完整 XML 的原始数据

### 用户想下载图片/文件

1. 从消息查询结果中找到 `localType` 为 3（图片）/43（视频）/25769803825（文件）的消息
2. 拿到 `localId`
3. `weflow_download_media(talker=会话ID, localIds=[localId])`
4. 不指定 outputDir 时下载到 %TEMP% 根目录，文件名格式 `weflow-media-{localId}-{时间戳}.{扩展名}`
5. 返回的 `savedTo` 字段为完整文件路径

### 用户想搜索特定内容

1. 先找到会话（search_sessions）
2. 用 `keyword` 参数搜索：`weflow_get_private_messages(talker=ID, keyword="关键词")`
3. 可配合 `start`/`end`（yyyyMMdd）收窄时间范围

## 大量数据加载（truncate=false）

当用户需要查看大量聊天记录时，使用 `truncate=false` 将完整结果输出为 JSON 文件，**不要将大量消息直接加载到上下文中**。

### 使用方式

1. 调用消息查询工具，设 `truncate=false`，可选设 `limit=10000` 拉取全量
2. 工具返回 `outputFile` 路径（默认在 %TEMP% 根目录，文件名格式 `weflow-messages-{talker}-{时间戳}.json`）
3. 用 `read` 工具分段读取该 JSON 文件，或用 `bash` 执行脚本分析
4. 根据内容向用户总结

### 检索脚本 query.py

位于本 SKILL 目录下 `scripts/query.py`，通过 `bash` 工具调用，用于检索 JSON 文件内容，减少上下文开销。**优先使用此脚本，不要自行编写内联 Python 代码。**

```powershell
# 基本统计（消息数、时间范围、类型分布、发言者排行）
python scripts/query.py stats <outputFile路径>

# 提取纯文本对话内容（适合复述聊天记录）
python scripts/query.py texts <outputFile路径> --limit 100
python scripts/query.py texts <outputFile路径> --sender wxid_xxx --keyword 关键词

# 按时间范围过滤（--start/--end 支持 yyyyMMdd 或 yyyy-MM-dd）
python scripts/query.py texts <outputFile路径> --start 20260701 --end 20260729
python scripts/query.py filter <outputFile路径> --type 文本 --start 2026-07-01 --end 2026-07-29

# 按时间分组统计（按天或按小时）
python scripts/query.py timeline <outputFile路径> --by day
python scripts/query.py timeline <outputFile路径> --by hour --start 20260701

# 搜索消息内容（可配合时间范围）
python scripts/query.py search <outputFile路径> --keyword 关键词 --limit 100
python scripts/query.py search <outputFile路径> --keyword 报名 --start 20260601 --end 20260630

# 发言者统计（每人发言数+类型分布）
python scripts/query.py senders <outputFile路径>

# 按类型/发送者过滤消息
python scripts/query.py filter <outputFile路径> --type 文本 --limit 100
python scripts/query.py filter <outputFile路径> --sender wxid_xxx --limit 100
```

根据脚本输出的精简结果，用自然语言向用户总结。不要直接用 `read` 读取整个 JSON 文件。

**若 query.py 无法满足需求，必须自行编写 Python 脚本时**：先用 `write` 工具将代码写入 `%TEMP%\xxx.py`，再 `python %TEMP%\xxx.py` 执行。**禁止内联 `python -c "..."`**，PowerShell 双引号包裹会导致转义错误。

## 截断处理（truncate=true）

消息查询工具有 10KB 输出预算。当返回 `meta.truncated=true` 时，最旧的消息已被丢弃（`meta.dropped` 条），仅保留最新记录。

**必须询问用户**：当前结果因输出限制被截断，是否需要加载更早的消息？

- 用户需要全量 → 改用 `truncate=false` 输出到文件，再用 query.py 分析
- 用户不需要 → 继续后续任务

## 错误处理

工具返回 `success=false` 时，向用户说明错误情况：

| 错误内容 | 应对 |
|----------|------|
| WeFlow 服务不可用 | 提示用户确认 WeFlow 正在运行且已开启 HTTP API |
| 未设置 WEFLOW_API_TOKEN | 提示用户配置环境变量 |
| HTTP 401/403 | Token 无效，提示用户检查配置 |
| HTTP 400 | 参数有误，检查 talker/时间格式后重试 |
| 未找到该消息 | localId 不存在于该会话，确认 localId 来源 |

不要向用户展示原始错误 JSON，用自然语言解释问题。
