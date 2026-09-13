#!/usr/bin/env python3
"""query.py — weflow 导出 jsonl 检索脚本

分析 weflow_export_messages 导出的 jsonl 文件（每行一条消息，
字段：local_id, local_type, message_content, create_time, sender_username 等）。

用法：
  python3 query.py stats <file>
  python3 query.py texts <file> [--limit N] [--sender WXID] [--keyword KW] [--start D] [--end D]
  python3 query.py timeline <file> [--by day|hour] [--start D] [--end D]
  python3 query.py search <file> --keyword KW [--limit N] [--start D] [--end D]
  python3 query.py senders <file>
  python3 query.py filter <file> [--type 标签] [--sender WXID] [--limit N]

--start/--end 支持 yyyyMMdd 或 yyyy-MM-dd（end 含当天全天）。
"""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime

TYPE_LABELS = {
    "1": "文本", "3": "图片", "34": "语音", "42": "名片", "43": "视频",
    "47": "表情", "48": "位置", "49": "小程序", "50": "通话", "10000": "系统提示",
    "21474836529": "链接", "25769803825": "文件", "154618822705": "小程序",
    "17179869233": "视频号", "244813135921": "引用", "373662154801": "群公告",
    "8594229559345": "红包",
}


def parse_day(s):
    """yyyyMMdd / yyyy-MM-dd → 当日 00:00:00 的 Unix 秒"""
    s = s.strip()
    for fmt in ("%Y%m%d", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(s, fmt).timestamp())
        except ValueError:
            pass
    # 也接受 Unix 秒
    if s.isdigit() and len(s) == 10:
        return int(s)
    raise SystemExit(f"时间格式无效: {s}（支持 yyyyMMdd / yyyy-MM-dd / Unix 秒）")


def load(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def ts(m):
    try:
        return int(m.get("create_time") or 0)
    except (TypeError, ValueError):
        return 0


def label(m):
    return TYPE_LABELS.get(str(m.get("local_type")), f"类型{m.get('local_type')}")


def content_of(m):
    lt = str(m.get("local_type"))
    c = str(m.get("message_content") or "")
    if lt in ("1", "10000", "50"):
        return c
    if c and not c.startswith("[") and ("/" in c or "\\" in c):
        return c  # 媒体已落盘：内容为文件路径
    return c if c.startswith("[") else f"[{label(m)}]"


def apply_window(rows, start, end):
    if start:
        s = parse_day(start)
        rows = [m for m in rows if ts(m) >= s]
    if end:
        e = parse_day(end) + 86399
        rows = [m for m in rows if ts(m) <= e]
    return rows


def fmt_time(t):
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")


def cmd_stats(rows, _args):
    if not rows:
        print("空文件")
        return
    times = [ts(m) for m in rows if ts(m)]
    print(f"消息总数: {len(rows)}")
    if times:
        print(f"时间范围: {fmt_time(min(times))} ~ {fmt_time(max(times))}")
    print("\n类型分布:")
    for t, n in Counter(label(m) for m in rows).most_common():
        print(f"  {t}: {n}")
    print("\n发言者 TOP 10:")
    for s, n in Counter(m.get("sender_username") or "(系统)" for m in rows).most_common(10):
        print(f"  {s}: {n}")


def cmd_texts(rows, args):
    rows = [m for m in rows if str(m.get("local_type")) in ("1", "10000", "50")]
    rows = apply_window(rows, args.start, args.end)
    if args.sender:
        rows = [m for m in rows if m.get("sender_username") == args.sender]
    if args.keyword:
        rows = [m for m in rows if args.keyword in str(m.get("message_content") or "")]
    rows = sorted(rows, key=ts)
    for m in rows[: args.limit]:
        print(f"[{fmt_time(ts(m))}] {m.get('sender_username') or '(系统)'}: {content_of(m)}")
    print(f"\n共 {len(rows)} 条匹配，显示前 {min(len(rows), args.limit)} 条")


def cmd_timeline(rows, args):
    rows = apply_window(rows, args.start, args.end)
    fmt = "%Y-%m-%d" if args.by == "day" else "%Y-%m-%d %H:00"
    for k, n in sorted(Counter(datetime.fromtimestamp(ts(m)).strftime(fmt) for m in rows if ts(m)).items()):
        print(f"{k}: {n}")


def cmd_search(rows, args):
    rows = apply_window(rows, args.start, args.end)
    rows = [m for m in rows if args.keyword in str(m.get("message_content") or "")]
    rows = sorted(rows, key=ts)
    for m in rows[: args.limit]:
        print(f"[{fmt_time(ts(m))}] {m.get('sender_username') or '(系统)'} ({label(m)}): {content_of(m)[:200]}")
    print(f"\n共 {len(rows)} 条匹配，显示前 {min(len(rows), args.limit)} 条")


def cmd_senders(rows, _args):
    groups = {}
    for m in rows:
        groups.setdefault(m.get("sender_username") or "(系统)", Counter())[label(m)] += 1
    for s, c in sorted(groups.items(), key=lambda kv: -sum(kv[1].values())):
        detail = ", ".join(f"{t}:{n}" for t, n in c.most_common())
        print(f"{s}: 共{sum(c.values())} 条 ({detail})")


def cmd_filter(rows, args):
    rows = apply_window(rows, args.start, args.end)
    if args.type:
        rows = [m for m in rows if label(m) == args.type]
    if args.sender:
        rows = [m for m in rows if m.get("sender_username") == args.sender]
    rows = sorted(rows, key=ts)
    for m in rows[: args.limit]:
        print(f"[{fmt_time(ts(m))}] {m.get('sender_username') or '(系统)'} ({label(m)}): {content_of(m)[:200]}")
    print(f"\n共 {len(rows)} 条匹配，显示前 {min(len(rows), args.limit)} 条")


def main():
    p = argparse.ArgumentParser(description="weflow 导出 jsonl 文件检索")
    p.add_argument("command", choices=["stats", "texts", "timeline", "search", "senders", "filter"])
    p.add_argument("file")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--sender")
    p.add_argument("--keyword")
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--by", choices=["day", "hour"], default="day")
    p.add_argument("--type")
    args = p.parse_args()

    rows = load(args.file)
    {
        "stats": cmd_stats,
        "texts": cmd_texts,
        "timeline": cmd_timeline,
        "search": cmd_search,
        "senders": cmd_senders,
        "filter": cmd_filter,
    }[args.command](rows, args)


if __name__ == "__main__":
    main()
