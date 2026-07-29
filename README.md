# WeFlow opencode 工具集

将本机 WeFlow 微信数据服务封装为 opencode 自定义工具（custom tools）+ SKILL，支持自然语言查询与分析微信聊天记录、会话与群成员。

## 文件结构

```
weflow-tool/
└── .opencode/
   ├── skills/weflow/
   │   ├── SKILL.md          # SKILL 操作指南（场景决策、参数说明、错误处理）
   │   └── scripts/query.py  # JSON 检索脚本（大规模数据分析）
   └── tools/weflow.ts       # 5 个自定义工具实现
```

## 依赖

- **WeFlow 服务**：本机运行中（默认 `127.0.0.1:5031`）
- **环境变量**：`WEFLOW_API_TOKEN`、`WEFLOW_API_PORT`、`WEFLOW_API_URL`
- **opencode**：支持 custom tools 与 skills

## 部署方式

### 全局部署（推荐）

将文件复制到 opencode 全局配置目录：

```powershell
# 工具
Copy-Item ".opencode\tools\weflow.ts" "$env:USERPROFILE\.config\opencode\tools\weflow.ts"

# SKILL
Copy-Item -Recurse ".opencode\skills\weflow" "$env:USERPROFILE\.agents\skills\weflow"

# 脚本指引规则
# 已内置在 $env:USERPROFILE\.config\opencode\rules\weflow.md
```

### 项目级部署

直接在项目根目录创建 `.opencode/` 并放入对应文件即可。

## 使用方法

直接用自然语言描述需求：

| 场景 | 示例 |
|------|------|
| 搜索联系人 | "帮我找一下张三的微信" |
| 查看私聊 | "李四这个月找我聊了些什么？" |
| 群聊分析 | "分析一下某技术群的聊天记录" |
| 下载图片 | "把张三发我的图片下载下来" |
| 查看原始消息 | "看看那条链接消息的完整内容" |

## 工具列表

| 工具 | 说明 |
|------|------|
| `weflow_search_sessions` | 按名称/ID/成员搜索会话 |
| `weflow_get_private_messages` | 获取私聊消息记录 |
| `weflow_get_group_messages` | 获取群聊消息记录 |
| `weflow_get_message_details` | 获取消息完整原始数据 |
| `weflow_download_media` | 下载消息中的媒体文件 |

## query.py 脚本

大规模数据分析时，SKILL 会指导使用 `scripts/query.py`：

```powershell
python scripts/query.py stats <outputFile路径>
python scripts/query.py texts <outputFile路径> --limit 100 --start 20260701
python scripts/query.py timeline <outputFile路径> --by day
python scripts/query.py search <outputFile路径> --keyword 关键词
python scripts/query.py senders <outputFile路径>
python scripts/query.py filter <outputFile路径> --type 文本 --limit 100
```

## 注意事项

- 消息返回有 10KB 截断预算，超限时从头部丢弃最旧消息；`truncate=false` 可输出完整 JSON 到 `%TEMP%`
- 媒体下载默认保存到 `%TEMP%`，文件名格式 `weflow-media-{localId}-{时间戳}.{ext}`
- 禁止内联 `python -c`，自行编写脚本须先写入 `%TEMP%\xxx.py` 再执行

## 后记

~~要不是10分钟内直接把我KIMI的5h用量干爆，我也不会弄这么个玩意出来~~


## 致谢
**[WeFlow](https://github.com/hicccc77/WeFlow)**