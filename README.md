# WeFlow opencode 工具集

将 WeFlow 微信数据服务的 HTTP API 封装为 opencode 自定义工具（custom tools）+ SKILL，支持自然语言查询与分析微信聊天记录、会话、群成员、媒体下载与特殊消息解析。

## 文件结构

```
weflow-tool/
└── .opencode/
   ├── skills/weflow/
   │   ├── SKILL.md          # SKILL 操作指南（场景决策、参数说明、错误处理）
   │   └── scripts/query.py  # 导出 jsonl 检索脚本（大规模数据分析）
   └── tools/weflow.ts       # 5 个自定义工具实现
```

## 依赖

- **WeFlow 服务**：必须运行且已开启 HTTP API（工具通过其 HTTP API 实时读取，**不做任何缓存**）
- **配置文件**：`~/.config/weflow/config.json`（Windows：`%USERPROFILE%\.config\weflow\config.json`）
- **opencode**：支持 custom tools 与 skills

## 配置文件

```json
{
  "apiUrl": "http://192.168.24.102:5031",
  "token": "<WeFlow HTTP API token>",
  "outputDir": "/tmp/weflow/exports",
  "mediaDir": "/tmp/weflow/media"
}
```

`apiUrl`、`token` 必填；`outputDir`、`mediaDir` 可省略。文件建议权限 600。

## 部署方式

### 全局部署（推荐）

将文件复制到 opencode 全局配置目录：

```bash
# 工具
cp .opencode/tools/weflow.ts ~/.config/opencode/tools/weflow.ts

# SKILL
mkdir -p ~/.config/opencode/skills
cp -r .opencode/skills/weflow ~/.config/opencode/skills/weflow
```

Windows 对应路径为 `%USERPROFILE%\.config\opencode\tools\weflow.ts` 与 `%USERPROFILE%\.config\opencode\skills\weflow\`。

### 项目级部署

直接在项目根目录创建 `.opencode/` 并放入对应文件即可。

## 工具列表

| 工具 | 说明 |
|------|------|
| `weflow_search_sessions` | 按名称/ID 搜索会话（群聊附成员数） |
| `weflow_find_groups_by_member` | 查找成员所在的群（全量枚举群成员，约 8~15 秒） |
| `weflow_get_messages` | 查询聊天记录（分页/时间窗/关键词，senders 两段式） |
| `weflow_export_messages` | 导出聊天到 jsonl / markdown 文件 |
| `weflow_resolve_message` | 媒体下载与特殊消息（链接/引用/位置/小程序/群公告）解析 |

## 使用方法

直接用自然语言描述需求：

| 场景 | 示例 |
|------|------|
| 搜索联系人 | "帮我找一下张三的微信" |
| 查看私聊 | "李四这个月找我聊了些什么？" |
| 群聊分析 | "分析一下某技术群的聊天记录" |
| 按成员找群 | "看看秦凯在哪些群里" |
| 下载图片 | "把张三发我的图片下载下来" |
| 查看特殊消息 | "看看那条链接消息的完整内容" |

## 注意事项

- **服务不可达**：工具返回明确错误，需用户在 WeFlow 所在机器上手动启动 WeFlow 并开启 HTTP API
- **无消息总数**：API 不提供消息总数，`total`/`totalPages` 恒为 `null`，以 `hasMore` 判断
- **媒体未下载**：微信本地未下载的媒体返回 `not_downloaded`，需在微信中打开该消息后重试
- **媒体输出目录**：`mediaDir`，每次重新下载并覆盖同名文件
- 禁止内联 `python3 -c "..."`，自行编写脚本须先写入 `/tmp/xxx.py` 再执行

## query.py 脚本

大规模数据分析时，SKILL 会指导使用 `scripts/query.py`：

```bash
python3 ~/.config/opencode/skills/weflow/scripts/query.py stats <导出文件>
python3 ~/.config/opencode/skills/weflow/scripts/query.py texts <导出文件> --limit 100 --start 20260701
python3 ~/.config/opencode/skills/weflow/scripts/query.py timeline <导出文件> --by day
python3 ~/.config/opencode/skills/weflow/scripts/query.py search <导出文件> --keyword 关键词
python3 ~/.config/opencode/skills/weflow/scripts/query.py senders <导出文件>
python3 ~/.config/opencode/skills/weflow/scripts/query.py filter <导出文件> --type 文本 --limit 100
```

## 致谢

**[WeFlow](https://github.com/hicccc77/WeFlow)**
