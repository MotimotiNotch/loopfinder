"""Reads the week's daily notes and the idea list, and writes summary/weekly.md.

    python scripts/weekly_summary.py
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DAILY = os.path.join(HERE, "..", "notes", "daily")
IDEAS = os.path.join(HERE, "..", "notes", "ideas.md")
OUT = os.path.join(HERE, "..", "summary", "weekly.md")

tasks, logs = [], []
for name in sorted(os.listdir(DAILY)):
    with open(os.path.join(DAILY, name), encoding="utf-8") as f:
        text = f.read()
    tasks += re.findall(r"^- \[ \] (.+)$", text, re.M)
    logs += re.findall(r"## Log\n((?:- .+\n?)+)", text)

with open(IDEAS, encoding="utf-8") as f:
    ideas = re.findall(r"^- (.+)$", f.read(), re.M)

with open(OUT, "w", encoding="utf-8") as f:
    f.write("# Week\n\n## Open tasks\n")
    f.writelines("- %s\n" % t for t in tasks)
    f.write("\n## Ideas to try\n")
    f.writelines("- %s\n" % i for i in ideas)
