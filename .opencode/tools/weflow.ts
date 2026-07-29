import { tool } from "@opencode-ai/plugin"

function getBase(): string {
  const url = process.env.WEFLOW_API_URL || "127.0.0.1"
  const port = process.env.WEFLOW_API_PORT || "5031"
  return `http://${url}:${port}`
}

function getToken(): string | undefined {
  return process.env.WEFLOW_API_TOKEN
}

const MAX_OUTPUT_BYTES = 10240
const HEALTH_ERROR = { success: false, error: "WeFlow 服务不可用，请确认 WeFlow 正在运行且已开启 HTTP API" }
const TOKEN_ERROR = { success: false, error: "未设置 WEFLOW_API_TOKEN 环境变量" }

async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${getBase()}/health`, { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

async function request(path: string, params?: Record<string, any>, timeoutMs = 30000): Promise<any> {
  const token = getToken()
  if (!token) return TOKEN_ERROR

  const url = new URL(path, getBase())
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v))
      }
    }
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const body = await res.text()
      return { success: false, error: `HTTP ${res.status}: ${body.slice(0, 500)}` }
    }
    return await res.json()
  } catch (e: any) {
    return { success: false, error: `网络错误: ${e.message}` }
  }
}

async function guarded(fn: () => Promise<any>): Promise<string> {
  if (!getToken()) return JSON.stringify(TOKEN_ERROR, null, 2)
  const healthy = await healthCheck()
  if (!healthy) return JSON.stringify(HEALTH_ERROR, null, 2)
  try {
    const result = await fn()
    if (result && result.meta) {
      result.meta.currentTime = nowTime()
    } else if (result && result.success !== undefined) {
      result.meta = { currentTime: nowTime() }
    }
    return JSON.stringify(result, null, 2)
  } catch (e: any) {
    return JSON.stringify({ success: false, error: `内部错误: ${e.message}`, meta: { currentTime: nowTime() } }, null, 2)
  }
}

function checkTime(v: string): string | null {
  if (/^\d{8}$/.test(v)) return null
  if (/^\d{10}$/.test(v)) return null
  if (/^\d{13}$/.test(v)) return null
  return `时间格式无效: "${v}"。支持格式: yyyyMMdd（如 20260101）或 Unix 秒/毫秒时间戳`
}

function checkTalker(v: string): string | null {
  if (!v || !v.trim()) return "talker 不能为空"
  if (/[\s?&#]/.test(v)) return `talker 包含非法字符: "${v}"`
  return null
}

function checkChatroomId(v: string): string | null {
  const base = checkTalker(v)
  if (base) return base
  if (!v.endsWith("@chatroom")) return `群聊 ID 必须以 @chatroom 结尾: "${v}"`
  return null
}

function truncateResult(data: any, meta: any): { data: any; meta: any } {
  if (!data.messages || !Array.isArray(data.messages) || data.messages.length === 0) {
    return { data, meta: { ...meta, truncated: false } }
  }

  const messages = [...data.messages]
  const originalCount = messages.length

  while (messages.length > 0) {
    const testData = { ...data, messages, count: messages.length }
    const testMeta = { ...meta, truncated: false }
    const serialized = JSON.stringify({ success: true, data: testData, meta: testMeta }, null, 2)
    const bytes = new TextEncoder().encode(serialized).length

    if (bytes <= MAX_OUTPUT_BYTES) {
      const dropped = originalCount - messages.length
      if (dropped > 0) {
        testMeta.truncated = true
        testMeta.dropped = dropped
        testMeta.range = { from: dropped + 1, to: originalCount }
      }
      return { data: testData, meta: testMeta }
    }
    messages.shift()
  }

  return {
    data: { ...data, messages: [], count: 0 },
    meta: { ...meta, truncated: true, dropped: originalCount, range: { from: 0, to: 0 } },
  }
}

function extractXmlTag(xml: string | undefined | null, tag: string): string | null {
  if (!xml) return null
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)
  const m = xml.match(re)
  return m ? m[1].trim() : null
}

function extractXmlAttr(xml: string | undefined | null, attr: string): string | null {
  if (!xml) return null
  const re = new RegExp(`${attr}="([^"]*)"`)
  const m = xml.match(re)
  return m ? m[1] : null
}

function extractXmlCdata(xml: string | undefined | null, tag: string): string | null {
  if (!xml) return null
  const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`)
  const m = xml.match(re)
  return m ? m[1].trim() : null
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

function formatTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function nowTime(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function nowTimestamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function summarizeMessage(msg: any): any {
  const base: any = {
    localId: msg.localId,
    localType: msg.localType,
    createTime: msg.createTime,
    createTimeText: msg.createTime ? formatTime(msg.createTime) : null,
    isSend: msg.isSend,
    senderUsername: msg.senderUsername,
  }

  const lt = msg.localType
  const c = msg.content || ""
  const rc = msg.rawContent || ""

  switch (lt) {
    case 1:
      return { ...base, typeLabel: "文本", content: c }
    case 3:
      return { ...base, typeLabel: "图片", content: "[图片]" }
    case 34:
      return { ...base, typeLabel: "语音", content: "[语音]" }
    case 43:
      return { ...base, typeLabel: "视频", content: "[视频]" }
    case 47:
      return { ...base, typeLabel: "表情", content: "[表情]" }
    case 48: {
      const label = extractXmlAttr(rc, "label") || extractXmlAttr(c, "label") || ""
      return { ...base, typeLabel: "位置", content: `[位置] ${label}` }
    }
    case 10000:
      return { ...base, typeLabel: "系统提示", content: c }
    case 21474836529: {
      const title = extractXmlTag(c, "title") || extractXmlTag(rc, "title") || ""
      return { ...base, typeLabel: "链接", content: `[链接] ${title}` }
    }
    case 25769803825: {
      const title = extractXmlTag(c, "title") || extractXmlTag(rc, "title") || "未知文件"
      const totallen = extractXmlTag(c, "totallen") || extractXmlTag(rc, "totallen")
      const size = totallen ? ` (${formatSize(parseInt(totallen))})` : ""
      return { ...base, typeLabel: "文件", content: `[文件] ${title}${size}` }
    }
    case 154618822705: {
      const title = extractXmlTag(c, "title") || extractXmlTag(rc, "title") || ""
      return { ...base, typeLabel: "小程序", content: `[小程序] ${title}` }
    }
    case 244813135921: {
      const quoteContent = msg.quote?.content || ""
      const quotePreview = quoteContent.slice(0, 50)
      const title = extractXmlTag(c, "title") || ""
      return { ...base, typeLabel: "引用", content: `[引用] ${quotePreview} → ${title}` }
    }
    case 373662154801: {
      const ann = extractXmlCdata(c, "textannouncement") || extractXmlCdata(rc, "textannouncement") || ""
      return { ...base, typeLabel: "群公告", content: `[群公告] ${ann.slice(0, 100)}` }
    }
    default:
      return { ...base, typeLabel: "其他", content: `[消息类型 ${lt}]` }
  }
}

async function fetchMessages(
  talker: string,
  limit: number,
  offset: number,
  keyword?: string,
  start?: string,
  end?: string,
  truncate: boolean = true,
  outputPath?: string,
) {
  const params: Record<string, any> = { talker, limit, offset }
  if (keyword) params.keyword = keyword
  if (start) params.start = start
  if (end) params.end = end

  const res = await request("/api/v1/messages", params)
  if (res.error) return res

  const messages = (res.messages || []).map(summarizeMessage)
  const data = {
    talker: res.talker || talker,
    count: messages.length,
    hasMore: res.hasMore || false,
    messages,
  }

  if (truncate) {
    const { data: truncatedData, meta } = truncateResult(data, {})
    return { success: true, data: truncatedData, meta }
  }

  const timestamp = nowTimestamp()
  const shortTalker = talker.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40)
  const fileName =
    outputPath || `${process.env.TEMP || "C:\\Temp"}\\weflow-messages-${shortTalker}-${timestamp}.json`

  const fullResult = { success: true, data, meta: { truncated: false, currentTime: nowTime() } }
  await Bun.write(fileName, JSON.stringify(fullResult, null, 2))

  return {
    success: true,
    data: {
      talker,
      totalMessages: messages.length,
      hasMore: res.hasMore || false,
      outputFile: fileName,
    },
    meta: { truncated: false },
  }
}

export const search_sessions = tool({
  description:
    "搜索微信会话列表。数据来自本机 WeFlow（微信聊天记录）。支持按名称、会话ID、群成员三种方式搜索，返回匹配的会话基本信息（不含聊天记录），群聊会话附加成员列表。",
  args: {
    searchType: tool.schema
      .enum(["byName", "byId", "byMember"])
      .describe("搜索类型：byName=按名称/备注搜索，byId=按会话ID搜索，byMember=按成员wxid搜索包含该成员的群"),
    keyword: tool.schema.string().describe("搜索关键词（byName: 名称或备注；byId: 会话ID；byMember: 成员wxid）"),
    sessionType: tool.schema
      .enum(["private", "group", "channel"])
      .optional()
      .describe("过滤会话类型：private=私聊，group=群聊，channel=公众号/频道"),
    limit: tool.schema.number().min(1).max(1000).optional().describe("返回上限，默认50"),
  },
  async execute(args) {
    return guarded(async () => {
      const limit = args.limit ?? 50
      const keyword = args.keyword.toLowerCase()

      const res = await request("/api/v1/sessions", { limit: 10000 })
      if (res.error) return res

      let sessions = (res.sessions || []).map((s: any) => ({
        ...s,
        lastTimestampText: s.lastTimestamp ? formatTime(s.lastTimestamp) : null,
      }))

      if (args.sessionType) {
        sessions = sessions.filter((s: any) => s.sessionType === args.sessionType)
      }

      switch (args.searchType) {
        case "byName":
          sessions = sessions.filter(
            (s: any) =>
              (s.username && s.username.toLowerCase().includes(keyword)) ||
              (s.displayName && s.displayName.toLowerCase().includes(keyword)),
          )
          break
        case "byId":
          sessions = sessions.filter((s: any) => s.username && s.username.toLowerCase().includes(keyword))
          break
        case "byMember": {
          const groups = sessions.filter((s: any) => s.sessionType === "group")
          const matched: any[] = []
          for (const group of groups) {
            const gm = await request("/api/v1/group-members", { chatroomId: group.username })
            if (gm.success && gm.members) {
              const has = gm.members.some(
                (m: any) =>
                  (m.wxid && m.wxid.toLowerCase().includes(keyword)) ||
                  (m.displayName && m.displayName.toLowerCase().includes(keyword)) ||
                  (m.nickname && m.nickname.toLowerCase().includes(keyword)) ||
                  (m.remark && m.remark.toLowerCase().includes(keyword)),
              )
              if (has) {
                matched.push({
                  ...group,
                  members: gm.members.map((m: any) => ({
                    wxid: m.wxid,
                    displayName: m.displayName,
                    nickname: m.nickname,
                    remark: m.remark,
                    isOwner: m.isOwner,
                    isFriend: m.isFriend,
                  })),
                })
              }
            }
          }
          sessions = matched
          break
        }
      }

      const total = sessions.length
      sessions = sessions.slice(0, limit)

      if (args.searchType !== "byMember") {
        const enriched: any[] = []
        for (const s of sessions) {
          if (s.sessionType === "group") {
            const gm = await request("/api/v1/group-members", { chatroomId: s.username })
            if (gm.success && gm.members) {
              enriched.push({
                ...s,
                members: gm.members.map((m: any) => ({
                  wxid: m.wxid,
                  displayName: m.displayName,
                  nickname: m.nickname,
                  remark: m.remark,
                  isOwner: m.isOwner,
                  isFriend: m.isFriend,
                })),
              })
            } else {
              enriched.push(s)
            }
          } else {
            enriched.push(s)
          }
        }
        sessions = enriched
      }

      return {
        success: true,
        data: { count: sessions.length, totalMatched: total, sessions },
        meta: { truncated: false },
      }
    })
  },
})

export const get_private_messages = tool({
  description:
    "获取与指定私聊用户的微信聊天记录（摘要形式）。数据来自本机 WeFlow（微信聊天记录）。非文本消息以中文摘要展示（如[图片]、[链接]等），完整原始内容用 weflow_get_message_details 获取。",
  args: {
    talker: tool.schema.string().describe("私聊用户ID（wxid_xxx 或自定义微信号）"),
    limit: tool.schema.number().min(1).max(10000).optional().describe("返回条数，默认50"),
    offset: tool.schema.number().min(0).optional().describe("分页偏移，默认0"),
    keyword: tool.schema.string().optional().describe("全文搜索关键词"),
    start: tool.schema.string().optional().describe("起始时间（yyyyMMdd 或 Unix 秒/毫秒时间戳）"),
    end: tool.schema.string().optional().describe("结束时间（yyyyMMdd 或 Unix 秒/毫秒时间戳）"),
    truncate: tool.schema.boolean().optional().describe("是否截断输出，默认 true。为 false 时将完整结果输出为 JSON 文件到磁盘，返回文件路径"),
    outputPath: tool.schema.string().optional().describe("JSON 输出路径（仅 truncate=false 时生效），默认 %TEMP% 根目录，文件名自动生成"),
  },
  async execute(args) {
    return guarded(async () => {
      const err = checkTalker(args.talker)
      if (err) return { success: false, error: err }
      if (args.start) {
        const e = checkTime(args.start)
        if (e) return { success: false, error: e }
      }
      if (args.end) {
        const e = checkTime(args.end)
        if (e) return { success: false, error: e }
      }

      return fetchMessages(
        args.talker,
        args.limit ?? 50,
        args.offset ?? 0,
        args.keyword,
        args.start,
        args.end,
        args.truncate ?? true,
        args.outputPath,
      )
    })
  },
})

export const get_group_messages = tool({
  description:
    "获取指定微信群聊的聊天记录（摘要形式）。数据来自本机 WeFlow（微信聊天记录）。保留 senderUsername（发言者wxid）以区分发言者。非文本消息以中文摘要展示，完整原始内容用 weflow_get_message_details 获取。",
  args: {
    talker: tool.schema.string().describe("群聊ID（xxx@chatroom）"),
    limit: tool.schema.number().min(1).max(10000).optional().describe("返回条数，默认50"),
    offset: tool.schema.number().min(0).optional().describe("分页偏移，默认0"),
    keyword: tool.schema.string().optional().describe("全文搜索关键词"),
    start: tool.schema.string().optional().describe("起始时间（yyyyMMdd 或 Unix 秒/毫秒时间戳）"),
    end: tool.schema.string().optional().describe("结束时间（yyyyMMdd 或 Unix 秒/毫秒时间戳）"),
    truncate: tool.schema.boolean().optional().describe("是否截断输出，默认 true。为 false 时将完整结果输出为 JSON 文件到磁盘，返回文件路径"),
    outputPath: tool.schema.string().optional().describe("JSON 输出路径（仅 truncate=false 时生效），默认 %TEMP% 根目录，文件名自动生成"),
  },
  async execute(args) {
    return guarded(async () => {
      const err = checkChatroomId(args.talker)
      if (err) return { success: false, error: err }
      if (args.start) {
        const e = checkTime(args.start)
        if (e) return { success: false, error: e }
      }
      if (args.end) {
        const e = checkTime(args.end)
        if (e) return { success: false, error: e }
      }

      return fetchMessages(
        args.talker,
        args.limit ?? 50,
        args.offset ?? 0,
        args.keyword,
        args.start,
        args.end,
        args.truncate ?? true,
        args.outputPath,
      )
    })
  },
})

export const get_message_details = tool({
  description:
    "获取指定微信消息的完整原始数据（含XML content、rawContent等全部字段）。数据来自本机 WeFlow（微信聊天记录）。用于查看消息查询工具中摘要消息的完整内容。",
  args: {
    talker: tool.schema.string().describe("会话ID（wxid_xxx 或 xxx@chatroom）"),
    localIds: tool.schema.array(tool.schema.number()).describe("消息localId列表（单条时传入[id]）"),
  },
  async execute(args) {
    return guarded(async () => {
      const err = checkTalker(args.talker)
      if (err) return { success: false, error: err }
      if (!args.localIds || args.localIds.length === 0) {
        return { success: false, error: "localIds 不能为空" }
      }

      const res = await request("/api/v1/messages", { talker: args.talker, limit: 10000 })
      if (res.error) return res

      const idSet = new Set(args.localIds)
      const matched = (res.messages || [])
        .filter((m: any) => idSet.has(m.localId))
        .map((m: any) => ({
          ...m,
          createTimeText: m.createTime ? formatTime(m.createTime) : null,
        }))

      return {
        success: true,
        data: {
          talker: args.talker,
          requested: args.localIds.length,
          found: matched.length,
          messages: matched,
        },
        meta: { truncated: false },
      }
    })
  },
})

export const download_media = tool({
  description:
    "下载指定微信消息中的媒体文件到本地。数据来自本机 WeFlow（微信聊天记录）。触发服务端导出后同步下载，首次调用可能较慢。支持批量下载（localIds数组），单条时传入[id]。注意：会在本地磁盘写入文件。",
  args: {
    talker: tool.schema.string().describe("会话ID（wxid_xxx 或 xxx@chatroom）"),
    localIds: tool.schema.array(tool.schema.number()).describe("消息localId列表（单条时传入[id]）"),
    outputDir: tool.schema.string().optional().describe("下载保存目录，默认 %TEMP% 根目录"),
  },
  async execute(args) {
    return guarded(async () => {
      const err = checkTalker(args.talker)
      if (err) return { success: false, error: err }
      if (!args.localIds || args.localIds.length === 0) {
        return { success: false, error: "localIds 不能为空" }
      }

      const outputDir = args.outputDir || process.env.TEMP || "C:\\Temp"

      const res = await request("/api/v1/messages", { talker: args.talker, limit: 10000, media: "true" }, 120000)
      if (res.error) return res

      const idSet = new Set(args.localIds)
      const matched = (res.messages || []).filter((m: any) => idSet.has(m.localId))

      try {
        const { mkdirSync } = await import("node:fs")
        mkdirSync(outputDir, { recursive: true })
      } catch {}

      const results: any[] = []
      for (const msg of matched) {
        if (!msg.mediaUrl) {
          results.push({ localId: msg.localId, success: false, error: "该消息无媒体文件" })
          continue
        }

        try {
          const origName = msg.mediaFileName || `${msg.localId}_media`
          const ext = origName.includes(".") ? origName.split(".").pop() : "bin"
          const fileName = `weflow-media-${msg.localId}-${nowTimestamp()}.${ext}`
          const mediaRes = await fetch(msg.mediaUrl, {
            headers: { Authorization: `Bearer ${getToken()}` },
            signal: AbortSignal.timeout(60000),
          })

          if (!mediaRes.ok) {
            results.push({ localId: msg.localId, success: false, error: `下载失败: HTTP ${mediaRes.status}` })
            continue
          }

          const buffer = await mediaRes.arrayBuffer()
          const filePath = `${outputDir}\\${fileName}`
          await Bun.write(filePath, buffer)

          results.push({
            localId: msg.localId,
            success: true,
            mediaType: msg.mediaType || "unknown",
            mediaFileName: fileName,
            savedTo: filePath,
          })
        } catch (e: any) {
          results.push({ localId: msg.localId, success: false, error: `下载异常: ${e.message}` })
        }
      }

      const matchedIds = new Set(matched.map((m: any) => m.localId))
      for (const id of args.localIds) {
        if (!matchedIds.has(id)) {
          results.push({ localId: id, success: false, error: "未找到该消息" })
        }
      }

      return {
        success: true,
        data: { results },
        meta: { truncated: false },
      }
    })
  },
})
