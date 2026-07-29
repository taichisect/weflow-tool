"""weflow 消息 JSON 检索脚本。用法: python query.py <命令> <json文件> [选项]"""

import json
import sys
import os
from collections import Counter, defaultdict
from datetime import datetime


def get_time_text(m):
    t = m.get("createTimeText")
    if t:
        return t
    ts = m.get("createTime")
    if ts:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    return ""


def load(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        raw = json.load(f)
    if isinstance(raw, dict) and "data" in raw:
        return raw["data"].get("messages", [])
    if isinstance(raw, list):
        return raw
    return []


def normalize_date(v):
    v = v.strip().replace("-", "")
    if len(v) == 8 and v.isdigit():
        return f"{v[:4]}-{v[4:6]}-{v[6:]}"
    return v


def time_in_range(m, start=None, end=None):
    t = get_time_text(m)
    if not t:
        return True
    if start and t < start:
        return False
    if end:
        end_full = end + " 23:59:59" if len(end) == 10 else end
        if t > end_full:
            return False
    return True


def apply_common(msgs, sender=None, start=None, end=None):
    r = msgs
    if sender:
        r = [m for m in r if m.get("senderUsername") == sender]
    if start:
        start = normalize_date(start)
        r = [m for m in r if get_time_text(m) >= start]
    if end:
        end = normalize_date(end)
        end_full = end + " 23:59:59" if len(end) == 10 else end
        r = [m for m in r if get_time_text(m) <= end_full]
    return r


def parse_args(argv):
    kw = {}
    i = 0
    while i < len(argv):
        if argv[i] == "--sender" and i + 1 < len(argv):
            kw["sender"] = argv[i + 1]; i += 2
        elif argv[i] == "--keyword" and i + 1 < len(argv):
            kw["keyword"] = argv[i + 1]; i += 2
        elif argv[i] == "--by" and i + 1 < len(argv):
            kw["by"] = argv[i + 1]; i += 2
        elif argv[i] == "--limit" and i + 1 < len(argv):
            kw["limit"] = int(argv[i + 1]); i += 2
        elif argv[i] == "--type" and i + 1 < len(argv):
            kw["type"] = argv[i + 1]; i += 2
        elif argv[i] == "--start" and i + 1 < len(argv):
            kw["start"] = argv[i + 1]; i += 2
        elif argv[i] == "--end" and i + 1 < len(argv):
            kw["end"] = argv[i + 1]; i += 2
        else:
            i += 1
    return kw


def cmd_stats(msgs, **kw):
    if not msgs:
        print("无消息数据"); return
    types = Counter(m.get("typeLabel", "?") for m in msgs)
    senders = Counter(m.get("senderUsername") or "系统" for m in msgs)
    print(f"消息总数: {len(msgs)}")
    print(f"时间范围: {msgs[-1].get('createTimeText','?')} ~ {msgs[0].get('createTimeText','?')}")
    print(f"\n类型分布:")
    for t, c in types.most_common():
        print(f"  {t}: {c}")
    print(f"\n发言者 TOP 20:")
    for s, c in senders.most_common(20):
        print(f"  {s}: {c}")


def cmd_texts(msgs, sender=None, keyword=None, start=None, end=None, limit=50, **kw):
    r = [m for m in msgs if m.get("localType") == 1]
    r = apply_common(r, sender=sender, start=start, end=end)
    if keyword:
        r = [m for m in r if keyword.lower() in (m.get("content") or "").lower()]
    print(f"文本消息: {len(r)} 条（显示前 {limit} 条）\n")
    for m in r[:limit]:
        print(f"[{m.get('createTimeText','?')}] {m.get('senderUsername') or '系统'}: {m.get('content','')}")


def cmd_timeline(msgs, by="day", start=None, end=None, **kw):
    msgs = apply_common(msgs, start=start, end=end)
    groups = defaultdict(list)
    for m in msgs:
        t = get_time_text(m)
        if not t: continue
        key = t[:10] if by == "day" else t[:13] + ":00"
        groups[key].append(m)
    print(f"按{'天' if by == 'day' else '小时'}分组:\n")
    for key in sorted(groups.keys()):
        ms = groups[key]
        types = Counter(m.get("typeLabel", "?") for m in ms)
        top = ", ".join(f"{t}:{c}" for t, c in types.most_common(3))
        print(f"  {key}  ({len(ms)}条)  {top}")


def cmd_search(msgs, keyword=None, sender=None, start=None, end=None, limit=50, **kw):
    if not keyword:
        print("缺少 --keyword 参数"); return
    r = [m for m in msgs if keyword.lower() in (m.get("content") or "").lower()]
    r = apply_common(r, sender=sender, start=start, end=end)
    print(f"搜索 \"{keyword}\": {len(r)} 条匹配（显示前 {limit} 条）\n")
    for m in r[:limit]:
        c = (m.get("content") or "")[:200]
        print(f"[{m.get('createTimeText','?')}] [{m.get('typeLabel','?')}] {m.get('senderUsername') or '系统'}: {c}")


def cmd_senders(msgs, start=None, end=None, **kw):
    msgs = apply_common(msgs, start=start, end=end)
    senders = Counter(m.get("senderUsername") or "系统" for m in msgs)
    print(f"发言者统计（共 {len(senders)} 人）:\n")
    for s, c in senders.most_common():
        types = Counter(m.get("typeLabel", "?") for m in msgs if (m.get("senderUsername") or "系统") == s)
        top = ", ".join(f"{t}:{n}" for t, n in types.most_common(3))
        print(f"  {s}: {c} 条  ({top})")


def cmd_filter(msgs, type=None, sender=None, start=None, end=None, limit=50, **kw):
    r = msgs
    if type:
        r = [m for m in r if m.get("typeLabel") == type]
    r = apply_common(r, sender=sender, start=start, end=end)
    print(f"过滤结果: {len(r)} 条（显示前 {limit} 条）\n")
    for m in r[:limit]:
        c = (m.get("content") or "")[:200]
        print(f"[{m.get('createTimeText','?')}] [{m.get('typeLabel','?')}] {m.get('senderUsername') or '系统'}: {c}")


CMDS = {
    "stats": cmd_stats,
    "texts": cmd_texts,
    "timeline": cmd_timeline,
    "search": cmd_search,
    "senders": cmd_senders,
    "filter": cmd_filter,
}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        print("命令: stats / texts / timeline / search / senders / filter")
        print("选项: --sender <wxid>  --keyword <词>  --by day|hour  --limit <N>  --type <类型标签>")
        print("      --start <日期>  --end <日期>  （格式: yyyyMMdd 或 yyyy-MM-dd）")
        sys.exit(1)
    cmd, path = sys.argv[1], sys.argv[2]
    if not os.path.exists(path):
        print(f"文件不存在: {path}"); sys.exit(1)
    fn = CMDS.get(cmd)
    if not fn:
        print(f"未知命令: {cmd}"); sys.exit(1)
    fn(load(path), **parse_args(sys.argv[3:]))


if __name__ == "__main__":
    main()
