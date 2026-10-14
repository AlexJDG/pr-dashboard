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
from datetime import datetime
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
      number title url createdAt mergeStateStatus mergeable reviewDecision author { login }
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


def table(prs_, kodiak=False):
    rows = "".join(
        f'<tr data-href="{html.escape(p["url"])}"{" class=blocked" if kodiak and blocked(p) else ""}>'
        f'<td><a href="{html.escape(p["url"])}" target=_blank rel=noopener>#{p["number"]}</a></td>'
        f'<td>{html.escape(p["title"])}{"".join(map(pill, p["labels"]))}{unresolved_badge(p)}</td>'
        f'<td>{html.escape(p["author"]["login"])}</td><td>{html.escape(p["mergeStateStatus"].lower())}</td>'
        + (f'<td>{html.escape(p["kodiak"])}</td>' if kodiak else "") + "</tr>"
        for p in prs_
    ) or f"<tr><td colspan={5 if kodiak else 4} class=muted>None</td></tr>"
    return (
        "<table><thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Merge state</th>"
        + ("<th>Kodiak</th>" if kodiak else "") + f"</tr></thead>{rows}</table>"
    )


def count(key, items):
    if key != "queue":
        return len(items)
    n_blocked = sum(map(blocked, items))
    return f"{len(items) - n_blocked}" + (f" <small>({n_blocked} blocked)</small>" if n_blocked else "")


data, error, next_fetch, rate = None, "", 0.0, None
# Stop polling until the hourly reset rather than drain the budget other gh tools share
MIN_RATE_REMAINING = 500
fetch_lock = threading.Lock()


def reset_time():
    return datetime.fromisoformat(rate["resetAt"].replace("Z", "+00:00")).astimezone()


def fetch():
    # One GitHub query per refresh interval, shared by every open page; keeps the last good data on failure
    global data, error, next_fetch, rate
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


def render():
    fetch()
    open_prs, failing_prs, needs_review, automerge = data or ([], [], [], [])
    conflicts = [p for p in open_prs if p["mergeable"] == "CONFLICTING"]
    queued = [p for p in automerge if not blocked(p)]
    categorised = {p["number"] for p in failing_prs + needs_review + conflicts + queued}
    tabs = [
        ("queue", "In merge queue", automerge, QUEUE),
        ("open", "Open non-draft PRs", open_prs, BASE),
        ("failing", "Failing checks", failing_prs, FAILING),
        ("conflicts", "Merge conflicts", conflicts, None),
        ("review", "Only need a review", needs_review, NEEDS_REVIEW),
        ("other", "Everything else", [p for p in open_prs if p["number"] not in categorised], None),
    ]
    tiles = "".join(
        f'<button class=tile data-tab={key}><span class=muted>{label}</span><span class=big>{"?" if data is None else count(key, items)}</span></button>'
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
<style>
:root{{--bg:#ffffff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e2e2e2;--accent:#2563eb;--hot:#dc2626}}
@media (prefers-color-scheme:dark){{:root{{--bg:#111111;--fg:#eeeeee;--muted:#999999;--line:#2a2a2a;--accent:#60a5fa;--hot:#f87171}}}}
body{{background:var(--bg);color:var(--fg);font:16px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 16px}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem}}
.tile{{font:inherit;color:inherit;background:none;text-align:left;cursor:pointer;padding:.75rem;border:2px solid var(--line);border-radius:8px}}
.tile.on{{border-color:var(--accent)}}
.big{{display:block;font-size:3.5rem;font-weight:700;line-height:1;margin-top:.25rem}} .big small{{font-size:14px;font-weight:400;color:var(--muted);white-space:nowrap}} .muted{{color:var(--muted)}} footer{{margin-top:2rem;font-size:14px}} .err{{color:var(--hot)}}
table{{width:100%;border-collapse:collapse}} td,th{{padding:.5rem;border-bottom:1px solid var(--line);text-align:left}} th{{color:var(--muted);font-weight:600}}
@property --p{{syntax:"<angle>";inherits:false;initial-value:0deg}}
@keyframes fill{{to{{--p:360deg}}}} @keyframes spin{{to{{transform:rotate(360deg)}}}}
.pie{{position:fixed;top:1rem;right:1rem;width:20px;height:20px;border-radius:50%;
background:conic-gradient(var(--accent) var(--p),var(--line) 0);animation:fill {REFRESH_SECONDS}s linear forwards}}
.loading .pie{{background:none;border:3px solid var(--line);border-top-color:var(--accent);box-sizing:border-box;animation:spin .8s linear infinite}}
tr.blocked{{opacity:.55}} tr[data-href]{{cursor:pointer}} tr[data-href]:hover{{background:var(--line)}}
a{{color:var(--accent)}} .unresolved{{font-size:12px;color:var(--hot);white-space:nowrap}} .label{{display:inline-block;font-size:12px;padding:0 .5em;border:1px solid;border-radius:1em;white-space:nowrap}} .gh{{font-size:.6em;font-weight:400}}
</style>
<main data-version="{VERSION}">
<div class=tiles>{tiles}</div>
{f'<pre class=err>{html.escape(error)}</pre>' if error else ''}
{panels}
<footer class=muted>{
    f"GitHub API: {rate['remaining']:,} / {rate['limit']:,} left, resets {reset_time():%H:%M} (each refresh costs {rate['cost']})"
    if rate else ""
}</footer>
</main>
<div class=pie role=status title="Refreshes every {REFRESH_SECONDS}s" aria-label="Refreshes every {REFRESH_SECONDS}s"></div>
<script>
const show = key => {{
    if (!document.getElementById(key)) key = "queue";
    document.querySelectorAll("section").forEach(s => s.hidden = s.id !== key);
    document.querySelectorAll(".tile").forEach(t => t.classList.toggle("on", t.dataset.tab === key));
    history.replaceState(null, "", "#" + key);
}};
document.addEventListener("click", e => {{
    const tile = e.target.closest(".tile");
    if (tile) show(tile.dataset.tab);
    const row = e.target.closest("tr[data-href]");
    if (row && !e.target.closest("a")) window.open(row.dataset.href, "_blank", "noopener");
}});
show(location.hash.slice(1));
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
        document.querySelector("main").replaceWith(main);
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
