import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// 配置：~/.config/weflow/config.json（Windows 为 %USERPROFILE%\.config\weflow\config.json）
// 仅配置文件方式，支持 WEFLOW_CONFIG 覆盖路径
// ---------------------------------------------------------------------------

interface WeFlowConfig {
  apiUrl: string
  token: string
  outputDir: string
  mediaDir: string
}

function configFilePath(): string {
  return process.env.WEFLOW_CONFIG || path.join(homedir(), ".config", "weflow", "config.json")
}

async function loadConfig(): Promise<WeFlowConfig> {
  const p = configFilePath()
  let raw: any
  try {
    raw = JSON.parse(await readFile(p, "utf8"))
  } catch (e: any) {
    throw new Error(`无法读取配置文件 ${p}（${e.message}）。请创建该文件并填写 apiUrl 与 token`)
  }
  if (!raw || typeof raw !== "object") throw new Error(`配置文件 ${p} 格式错误：应为 JSON 对象`)
  if (typeof raw.apiUrl !== "string" || !raw.apiUrl.trim()) throw new Error(`配置文件 ${p} 缺少必填字段 apiUrl`)
  if (typeof raw.token !== "string" || !raw.token.trim()) throw new Error(`配置文件 ${p} 缺少必填字段 token`)
  return {
    apiUrl: raw.apiUrl.trim().replace(/\/+$/, ""),
    token: raw.token.trim(),
    outputDir: typeof raw.outputDir === "string" && raw.outputDir.trim() ? raw.outputDir.trim() : "/tmp/weflow/exports",
    mediaDir: typeof raw.mediaDir === "string" && raw.mediaDir.trim() ? raw.mediaDir.trim() : "/tmp/weflow/media",
  }
}

// ---------------------------------------------------------------------------
// HTTP 客户端（无缓存：每次调用实时请求）
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60000

async function apiGet(
  pathname: string,
  params: Record<string, any> = {},
  abort?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<any> {
  const cfg = await loadConfig()
  const url = new URL(cfg.apiUrl + pathname)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v))
  }
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (abort) signals.push(abort)
  let res: Response
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.any(signals),
    })
  } catch (e: any) {
    if (abort?.aborted) throw new Error("请求已取消")
    if (e?.name === "TimeoutError") throw new Error(`WeFlow API 请求超时（${timeoutMs}ms），请缩小查询范围或稍后重试`)
    throw new Error(
      `WeFlow 服务不可达（${cfg.apiUrl}）：请确认 Windows 侧 WeFlow 正在运行、已开启 HTTP API 且网络可达，然后重试`,
    )
  }
  if (res.status === 401) {
    throw new Error(`WeFlow API 拒绝访问（401）：token 无效，请检查配置文件 ${configFilePath()} 中的 token`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`WeFlow API 返回 HTTP ${res.status}：${body.slice(0, 300)}`)
  }
  let data: any
  try {
    data = await res.json()
  } catch {
    throw new Error("WeFlow API 返回了非 JSON 响应")
  }
  if (data && data.success === false) throw new Error(String(data.error || "WeFlow API 返回未知错误"))
  return data
}

async function fetchSessions(abort?: AbortSignal): Promise<any[]> {
  const res = await apiGet("/api/v1/sessions", { limit: 10000 }, abort)
  return Array.isArray(res.sessions) ? res.sessions : []
}

async function fetchContacts(abort?: AbortSignal): Promise<any[]> {
  const res = await apiGet("/api/v1/contacts", { limit: 10000 }, abort)
  return Array.isArray(res.contacts) ? res.contacts : []
}

async function fetchGroupMembers(chatroomId: string, abort?: AbortSignal, forceRefresh = false): Promise<any> {
  return apiGet(
    "/api/v1/group-members",
    { chatroomId, ...(forceRefresh ? { forceRefresh: "true" } : {}) },
    abort,
    120000,
  )
}

async function mapPool<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency = 8): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const run = async () => {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      results[idx] = await worker(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

// ---------------------------------------------------------------------------
// 通用工具函数
// ---------------------------------------------------------------------------

function toInt(v: any): number {
  const n = parseInt(String(v ?? "0"), 10)
  return Number.isNaN(n) ? 0 : n
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

function formatTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function nowTime(): string {
  return formatTime(Math.floor(Date.now() / 1000))
}

function dateStr(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function nowStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60)
}

/** 解析 yyyyMMdd / yyyy-MM-dd / Unix 秒 / Unix 毫秒 → Unix 秒；isEnd 时日期型取当天 23:59:59 */
function parseTimeInput(v: string, isEnd: boolean): number | null {
  const s = v.trim()
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const base = Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000)
    return isEnd ? base + 86399 : base
  }
  if (/^\d{10}$/.test(s)) return +s
  if (/^\d{13}$/.test(s)) return Math.floor(+s / 1000)
  return null
}

function checkSessionId(v: string): string | null {
  if (!v || !v.trim()) return "sessionId 不能为空"
  if (/[\s?&#"']/.test(v)) return `sessionId 包含非法字符: "${v}"`
  return null
}

function sessionTypeOf(username: string): string {
  if (username.endsWith("@chatroom")) return "group"
  if (username.startsWith("gh_") || username.endsWith("@openim")) return "channel"
  return "private"
}

const TYPE_LABELS: Record<string, string> = {
  "1": "文本",
  "3": "图片",
  "34": "语音",
  "42": "名片",
  "43": "视频",
  "47": "表情",
  "48": "位置",
  "49": "小程序",
  "50": "通话",
  "10000": "系统提示",
  "21474836529": "链接",
  "25769803825": "文件",
  "17179869233": "视频分享",
  "154618822705": "小程序",
  "244813135921": "引用",
  "373662154801": "群公告",
  "8594229559345": "红包",
}

function typeLabel(localType: any): string {
  return TYPE_LABELS[String(localType)] ?? `类型${localType}`
}

/** 个别消息的 senderUsername 带尾随空格，统一清理 */
function senderOf(m: any): string | null {
  const s = m?.senderUsername
  if (s === undefined || s === null) return null
  const t = String(s).trim()
  return t || null
}

function xmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`))
  return m ? m[1].trim() : null
}

function xmlAttr(xml: string, attr: string): string | null {
  const m = xml.match(new RegExp(`${attr}="([^"]*)"`))
  return m ? m[1] : null
}

function xmlCdata(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))
  return m ? m[1].trim() : null
}

/** 消息内容归一化：文本保留原文；XML 型消息按类型解析为可读摘要；媒体为中文占位符 */
function messageContent(m: any): string {
  const lt = String(m.localType)
  const c = String(m.content ?? "")
  const raw = String(m.rawContent ?? "")
  if (c.startsWith("[")) return c
  if (c.startsWith("<?xml") || c.startsWith("<msg")) {
    switch (lt) {
      case "48": {
        const label = xmlAttr(c, "label") || xmlAttr(raw, "label")
        return label ? `[位置] ${label}` : "[位置]"
      }
      case "25769803825": {
        const t = xmlTag(c, "title") || xmlTag(raw, "title")
        return t ? `[文件] ${t}` : "[文件]"
      }
      case "21474836529": {
        const t = xmlTag(c, "title") || xmlTag(raw, "title")
        return t ? `[链接] ${t}` : "[链接]"
      }
      case "154618822705": {
        const t = xmlTag(c, "title") || xmlTag(raw, "title")
        return t ? `[小程序] ${t}` : "[小程序]"
      }
      case "373662154801": {
        const a = xmlCdata(c, "textannouncement") || xmlCdata(raw, "textannouncement")
        return a ? `[群公告] ${a.slice(0, 100)}` : "[群公告]"
      }
      case "244813135921": {
        const q = m.quote && m.quote.content ? `${String(m.quote.content).slice(0, 50)} → ` : ""
        const t = xmlTag(c, "title") || ""
        return `[引用] ${q}${t || c.slice(0, 100)}`.trim()
      }
      default:
        return `[${typeLabel(lt)}]`
    }
  }
  if (!c) return `[${typeLabel(lt)}]`
  return c
}

function summarizeMessage(m: any): any {
  const out: any = {
    localId: toInt(m.localId),
    createTime: toInt(m.createTime),
    createTimeText: formatTime(toInt(m.createTime)),
    sender: senderOf(m),
    typeLabel: typeLabel(m.localType),
    content: messageContent(m),
  }
  if (m.isSend !== undefined) out.isSend = m.isSend === 1 || m.isSend === true
  return out
}

/** 构建本页发送者表（群聊查成员名/群昵称，私聊用会话显示名；isSelf 由 API isSend 判定） */
async function buildSenders(
  rows: any[],
  sessionId: string,
  isGroup: boolean,
  displayName: string,
  abort?: AbortSignal,
): Promise<Record<string, any>> {
  const unique = [...new Set(rows.map(senderOf).filter(Boolean))] as string[]
  const selfSet = new Set(rows.filter((m) => m.isSend === 1 || m.isSend === true).map(senderOf))
  let memberMap = new Map<string, any>()
  let contactMap = new Map<string, any>()
  if (isGroup) {
    const [gm, contacts] = await Promise.all([fetchGroupMembers(sessionId, abort), fetchContacts(abort)])
    memberMap = new Map((gm.members || []).map((m: any) => [m.wxid, m]))
    contactMap = new Map(contacts.map((c: any) => [c.username, c]))
  }
  const table: Record<string, any> = {}
  for (const u of unique) {
    const entry: any = {}
    if (selfSet.has(u)) {
      entry.name = "我"
      entry.isSelf = true
    } else if (isGroup) {
      const gm = memberMap.get(u)
      const c = contactMap.get(u)
      entry.name = gm?.displayName || c?.remark || c?.displayName || c?.nickname || u
      if (gm?.groupNickname) entry.groupNickname = gm.groupNickname
    } else {
      entry.name = displayName || u
    }
    table[u] = entry
  }
  return table
}

// ---------------------------------------------------------------------------
// 导出与媒体解析辅助
// ---------------------------------------------------------------------------

const EXPORT_PAGE_SIZE = 2000
const MEDIA_TYPES = new Set([3, 34, 43, 47, 25769803825])

async function fetchAllMessages(
  sessionId: string,
  startTs: number | null,
  endTs: number | null,
  abort?: AbortSignal,
): Promise<any[]> {
  const all: any[] = []
  let offset = 0
  while (true) {
    const params: Record<string, any> = { talker: sessionId, limit: EXPORT_PAGE_SIZE, offset }
    if (startTs !== null) params.start = startTs
    if (endTs !== null) params.end = endTs
    const res = await apiGet("/api/v1/messages", params, abort, 120000)
    const rows = Array.isArray(res.messages) ? res.messages : []
    all.push(...rows)
    if (!res.hasMore || rows.length === 0) break
    offset += rows.length
  }
  return all
}

function decodeEntities(s: string | null): string | null {
  if (s === null) return null
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
}

function parseSpecial(m: any): any | null {
  const lt = String(m.localType)
  const c = String(m.content ?? "")
  const raw = String(m.rawContent ?? "")
  const xml = c.startsWith("<") ? c : raw
  switch (lt) {
    case "48":
      return {
        kind: "location",
        label: decodeEntities(xmlAttr(xml, "label")),
        poiname: decodeEntities(xmlAttr(xml, "poiname")),
        x: xmlAttr(xml, "x"),
        y: xmlAttr(xml, "y"),
      }
    case "25769803825": {
      const total = toInt(xmlTag(xml, "totallen"))
      return {
        kind: "file",
        title: decodeEntities(xmlTag(xml, "title")),
        totalLen: total || null,
        sizeText: total ? formatSize(total) : null,
      }
    }
    case "21474836529":
      return {
        kind: "link",
        title: decodeEntities(xmlTag(xml, "title")),
        des: decodeEntities(xmlTag(xml, "des")),
        url: decodeEntities(xmlTag(xml, "url")),
      }
    case "154618822705":
      return {
        kind: "app",
        title: decodeEntities(xmlTag(xml, "title")),
        des: decodeEntities(xmlTag(xml, "des")),
        url: decodeEntities(xmlTag(xml, "url")),
      }
    case "17179869233":
      return {
        kind: "video-share",
        title: decodeEntities(xmlTag(xml, "title")),
        des: decodeEntities(xmlTag(xml, "des")),
        url: decodeEntities(xmlTag(xml, "url")),
      }
    case "373662154801":
      return { kind: "announcement", text: decodeEntities(xmlCdata(xml, "textannouncement")) }
    case "244813135921":
      return {
        kind: "quote",
        reply: c.startsWith("<") ? decodeEntities(xmlTag(c, "title")) : c,
        quote: m.quote ?? null,
        replyToMessageId: m.replyToMessageId ?? null,
      }
    default:
      return null
  }
}

async function fetchWithSignal(
  url: string,
  cfg: WeFlowConfig,
  abort: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (abort) signals.push(abort)
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.any(signals),
    })
  } catch (e: any) {
    if (abort?.aborted) throw new Error("请求已取消")
    if (e?.name === "TimeoutError") throw new Error(`媒体下载超时（${timeoutMs}ms）`)
    throw new Error(`媒体下载失败：${e.message}`)
  }
}

async function findMessageInWindow(
  sessionId: string,
  localId: number,
  createTime: number,
  abort?: AbortSignal,
): Promise<any | null> {
  const attempts: Array<[number, number, number]> = [
    [createTime - 2, createTime + 2, 100],
    [createTime - 10, createTime + 10, 300],
    [createTime - 60, createTime + 60, 500],
  ]
  for (const [start, end, limit] of attempts) {
    const res = await apiGet(
      "/api/v1/messages",
      {
        talker: sessionId,
        start,
        end,
        limit,
        media: "true",
        image: "true",
        voice: "true",
        video: "true",
        emoji: "true",
      },
      abort,
      120000,
    )
    const found = (res.messages || []).find((m: any) => toInt(m.localId) === localId)
    if (found) return found
  }
  return null
}

async function downloadMedia(
  cfg: WeFlowConfig,
  sessionId: string,
  m: any,
  abort?: AbortSignal,
): Promise<{ file: string; sizeBytes: number }> {
  const url = String(m.mediaUrl).replace(/^https?:\/\/[^/]+/, cfg.apiUrl)
  const res = await fetchWithSignal(url, cfg, abort, 120000)
  if (!res.ok) throw new Error(`媒体下载失败：HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  const dir = path.join(cfg.mediaDir, safeName(sessionId))
  await mkdir(dir, { recursive: true })
  const name = `${toInt(m.localId)}_${path.basename(String(m.mediaFileName || "media.bin"))}`
  const file = path.join(dir, name)
  await writeFile(file, buf)
  return { file, sizeBytes: buf.length }
}

function buildMarkdown(
  sessionId: string,
  displayName: string,
  rows: any[],
  senderInfo: Record<string, any>,
  rangeInfo: string,
): string {
  const lines: string[] = []
  lines.push(`# ${displayName}（${sessionId}）`)
  lines.push("")
  lines.push(`- 导出时间：${nowTime()}`)
  lines.push(`- 消息数：${rows.length}`)
  lines.push(`- 时间范围：${rangeInfo}`)
  lines.push("")
  let day = ""
  for (const m of rows) {
    const ts = toInt(m.createTime)
    const d = dateStr(ts)
    if (d !== day) {
      day = d
      lines.push(`## ${d}`, "")
    }
    const sender = senderInfo[senderOf(m) as string]?.name || senderOf(m) || "(系统)"
    const time = formatTime(ts).slice(11)
    lines.push(`- ${time} ${sender}：${messageContent(m).replace(/\n/g, " ")}`)
  }
  return lines.join("\n") + "\n"
}

function ok(data: any, meta?: any): string {
  return JSON.stringify({ success: true, data, meta: { currentTime: nowTime(), ...(meta || {}) } }, null, 2)
}

function fail(error: string, meta?: any): string {
  return JSON.stringify({ success: false, error, meta: { currentTime: nowTime(), ...(meta || {}) } }, null, 2)
}

const EMPTY_HINT = "结果为空。请确认查询条件与会话 ID 是否正确；若确认应有数据，请稍后重试"
const TOTAL_NOTE = "WeFlow API 不提供消息总数，total/totalPages 恒为 null，请以 hasMore 判断是否还有更早消息"

// ---------------------------------------------------------------------------
// 工具 1：会话查询（模糊 byName / 精确 byId）
// ---------------------------------------------------------------------------

export const search_sessions = tool({
  description:
    "查询微信会话列表（不含聊天记录）。byName 按名称/备注/ID 模糊匹配，byId 按会话 ID 精确匹配。群聊会话附加 memberCount。数据来自 WeFlow 服务，实时读取，不做缓存。",
  args: {
    searchType: tool.schema
      .enum(["byName", "byId"])
      .describe("搜索类型：byName=按名称/备注/ID 模糊查询，byId=按会话 ID 精确查询"),
    keyword: tool.schema.string().describe("搜索关键词（byName: 名称/备注/ID 片段；byId: 完整会话 ID）"),
    sessionType: tool.schema
      .enum(["private", "group", "channel"])
      .optional()
      .describe("过滤会话类型：private=私聊，group=群聊，channel=公众号/企业微信"),
    limit: tool.schema.number().min(1).max(500).optional().describe("返回上限，默认 50"),
  },
  async execute(args, context) {
    try {
      const kw = args.keyword.trim()
      if (!kw) return fail("keyword 不能为空")
      const limit = args.limit ?? 50

      let sessions = await fetchSessions(context.abort)
      if (sessions.length === 0) return fail("未获取到会话列表", { hint: EMPTY_HINT })
      if (args.sessionType) sessions = sessions.filter((s) => s.sessionType === args.sessionType)

      const lower = kw.toLowerCase()
      if (args.searchType === "byId") {
        sessions = sessions.filter((s) => String(s.username || "").toLowerCase() === lower)
      } else {
        sessions = sessions.filter(
          (s) =>
            String(s.username || "").toLowerCase().includes(lower) ||
            String(s.displayName || "").toLowerCase().includes(lower),
        )
      }

      const totalMatched = sessions.length
      let page = sessions.slice(0, limit)

      const groupIds = page.filter((s) => s.sessionType === "group").map((s) => s.username)
      if (groupIds.length > 0) {
        const counts = await mapPool(
          groupIds,
          async (id) => {
            try {
              const gm = await fetchGroupMembers(id, context.abort)
              return toInt(gm.count)
            } catch {
              return null
            }
          },
          8,
        )
        const countMap = new Map(groupIds.map((id, i) => [id, counts[i]]))
        page = page.map((s) =>
          s.sessionType === "group" && countMap.get(s.username) != null ? { ...s, memberCount: countMap.get(s.username) } : s,
        )
      }

      const out = page.map((s) => ({
        username: s.username,
        displayName: s.displayName || s.username,
        sessionType: s.sessionType || sessionTypeOf(String(s.username || "")),
        lastTimestamp: toInt(s.lastTimestamp),
        lastTimestampText: s.lastTimestamp ? formatTime(toInt(s.lastTimestamp)) : null,
        unreadCount: toInt(s.unreadCount),
        ...(s.memberCount != null ? { memberCount: s.memberCount } : {}),
      }))

      return ok(
        { totalMatched, count: out.length, sessions: out },
        out.length === 0 ? { hint: EMPTY_HINT } : undefined,
      )
    } catch (e: any) {
      return fail(e.message)
    }
  },
})

// ---------------------------------------------------------------------------
// 工具 2：按成员找群（全量枚举群成员，无缓存）
// ---------------------------------------------------------------------------

export const find_groups_by_member = tool({
  description:
    "查找指定微信成员所在的群聊。keyword 支持 wxid 或姓名/备注/昵称/群昵称模糊匹配，返回匹配的群及命中的成员。全量枚举群成员，通常需要 8~15 秒。数据来自 WeFlow 服务，每次实时枚举，不做缓存。",
  args: {
    keyword: tool.schema.string().describe("成员标识：wxid（精确）或姓名/备注/昵称/群昵称（模糊）"),
    limit: tool.schema.number().min(1).max(200).optional().describe("群返回上限，默认 50"),
    forceRefresh: tool.schema
      .boolean()
      .optional()
      .describe("是否强制 WeFlow 重新读取群成员数据（默认 false，使用 WeFlow 服务端缓存）"),
  },
  async execute(args, context) {
    try {
      const kw = args.keyword.trim().toLowerCase()
      if (!kw) return fail("keyword 不能为空")
      const limit = args.limit ?? 50
      const force = args.forceRefresh === true
      const t0 = Date.now()

      const sessions = await fetchSessions(context.abort)
      const groups = sessions.filter((s) => s.sessionType === "group")
      let fresh = 0
      let cached = 0
      let failed = 0

      const rows = await mapPool(
        groups,
        async (g) => {
          let gm: any
          try {
            gm = await fetchGroupMembers(g.username, context.abort, force)
          } catch {
            failed++
            return null
          }
          if (gm.fromCache) cached++
          else fresh++
          const matched = (gm.members || []).filter((m: any) =>
            [m.wxid, m.displayName, m.nickname, m.remark, m.alias, m.groupNickname].some(
              (v) => v && String(v).toLowerCase().includes(kw),
            ),
          )
          if (matched.length === 0) return null
          return {
            username: g.username,
            displayName: g.displayName || g.username,
            memberCount: toInt(gm.count),
            matchedMembers: matched.map((m: any) => ({
              username: m.wxid,
              name: m.displayName || m.remark || m.nickname || m.wxid,
              ...(m.groupNickname ? { groupNickname: m.groupNickname } : {}),
            })),
          }
        },
        8,
      )

      let found = rows.filter(Boolean) as any[]
      const totalMatched = found.length
      found = found.slice(0, limit)

      const meta: Record<string, any> = {
        groupsScanned: groups.length,
        elapsedMs: Date.now() - t0,
        groupMembersFresh: fresh,
        groupMembersCached: cached,
      }
      if (failed > 0) {
        meta.groupMembersFailed = failed
        meta.hint = `有 ${failed} 个群的成员数据获取失败，结果可能不完整，请稍后重试`
      }
      if (found.length === 0 && !meta.hint) meta.hint = EMPTY_HINT

      return ok({ totalMatched, count: found.length, groups: found }, meta)
    } catch (e: any) {
      return fail(e.message)
    }
  },
})

// ---------------------------------------------------------------------------
// 工具 3：聊天记录查询（默认 10 条/页，归一化 senders + messages）
// ---------------------------------------------------------------------------

export const get_messages = tool({
  description:
    "按会话 ID 查询微信聊天记录，默认每页 10 条（第 1 页为最新）。返回归一化结构：senders 为发送者信息表，messages 中的 sender 字段引用该表。支持起止时间、关键词、翻页。数据来自 WeFlow 服务，实时读取，不做缓存。",
  args: {
    sessionId: tool.schema.string().describe("会话 ID（wxid_xxx 或 xxx@chatroom）"),
    page: tool.schema.number().min(1).optional().describe("页码，默认 1（第 1 页为最新消息）"),
    pageSize: tool.schema.number().min(1).max(100).optional().describe("每页条数，默认 10，最大 100"),
    start: tool.schema.string().optional().describe("起始时间（yyyyMMdd / yyyy-MM-dd / Unix 秒/毫秒）"),
    end: tool.schema.string().optional().describe("结束时间（同上；日期型含当天全天）"),
    keyword: tool.schema.string().optional().describe("全文搜索关键词（服务端搜索）"),
  },
  async execute(args, context) {
    try {
      const err = checkSessionId(args.sessionId)
      if (err) return fail(err)
      const page = args.page ?? 1
      const pageSize = args.pageSize ?? 10

      let startTs: number | null = null
      let endTs: number | null = null
      if (args.start) {
        startTs = parseTimeInput(args.start, false)
        if (startTs === null) return fail(`start 时间格式无效: "${args.start}"，支持 yyyyMMdd / yyyy-MM-dd / Unix 秒/毫秒`)
      }
      if (args.end) {
        endTs = parseTimeInput(args.end, true)
        if (endTs === null) return fail(`end 时间格式无效: "${args.end}"，支持 yyyyMMdd / yyyy-MM-dd / Unix 秒/毫秒`)
      }

      const params: Record<string, any> = {
        talker: args.sessionId,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }
      if (args.keyword) params.keyword = args.keyword
      if (startTs !== null) params.start = startTs
      if (endTs !== null) params.end = endTs

      const res = await apiGet("/api/v1/messages", params, context.abort)
      const rows = Array.isArray(res.messages) ? res.messages : []
      const messages = rows.map(summarizeMessage)

      const isGroup = args.sessionId.endsWith("@chatroom")
      const sessions = await fetchSessions(context.abort)
      const displayName = sessions.find((s) => s.username === args.sessionId)?.displayName || args.sessionId
      const senders = await buildSenders(rows, args.sessionId, isGroup, displayName, context.abort)

      return ok(
        {
          sessionId: args.sessionId,
          displayName,
          sessionType: sessionTypeOf(args.sessionId),
          page,
          pageSize,
          total: null,
          totalPages: null,
          hasMore: res.hasMore === true,
          count: messages.length,
          senders,
          messages,
        },
        messages.length === 0 ? { hint: EMPTY_HINT, note: TOTAL_NOTE } : { note: TOTAL_NOTE },
      )
    } catch (e: any) {
      return fail(e.message)
    }
  },
})

// ---------------------------------------------------------------------------
// 工具 4：导出聊天（默认全量，输出文件）
// ---------------------------------------------------------------------------

export const export_messages = tool({
  description:
    "导出指定会话的微信聊天记录到本地文件，默认全量导出。format=jsonl 每行一条消息（字段兼容 skills/weflow/scripts/query.py）；format=markdown 生成按日分节的可读文档。可选起止日期收窄范围。返回输出文件路径。数据来自 WeFlow 服务，实时读取，不做缓存。",
  args: {
    sessionId: tool.schema.string().describe("会话 ID（wxid_xxx 或 xxx@chatroom）"),
    format: tool.schema.enum(["jsonl", "markdown"]).optional().describe("导出格式，默认 jsonl"),
    start: tool.schema.string().optional().describe("起始时间（yyyyMMdd / yyyy-MM-dd / Unix 秒/毫秒），默认不限"),
    end: tool.schema.string().optional().describe("结束时间（同上；日期型含当天全天），默认不限"),
    outPath: tool.schema.string().optional().describe("输出文件路径，默认写入配置 outputDir（/tmp/weflow/exports）"),
  },
  async execute(args, context) {
    try {
      const err = checkSessionId(args.sessionId)
      if (err) return fail(err)
      const format = args.format ?? "jsonl"

      let startTs: number | null = null
      let endTs: number | null = null
      if (args.start) {
        startTs = parseTimeInput(args.start, false)
        if (startTs === null) return fail(`start 时间格式无效: "${args.start}"，支持 yyyyMMdd / yyyy-MM-dd / Unix 秒/毫秒`)
      }
      if (args.end) {
        endTs = parseTimeInput(args.end, true)
        if (endTs === null) return fail(`end 时间格式无效: "${args.end}"，支持 yyyyMMdd / yyyy-MM-dd / Unix 秒/毫秒`)
      }

      const cfg = await loadConfig()
      const sessions = await fetchSessions(context.abort)
      const displayName = sessions.find((s) => s.username === args.sessionId)?.displayName || args.sessionId

      let rows = await fetchAllMessages(args.sessionId, startTs, endTs, context.abort)
      rows = rows.filter((m) => {
        const ts = toInt(m.createTime)
        if (startTs !== null && ts < startTs) return false
        if (endTs !== null && ts > endTs) return false
        return true
      })
      rows.reverse()

      const ext = format === "markdown" ? "md" : "jsonl"
      const outPath = args.outPath
        ? path.resolve(context.directory, args.outPath)
        : path.join(cfg.outputDir, `${safeName(args.sessionId)}-${nowStamp()}.${ext}`)
      await mkdir(path.dirname(outPath), { recursive: true })

      let content: string
      if (format === "markdown") {
        const isGroup = args.sessionId.endsWith("@chatroom")
        const senderInfo =
          rows.length > 0 ? await buildSenders(rows, args.sessionId, isGroup, displayName, context.abort) : {}
        const rangeInfo = rows.length
          ? `${formatTime(toInt(rows[0].createTime))} ~ ${formatTime(toInt(rows[rows.length - 1].createTime))}`
          : "无消息"
        content = buildMarkdown(args.sessionId, displayName, rows, senderInfo, rangeInfo)
      } else {
        content =
          rows
            .map((m) =>
              JSON.stringify({
                local_id: toInt(m.localId),
                local_type: toInt(m.localType),
                message_content: messageContent(m),
                create_time: toInt(m.createTime),
                sender_username: senderOf(m),
                is_send: m.isSend === 1 || m.isSend === true ? 1 : 0,
              }),
            )
            .join("\n") + (rows.length ? "\n" : "")
      }
      await writeFile(outPath, content)
      const st = await stat(outPath)

      return ok({
        sessionId: args.sessionId,
        displayName,
        format,
        outputFile: outPath,
        totalMessages: rows.length,
        sizeBytes: st.size,
        sizeText: formatSize(st.size),
        timeRange:
          startTs !== null || endTs !== null
            ? { start: startTs !== null ? formatTime(startTs) : null, end: endTs !== null ? formatTime(endTs) : null }
            : "全部",
      })
    } catch (e: any) {
      return fail(e.message)
    }
  },
})

// ---------------------------------------------------------------------------
// 工具 5：特殊消息解析（媒体落盘 + XML 型语义解析）
// ---------------------------------------------------------------------------

export const resolve_message = tool({
  description:
    "解析微信特殊消息：图片/视频/语音/文件/表情等媒体消息从 WeFlow 导出并下载到本地，返回文件路径；链接/引用/位置/小程序/群公告等解析为可读内容。需提供 createTime（来自 weflow_get_messages）。本地未下载的媒体会返回 not_downloaded 提示。数据来自 WeFlow 服务，实时获取，不做缓存。",
  args: {
    sessionId: tool.schema.string().describe("会话 ID（wxid_xxx 或 xxx@chatroom）"),
    items: tool.schema
      .array(
        tool.schema.object({
          localId: tool.schema.number().describe("消息 localId（来自 weflow_get_messages 返回）"),
          createTime: tool.schema.number().optional().describe("消息 Unix 秒时间戳（必填，来自 weflow_get_messages 返回）"),
        }),
      )
      .describe("待解析消息列表，单条时传入 [{localId: N, createTime: T}]"),
  },
  async execute(args, context) {
    try {
      const err = checkSessionId(args.sessionId)
      if (err) return fail(err)
      if (!args.items || args.items.length === 0) return fail("items 不能为空")

      const cfg = await loadConfig()
      const results: any[] = []

      for (const item of args.items) {
        const localId = toInt(item.localId)
        if (item.createTime === undefined || item.createTime === null) {
          results.push({
            localId,
            status: "missing_createTime",
            hint: "缺少 createTime：请先用 weflow_get_messages 找到该消息，并带上其 createTime 重试",
          })
          continue
        }

        const found = await findMessageInWindow(args.sessionId, localId, toInt(item.createTime), context.abort)
        if (!found) {
          results.push({ localId, status: "not_found", error: "在 createTime 附近未找到该 localId 的消息" })
          continue
        }

        const base: any = {
          localId,
          typeLabel: typeLabel(found.localType),
          createTime: toInt(found.createTime),
          createTimeText: formatTime(toInt(found.createTime)),
          sender: senderOf(found),
        }

        if (MEDIA_TYPES.has(toInt(found.localType))) {
          if (!found.mediaUrl) {
            results.push({
              ...base,
              status: "not_downloaded",
              hint: "WeFlow 未能导出该媒体（微信本地可能尚未下载），请在微信中打开该消息完成下载后重试",
            })
            continue
          }
          try {
            const saved = await downloadMedia(cfg, args.sessionId, found, context.abort)
            results.push({
              ...base,
              status: "ok",
              mediaType: found.mediaType || "unknown",
              fileName: path.basename(saved.file),
              savedTo: saved.file,
              sizeBytes: saved.sizeBytes,
              sizeText: formatSize(saved.sizeBytes),
            })
          } catch (e: any) {
            results.push({ ...base, status: "download_failed", error: e.message })
          }
          continue
        }

        const parsed = parseSpecial(found)
        results.push({
          ...base,
          status: "ok",
          content: messageContent(found),
          ...(parsed ? { parsed } : {}),
        })
      }

      return ok({ sessionId: args.sessionId, requested: args.items.length, results })
    } catch (e: any) {
      return fail(e.message)
    }
  },
})
