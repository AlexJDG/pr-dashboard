#!/usr/bin/env python3
"""Serve a self-refreshing dashboard of open PRs and the Kodiak merge queue. Requires an authenticated `gh`."""
import html
import json
import os
import re
import subprocess
import urllib.parse
import sys
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = "owner/repo"
REFRESH_SECONDS = 15
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
VERSION = str(os.path.getmtime(__file__))
# Exit once no page has polled for this long; > 60s because Chrome throttles hidden pages' timers to once a minute
IDLE_EXIT_SECONDS = int(os.environ.get("IDLE_EXIT_SECONDS", 0))
last_poll = time.monotonic()


def labels(pr):
    return {l["name"] for l in pr["labels"]}


KODIAK_APP_ID = 29196
# ponytail: first 100 open PRs only; paginate if the repo ever has more
QUERY = """
query($q: String!) {
  rateLimit { cost limit remaining resetAt }
  viewer { login }
  search(query: $q, type: ISSUE, first: 100) {
    nodes { ... on PullRequest {
      number title url createdAt updatedAt additions deletions mergeable reviewDecision author { login }
      reviewThreads(first: 100) { nodes { isResolved } }
      labels(first: 10) { nodes { name color } }
      commits(last: 1) { nodes { commit {
        statusCheckRollup { state }
        checkSuites(first: 1, filterBy: {appId: %d}) { nodes { checkRuns(last: 1) { nodes { title } } } }
      } } }
    } }
  }
}""" % KODIAK_APP_ID


def kodiak_status(commit):
    runs = [run["title"] for suite in commit["checkSuites"]["nodes"] for run in suite["checkRuns"]["nodes"]]
    return runs[0] if runs else "no Kodiak status"


def blocked(pr):
    # 🛑 means Kodiak won't merge it, ⚠️ means Kodiak hit an error and isn't processing it
    return pr["kodiak"].startswith(("🛑", "⚠️"))


def graphql(query, **variables):
    args = [arg for k, v in variables.items() for arg in ("-f", f"{k}={v}")]
    out = subprocess.run(
        ["gh", "api", "graphql", "-f", f"query={query}", *args], capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)["data"]


STATS_DAYS = 7
CHART_DAYS = 14
STATS_REFRESH_SECONDS = 300
STATS_QUERY = """
query($q: String!, $merged: String!, $after: String) {
  merged: search(query: $merged, type: ISSUE, first: 1) { issueCount }
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number createdAt mergedAt closedAt author { login }
      reviews(first: 100) { nodes { submittedAt author { login __typename } } }
    } }
  }
}"""


def local_day(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().date()


def review_stats():
    today = datetime.now().astimezone().date()
    review_since = (today - timedelta(days=STATS_DAYS)).isoformat()
    chart_since = today - timedelta(days=CHART_DAYS - 1)
    variables = {
        "q": f"repo:{REPO} is:pr updated:>={chart_since.isoformat()}",
        "merged": f"repo:{REPO} is:pr is:merged merged:>={review_since}",
    }
    reviewed, prs_ = {}, []
    while True:
        result = graphql(STATS_QUERY, **variables)
        for pr in result["search"]["nodes"]:
            prs_.append(pr)
            for review in pr["reviews"]["nodes"]:
                reviewer = review["author"]
                # people only, not bots or the PR author replying on their own PR
                if reviewer and reviewer["__typename"] == "User" and reviewer["login"] != (pr["author"] or {}).get("login") and review["submittedAt"] >= review_since:
                    reviewed.setdefault(reviewer["login"], set()).add(pr["number"])
        page = result["search"]["pageInfo"]
        if not page["hasNextPage"]:
            break
        variables["after"] = page["endCursor"]
    days = [chart_since + timedelta(days=i) for i in range(CHART_DAYS)]
    tally = lambda dates: [sum(d == day for d in dates) for day in days]
    daily = {
        "Opened": tally([local_day(p["createdAt"]) for p in prs_]),
        "Merged": tally([local_day(p["mergedAt"]) for p in prs_ if p["mergedAt"]]),
        "Closed": tally([local_day(p["closedAt"]) for p in prs_ if p["closedAt"] and not p["mergedAt"]]),
    }
    by_dev = sorted(((login, len(numbers)) for login, numbers in reviewed.items()), key=lambda r: (-r[1], r[0].lower()))
    return {"merged": result["merged"]["issueCount"], "merged_search": variables["merged"], "reviews": by_dev, "days": days, "daily": daily}


def rate_limit():
    # Still answers when the budget is spent
    return graphql("{ rateLimit { cost limit remaining resetAt } }")["rateLimit"]


def open_prs():
    result = graphql(QUERY, q=f"repo:{REPO} is:pr {BASE}")
    prs_ = []
    for p in result["search"]["nodes"]:
        commit = p.pop("commits")["nodes"][0]["commit"]
        prs_.append({
            **p,
            "labels": p["labels"]["nodes"],
            "checks": (commit["statusCheckRollup"] or {}).get("state"),
            "unresolved": sum(not t["isResolved"] for t in p.pop("reviewThreads")["nodes"]),
            "kodiak": kodiak_status(commit),
        })
    return prs_, result["rateLimit"], result["viewer"]["login"]


BASE = "is:open draft:false"
FAILING = f"{BASE} status:failure"
# GitHub leaves reviewDecision blank on some PRs that still need an approval, so exclude the decided ones
# rather than matching review:required; -status:failure so PRs with checks still running count
NEEDS_REVIEW = f"{BASE} -author:@me -review:approved -review:changes_requested -status:failure"
QUEUE = f"{BASE} label:automerge -label:stacked"


def pill(label):
    color = label["color"] if re.fullmatch(r"[0-9a-fA-F]{6}", label["color"]) else "888888"
    return f' <span class=label style="background:#{color}33;border-color:#{color}">{html.escape(label["name"])}</span>'


def failing(pr):
    return pr["checks"] in ("FAILURE", "ERROR") or pr["unresolved"] > 0


def unresolved_badge(pr):
    return f" <span class=unresolved>{pr['unresolved']} unresolved</span>" if pr["unresolved"] else ""


AGE_UNITS = [("d", 86400), ("h", 3600), ("m", 60)]


def ago(iso):
    seconds = (datetime.now().astimezone() - datetime.fromisoformat(iso.replace("Z", "+00:00"))).total_seconds()
    return next((f"{int(seconds // size)}{unit}" for unit, size in AGE_UNITS if seconds >= size), "now")


def age_cell(pr):
    return f'<td class=age title="Opened {pr["createdAt"]}, updated {pr["updatedAt"]}">{ago(pr["createdAt"])} / {ago(pr["updatedAt"])}</td>'


def table(prs_, kodiak=False):
    rows = "".join(
        f'<tr style="--i:{i}" data-href="{html.escape(p["url"])}"{" class=blocked" if kodiak and blocked(p) else ""}>'
        f'<td><a href="{html.escape(p["url"])}" target=_blank rel=noopener>#{p["number"]}</a></td>'
        f'<td>{html.escape(p["title"])}{"".join(map(pill, p["labels"]))}{unresolved_badge(p)}</td>'
        f'<td class=diff><span class=add>+{p["additions"]:,}</span> <span class=del>-{p["deletions"]:,}</span></td>'
        f'<td>{html.escape(p["author"]["login"])}</td>{age_cell(p)}'
        + (f'<td>{html.escape(p["kodiak"])}</td>' if kodiak else "") + "</tr>"
        for i, p in enumerate(prs_)
    ) or f"<tr><td colspan={6 if kodiak else 5} class=muted>None</td></tr>"
    return (
        "<table><thead><tr><th>PR</th><th>Title</th><th>Lines</th><th>Author</th><th>Opened / updated</th>"
        + ("<th>Kodiak</th>" if kodiak else "") + f"</tr></thead>{rows}</table>"
    )


def count(key, items):
    if key != "queue":
        return len(items)
    n_blocked = sum(map(blocked, items))
    return f"{len(items) - n_blocked}" + (f" <small>({n_blocked} blocked)</small>" if n_blocked else "")


data, error, next_fetch, rate = None, "", 0.0, None
stats, next_stats = None, 0.0
# Stop polling until the hourly reset rather than drain the budget other gh tools share
MIN_RATE_REMAINING = 500
fetch_lock = threading.Lock()


def reset_time():
    return datetime.fromisoformat(rate["resetAt"].replace("Z", "+00:00")).astimezone()


def fetch():
    # One GitHub query per refresh interval, shared by every open page; keeps the last good data on failure
    global data, error, next_fetch, rate, stats, next_stats
    with fetch_lock:
        if time.time() < next_fetch:
            return
        next_fetch = time.time() + REFRESH_SECONDS - 1
        try:
            prs_, rate, me = open_prs()
        except subprocess.CalledProcessError as e:
            error = e.stderr
            if "rate limit" in e.stderr:
                try:
                    rate = rate_limit()
                except subprocess.CalledProcessError:
                    return
                next_fetch = reset_time().timestamp()
                error = f"GitHub API rate limit hit, pausing until {reset_time():%H:%M}"
            return
        error = ""
        if time.time() >= next_stats:
            next_stats = time.time() + STATS_REFRESH_SECONDS
            try:
                stats = review_stats()
            except subprocess.CalledProcessError as e:
                error = e.stderr
        prs_.sort(key=lambda p: p["updatedAt"], reverse=True)
        if rate["remaining"] < MIN_RATE_REMAINING:
            reset = reset_time()
            next_fetch = reset.timestamp()
            error = f"GitHub API budget low ({rate['remaining']} left), pausing until {reset:%H:%M}"
        has_label = lambda p, name: name in labels(p)
        automerge = [p for p in prs_ if has_label(p, "automerge") and not has_label(p, "stacked")]
        data = (
            prs_,
            # main requires review threads resolved before merging, so unresolved comments block like a failing check
            [p for p in prs_ if failing(p)],
            [
                p for p in prs_
                if p["author"]["login"] != me
                and p["reviewDecision"] not in ("APPROVED", "CHANGES_REQUESTED")
                and not failing(p)
                and p["mergeable"] != "CONFLICTING"
            ],
            # queued first, then mirrors Kodiak's ordering: hotfix first, then oldest
            sorted(automerge, key=lambda p: (blocked(p), not has_label(p, "hotfix"), p["createdAt"])),
        )


STYLE = """
:root {
    --bg: #05070a; --panel: rgba(12, 18, 24, .72); --fg: #d6ffe9; --muted: #5f7a70; --line: #12231d;
    --green: #00ff9c; --cyan: #00e5ff; --red: #ff3860; --amber: #ffb300; --violet: #b388ff;
    --add: var(--green); --hot: var(--red); --c: var(--cyan);
    color-scheme: dark;
}
* { box-sizing: border-box; }
body {
    background:
        radial-gradient(ellipse at top, rgba(0, 229, 255, .08), transparent 60%),
        linear-gradient(rgba(0, 255, 156, .035) 1px, transparent 1px) 0 0 / 32px 32px,
        linear-gradient(90deg, rgba(0, 255, 156, .035) 1px, transparent 1px) 0 0 / 32px 32px,
        var(--bg);
    background-attachment: fixed;
    color: var(--fg); font: 14px/1.5 "JetBrains Mono", ui-monospace, Consolas, monospace;
    max-width: 1100px; margin: 0 auto; padding: 2rem 16px; min-height: 100vh;
}
body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 10;
    background: repeating-linear-gradient(transparent 0 2px, rgba(0, 0, 0, .18) 2px 3px);
}
h1 { font-size: 1.1rem; font-weight: 700; margin: 0 0 1.5rem; letter-spacing: .02em; }
.prompt { color: var(--green); text-shadow: 0 0 8px var(--green); }
.dim, .muted { color: var(--muted); }
.cursor { color: var(--green); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .75rem; }
.tile {
    font: inherit; color: inherit; text-align: left; cursor: pointer; padding: .9rem;
    background: var(--panel); backdrop-filter: blur(6px);
    border: 1px solid var(--line); border-radius: 6px; position: relative; overflow: hidden;
    transition: border-color .2s, box-shadow .2s, transform .2s;
}
.tile::before {
    content: ""; position: absolute; inset: 0 0 auto; height: 2px;
    background: linear-gradient(90deg, transparent, var(--c), transparent); opacity: .5;
}
.tile:hover { border-color: var(--c); transform: translateY(-2px); box-shadow: 0 0 18px -6px var(--c); }
.tile.on { border-color: var(--c); box-shadow: 0 0 24px -4px var(--c), inset 0 0 24px -12px var(--c); }
.tile.on::before { opacity: 1; }
.tile[data-tab=queue] { --c: var(--cyan); }
.tile[data-tab=open] { --c: var(--violet); }
.tile[data-tab=failing] { --c: var(--red); }
.tile[data-tab=conflicts] { --c: var(--amber); }
.tile[data-tab=review] { --c: var(--green); }
.tile[data-tab=other] { --c: var(--muted); }
.tile-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.big {
    display: block; font-size: 2.8rem; font-weight: 800; line-height: 1; margin-top: .4rem;
    color: var(--c); text-shadow: 0 0 12px var(--c);
}
.big small { font-size: 14px; font-weight: 400; color: var(--muted); text-shadow: none; white-space: nowrap; }
.tile.changed .big { animation: flash 1.2s ease-out; }
@keyframes flash {
    0% { color: #ffffff; text-shadow: 0 0 24px #ffffff, 0 0 48px var(--c); transform: scale(1.12); }
    100% { transform: none; }
}

.panels { overflow: hidden; transition: height .3s cubic-bezier(.2, .8, .2, 1); }
h2 { font-size: 1rem; margin: 2rem 0 .75rem; color: var(--fg); }
h2::before { content: "// "; color: var(--muted); }
.gh { font-size: 12px; font-weight: 400; margin-left: .5rem; }
a { color: var(--cyan); text-decoration: none; }
a:hover { text-shadow: 0 0 8px var(--cyan); }

table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
th { white-space: nowrap; color: var(--muted); font-weight: 400; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
td, th { padding: .55rem .75rem; border-bottom: 1px solid var(--line); text-align: left; }
tr:last-child td { border-bottom: 0; }
tr[data-href] { cursor: pointer; transition: background .15s, box-shadow .15s; }
tr[data-href]:hover { background: rgba(0, 229, 255, .06); box-shadow: inset 3px 0 0 var(--cyan); }
tr.blocked { opacity: .5; }
.enter tbody tr { animation: rise .35s ease-out backwards; animation-delay: calc(var(--i, 0) * 35ms); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }

.label { display: inline-block; font-size: 11px; padding: 0 .5em; border: 1px solid; border-radius: 3px; white-space: nowrap; }
.unresolved { font-size: 12px; color: var(--red); white-space: nowrap; }
.age, .diff { white-space: nowrap; color: var(--muted); }
.add { color: var(--green); } .del { color: var(--red); }
.err { color: var(--red); border: 1px solid var(--red); background: rgba(255, 56, 96, .08); padding: .75rem; border-radius: 6px; white-space: pre-wrap; }
footer { margin-top: 2rem; font-size: 12px; }

.stats-grid { display: grid; grid-template-columns: minmax(160px, 1fr) 3fr; gap: .75rem; }
@media (max-width: 640px) { .stats-grid { grid-template-columns: 1fr; } }
.tile.stat { --c: var(--violet); display: block; }
.tile.reviews { --c: var(--cyan); cursor: default; }
.tile.reviews:hover { transform: none; }
.bar-row { display: grid; grid-template-columns: minmax(90px, 160px) 1fr 3ch; align-items: center; gap: .75rem; padding: .3rem 0; }
.bar-row:first-of-type { margin-top: .6rem; }
.bar-row:hover .bar { box-shadow: 0 0 14px var(--cyan); }
.bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 8px; }
.bar { display: block; height: 100%; min-width: 2px; background: var(--cyan); border-radius: 0 4px 4px 0; box-shadow: 0 0 8px -2px var(--cyan); transition: width .6s ease-out; }
.bar-value { text-align: right; color: var(--muted); }

.s-opened { --s: #00a3bf; } .s-merged { --s: #a070ff; } .s-closed { --s: #c48300; }
.chart-tile { margin-top: .75rem; cursor: default; display: block; }
.chart-tile:hover { transform: none; }
.chart-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
.legend { display: flex; gap: 1rem; font-size: 12px; }
.legend-item { display: inline-flex; align-items: center; gap: .4rem; }
.key { display: inline-block; width: 14px; height: 2px; background: var(--s); border-radius: 1px; vertical-align: middle; margin-right: .4rem; }
.legend .key { margin-right: 0; }
.chart { position: relative; margin-top: .75rem; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.grid { stroke: var(--line); stroke-width: 1; }
.axis { fill: var(--muted); font: 11px "JetBrains Mono", monospace; }
.line { fill: none; stroke: var(--s); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; filter: drop-shadow(0 0 4px var(--s)); }
.dot { fill: var(--s); stroke: #0c1218; stroke-width: 2; }
.leader { stroke: var(--s); stroke-width: 1; }
.end-label { fill: var(--fg); font: 12px "JetBrains Mono", monospace; }
.crosshair { stroke: var(--muted); stroke-width: 1; opacity: 0; pointer-events: none; }
.hit { fill: transparent; }
.chart-tip {
    position: absolute; top: 0; pointer-events: none; z-index: 2; font-size: 12px; line-height: 1.6;
    background: #0c1218; border: 1px solid var(--line); border-radius: 4px; padding: .4rem .6rem; white-space: nowrap;
    box-shadow: 0 4px 20px rgba(0, 0, 0, .6);
}
details { margin-top: .5rem; font-size: 12px; }
details table { margin-top: .5rem; }

@property --p { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@keyframes fill { to { --p: 360deg; } }
@keyframes spin { to { transform: rotate(360deg); } }
.pie {
    position: fixed; top: 1.25rem; right: 1.25rem; width: 22px; height: 22px; border-radius: 50%; z-index: 11;
    background: conic-gradient(var(--green) var(--p), var(--line) 0);
    box-shadow: 0 0 12px -2px var(--green); animation: fill var(--refresh) linear forwards;
}
.loading .pie {
    background: none; border: 3px solid var(--line); border-top-color: var(--green);
    animation: spin .7s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
    *, *::before { animation: none !important; transition: none !important; }
}
"""


SERIES_CLASS = {"Opened": "s-opened", "Merged": "s-merged", "Closed": "s-closed"}
CHART_W, CHART_H = 1000, 240
CHART_PAD = {"top": 12, "right": 110, "bottom": 28, "left": 36}
GRID_STEPS = 4
LABEL_GAP = 16


def nice_max(n):
    step = max(1, -(-n // GRID_STEPS))
    return step * GRID_STEPS


def line_chart(days, daily):
    plot_w = CHART_W - CHART_PAD["left"] - CHART_PAD["right"]
    plot_h = CHART_H - CHART_PAD["top"] - CHART_PAD["bottom"]
    top = nice_max(max(max(v) for v in daily.values()))
    x = lambda i: CHART_PAD["left"] + plot_w * i / (len(days) - 1)
    y = lambda v: CHART_PAD["top"] + plot_h * (1 - v / top)
    grid = "".join(
        f'<line class=grid x1={CHART_PAD["left"]} x2={CHART_PAD["left"] + plot_w} y1={y(v):.1f} y2={y(v):.1f} />'
        f'<text class=axis x={CHART_PAD["left"] - 8} y={y(v) + 4:.1f} text-anchor=end>{v}</text>'
        for v in range(0, top + 1, top // GRID_STEPS)
    )
    x_labels = "".join(
        f'<text class=axis x={x(i):.1f} y={CHART_H - 8} text-anchor=middle>{day:%d %b}</text>'
        for i, day in enumerate(days) if i % 2 == (len(days) - 1) % 2
    )
    lines = "".join(
        f'<polyline class="line {SERIES_CLASS[name]}" points="{" ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(values))}" />'
        + "".join(f'<circle class="dot {SERIES_CLASS[name]}" cx={x(i):.1f} cy={y(v):.1f} r=4 />' for i, v in enumerate(values))
        for name, values in daily.items()
    )
    # end labels sorted top to bottom and pushed apart so they never overlap; a leader line joins each to its line
    ends = sorted(((y(values[-1]), name, values[-1]) for name, values in daily.items()))
    placed = []
    for end_y, name, value in ends:
        placed.append((end_y, max(end_y, placed[-1][1] + LABEL_GAP) if placed else end_y, name, value))
    end_x = x(len(days) - 1)
    labels = "".join(
        f'<line class="leader {SERIES_CLASS[name]}" x1={end_x + 6:.1f} y1={line_y:.1f} x2={end_x + 18:.1f} y2={label_y:.1f} />'
        f'<text class=end-label x={end_x + 22:.1f} y={label_y + 4:.1f}>{name} {value}</text>'
        for line_y, label_y, name, value in placed
    )
    step = plot_w / (len(days) - 1)
    hits = "".join(
        f'<rect class=hit x={x(i) - step / 2:.1f} y={CHART_PAD["top"]} width={step:.1f} height={plot_h} data-x={x(i):.1f} '
        f'data-tip="{day:%a %d %b}|' + "|".join(f"{name}:{values[i]}" for name, values in daily.items()) + '" />'
        for i, day in enumerate(days)
    )
    legend = "".join(f'<span class=legend-item><span class="key {SERIES_CLASS[name]}"></span>{name}</span>' for name in daily)
    rows = "".join(
        f"<tr><td>{day:%a %d %b}</td>" + "".join(f"<td>{values[i]}</td>" for values in daily.values()) + "</tr>"
        for i, day in enumerate(days)
    )
    return f"""<div class="tile chart-tile">
<div class=chart-head><span class=tile-label>PRs per day, last {len(days)} days</span><span class=legend>{legend}</span></div>
<div class=chart>
<svg viewBox="0 0 {CHART_W} {CHART_H}" role=img aria-label="Opened, merged and closed PRs per day">
{grid}{x_labels}{lines}{labels}
<line class=crosshair x1=0 x2=0 y1={CHART_PAD["top"]} y2={CHART_PAD["top"] + plot_h} />
{hits}
</svg>
<div class=chart-tip hidden></div>
</div>
<details><summary class=muted>Table</summary><table><thead><tr><th>Day</th>{"".join(f"<th>{n}</th>" for n in daily)}</tr></thead>{rows}</table></details>
</div>"""


def stats_panel():
    if not stats:
        return ""
    top = max((n for _, n in stats["reviews"]), default=1)
    bars = "".join(
        f'<div class=bar-row title="{html.escape(login)} reviewed {n} PR{"s" if n != 1 else ""} in the last {STATS_DAYS} days">'
        f'<span class=bar-name>{html.escape(login)}</span>'
        f'<span class=bar-track><span class=bar style="width:{n / top * 100:.1f}%"></span></span>'
        f'<span class=bar-value>{n}</span></div>'
        for login, n in stats["reviews"]
    ) or "<p class=muted>No reviews</p>"
    merged_url = f"https://github.com/{REPO}/pulls?q={urllib.parse.quote_plus(stats['merged_search'])}"
    return f"""<div class=stats>
<h2>Stats</h2>
<div class=stats-grid>
<a class="tile stat" href="{merged_url}"><span class=tile-label>Merged, last {STATS_DAYS} days</span><span class=big>{stats["merged"]}</span></a>
<div class="tile reviews"><span class=tile-label>PRs reviewed by dev, last {STATS_DAYS} days</span>{bars}</div>
</div>
{line_chart(stats["days"], stats["daily"])}
</div>"""


def render():
    fetch()
    open_prs, failing_prs, needs_review, automerge = data or ([], [], [], [])
    conflicts = [p for p in open_prs if p["mergeable"] == "CONFLICTING"]
    queued = [p for p in automerge if not blocked(p)]
    categorised = {p["number"] for p in failing_prs + needs_review + conflicts + queued}
    tabs = [
        ("queue", "In merge queue", automerge, QUEUE),
        ("open", "Non-draft", open_prs, BASE),
        ("failing", "Failing checks", failing_prs, FAILING),
        ("conflicts", "Merge conflicts", conflicts, None),
        ("review", "Awaiting review", needs_review, NEEDS_REVIEW),
        ("other", "Other", [p for p in open_prs if p["number"] not in categorised], None),
    ]
    tiles = "".join(
        f'<button class=tile data-tab={key}><span class=tile-label>{label}</span><span class=big>{"?" if data is None else count(key, items)}</span></button>'
        for key, label, items, _ in tabs
    )
    panels = "".join(
        f'<section id={key} hidden><h2>{label}'
        + (f' <a class=gh href="https://github.com/{REPO}/pulls?q={urllib.parse.quote_plus("is:pr " + search)}">view on GitHub</a>' if search else "")
        + f"</h2>{table(items, kodiak=key == 'queue')}</section>"
        for key, label, items, search in tabs
    )
    return f"""<!doctype html><meta charset=utf-8>
<title>PR Dashboard</title>
<base target=_blank>
<link rel=preconnect href="https://fonts.gstatic.com" crossorigin>
<link rel=stylesheet href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap">
<style>{STYLE}</style>
<main data-version="{VERSION}">
<header><h1><span class=prompt>&gt;</span> {REPO}<span class=dim>/pulls</span><span class=cursor>_</span></h1></header>
<div class=tiles>{tiles}</div>
{f'<pre class=err>{html.escape(error)}</pre>' if error else ''}
<div class=panels>{panels}</div>
{stats_panel()}
<footer class=muted>{
    f"[gh api] {rate['remaining']:,}/{rate['limit']:,} left &middot; resets {reset_time():%H:%M} &middot; cost {rate['cost']}/refresh"
    if rate else ""
}</footer>
</main>
<div class=pie style="--refresh:{REFRESH_SECONDS}s" role=status title="Refreshes every {REFRESH_SECONDS}s" aria-label="Refreshes every {REFRESH_SECONDS}s"></div>
<script>
const show = (key, animate = false) => {{
    if (!document.getElementById(key)) key = "queue";
    const panels = document.querySelector(".panels");
    const from = panels.offsetHeight;
    document.querySelectorAll("section").forEach(s => {{
        s.hidden = s.id !== key;
        s.classList.toggle("enter", animate && s.id === key);
    }});
    document.querySelectorAll(".tile").forEach(t => t.classList.toggle("on", t.dataset.tab === key));
    history.replaceState(null, "", "#" + key);
    if (!animate || from === 0) return;
    const to = panels.scrollHeight;
    if (from === to) return;
    panels.style.height = from + "px";
    panels.offsetHeight; // commit the start height before transitioning
    panels.style.height = to + "px";
    const done = e => {{
        if (e.target !== panels) return;
        panels.style.height = "";
        panels.removeEventListener("transitionend", done);
    }};
    panels.addEventListener("transitionend", done);
}};
document.addEventListener("click", e => {{
    const tile = e.target.closest(".tile");
    if (tile) show(tile.dataset.tab, true);
    const row = e.target.closest("tr[data-href]");
    if (row && !e.target.closest("a")) window.open(row.dataset.href, "_blank", "noopener");
}});
document.addEventListener("mouseover", e => {{
    const hit = e.target.closest(".hit");
    const chart = e.target.closest(".chart");
    if (!chart) return;
    const tip = chart.querySelector(".chart-tip");
    const cross = chart.querySelector(".crosshair");
    if (!hit) {{ tip.hidden = true; cross.style.opacity = 0; return; }}
    const [day, ...values] = hit.dataset.tip.split("|");
    tip.replaceChildren(Object.assign(document.createElement("b"), {{ textContent: day }}), ...values.map(v => {{
        const [name, n] = v.split(":");
        const row = document.createElement("div");
        row.innerHTML = `<span class="key s-${{name.toLowerCase()}}"></span>${{name}} <b>${{n}}</b>`;
        return row;
    }}));
    cross.setAttribute("x1", hit.dataset.x);
    cross.setAttribute("x2", hit.dataset.x);
    cross.style.opacity = 1;
    const svg = chart.querySelector("svg");
    const px = hit.dataset.x * svg.clientWidth / {CHART_W};
    tip.hidden = false;
    tip.style.left = Math.min(px + 12, chart.clientWidth - tip.offsetWidth) + "px";
}});
document.addEventListener("mouseleave", () => document.querySelectorAll(".chart-tip").forEach(t => t.hidden = true));
show(location.hash.slice(1), true);
setInterval(() => fetch("/version").then(r => r.text()).then(v => v !== "{VERSION}" && location.reload()).catch(() => {{}}), 1000);
// swap content in place rather than navigating, so the browser tab shows no loading state
const pie = document.querySelector(".pie");
const refresh = async () => {{
    document.body.classList.add("loading");
    try {{
        const doc = new DOMParser().parseFromString(await (await fetch("/")).text(), "text/html");
        const main = doc.querySelector("main");
        // new code means new CSS/JS too, which a content swap would miss
        if (main.dataset.version !== "{VERSION}") return location.reload();
        const counts = Object.fromEntries([...document.querySelectorAll(".tile")].map(t => [t.dataset.tab, t.querySelector(".big").textContent]));
        document.querySelector("main").replaceWith(main);
        main.querySelectorAll(".tile").forEach(t => {{
            if (counts[t.dataset.tab] !== undefined && counts[t.dataset.tab] !== t.querySelector(".big").textContent) t.classList.add("changed");
        }});
        show(location.hash.slice(1));
    }} catch {{}}
    document.body.classList.remove("loading");
    pie.style.animation = "none";
    pie.offsetWidth; // restart the fill animation
    pie.style.animation = "";
    setTimeout(refresh, {REFRESH_SECONDS * 1000});
}};
setTimeout(refresh, {REFRESH_SECONDS * 1000});
</script>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global last_poll
        last_poll = time.monotonic()
        body = (VERSION if self.path == "/version" else render()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.path != "/version":
            super().log_message(fmt, *args)


def exit_when_idle():
    while time.monotonic() - last_poll < IDLE_EXIT_SECONDS:
        time.sleep(5)
    os._exit(0)


def restart_on_change():
    # ponytail: stdlib live reload (restart + page poll), not true HMR
    while True:
        time.sleep(1)
        if str(os.path.getmtime(__file__)) == VERSION:
            continue
        try:
            compile(open(__file__).read(), __file__, "exec")
        except SyntaxError as e:
            print(f"Not reloading, syntax error: {e}")
            time.sleep(1)
            continue
        os.execv(sys.executable, [sys.executable, *sys.argv])


if __name__ == "__main__":
    threading.Thread(target=restart_on_change, daemon=True).start()
    if IDLE_EXIT_SECONDS:
        threading.Thread(target=exit_when_idle, daemon=True).start()
    print(f"http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
