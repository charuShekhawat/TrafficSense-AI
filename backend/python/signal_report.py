"""Render an analysis PDF from the controller's exported decision history."""
import csv
import io
import re
import sys
import textwrap
from collections import Counter
from datetime import datetime, timedelta, timezone
from statistics import mean
from urllib.request import urlopen

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages


with urlopen(sys.argv[1], timeout=10) as response:
    rows = list(csv.DictReader(io.StringIO(response.read().decode("utf-8"))))
if not rows:
    raise ValueError("Decision history is empty")

ist = timezone(timedelta(hours=5, minutes=30))


def local_time(row):
    return datetime.fromisoformat(row["Timestamp (UTC)"].replace("Z", "+00:00")).astimezone(ist)


start, end = map(local_time, (rows[0], rows[-1]))
period = f"{start:%d %b %Y, %H:%M:%S} to {end:%d %b %Y, %H:%M:%S} IST"
categories = Counter(row["Category"] for row in rows)
modes = Counter(row["Mode"] for row in rows)
signals = [row for row in rows if row["Category"] == "SIGNAL"]
greens = Counter(row["Active lane"].title() for row in signals if row["Phase"] == "GREEN")
phases = Counter(row["Phase"] for row in signals)
ambulance = [row for row in rows if row["Category"] == "AMBULANCE"]
density = [row for row in rows if row["Category"] == "DENSITY"]
allocations = [
    int(match.group(1)) for row in density
    if (match := re.search(r"(?:receives|assigning) (\d+) seconds of GREEN", row["Decision"]))
]
extensions = sum("GREEN extended" in row["Decision"] for row in density)
wait_priority = sum("waiting-time priority" in row["Decision"] for row in density)
granted = sum("is now GREEN" in row["Decision"] or "already GREEN" in row["Decision"] for row in ambulance)
withdrawn = sum("before priority started" in row["Decision"] for row in ambulance)
ended = sum("priority ended" in row["Decision"] for row in ambulance)

navy, ink, teal = "#10263b", "#26394b", "#007f73"


def page(number, subtitle):
    fig = plt.figure(figsize=(8.27, 11.69), facecolor="white")
    fig.patches.append(plt.Rectangle((0, .815), 1, .185, transform=fig.transFigure, facecolor=navy))
    fig.text(.085, .957, "TRAFFICSENSE AI", color="#71ddd2", fontsize=10, weight="bold")
    fig.text(.085, .914, "Signal decision analysis", color="white", fontsize=25, weight="bold")
    fig.text(.087, .875, subtitle, color="#d2e4ed", fontsize=12)
    fig.text(.087, .845, period, color="#d2e4ed", fontsize=9)
    fig.text(.087, .042, "TrafficSense AI controller decision history", fontsize=8, color=ink)
    fig.text(.91, .042, f"{number} / 2", fontsize=8, color=ink, ha="right")
    return fig


def section(fig, top, title, body):
    fig.text(.087, top, title, color=teal, weight="bold", fontsize=14, va="top")
    fig.text(.087, top - .034, textwrap.fill(body, width=86), color=ink,
             fontsize=10.5, va="top", linespacing=1.6)


counts = ", ".join(f"{count} {mode}" for mode, count in modes.items())
allocation_summary = (
    f"The {len(allocations)} timed adaptive allocations ranged from {min(allocations)} to "
    f"{max(allocations)} seconds, averaging {mean(allocations):.1f} seconds."
    if allocations else "The observation window contained no timed adaptive allocations."
)
phase_summary = ", ".join(f"{count} {phase.replace('_', '-').lower()}" for phase, count in phases.most_common())
output = io.BytesIO()
with PdfPages(output, metadata={"Title": "TrafficSense AI | Signal Decision Analysis"}) as pdf:
    fig = page(1, "Controller operation and scheduling")
    section(fig, .773, "Executive summary",
            f"The controller recorded {len(rows)} entries ({counts}), including "
            f"{categories['SIGNAL']} signal changes, {categories['AMBULANCE']} ambulance-related decisions, "
            f"{categories['DENSITY']} scheduling decisions and {categories['SYSTEM']} system events.")
    section(fig, .630, "Adaptive green allocation",
            f"{allocation_summary} The log recorded {wait_priority} waiting-time priority decisions "
            f"and {extensions} five-second extensions following traffic spikes. These decisions show "
            "how detected demand and time already spent waiting influence signal allocation.")
    section(fig, .474, "Signal transitions by corridor",
            (f"The controller logged {phase_summary} transitions. " if phases else "The log has no phase transitions. ")
            + "The chart counts recorded entries into green, including regular scheduling and ambulance priority.")
    ax = fig.add_axes([.13, .12, .76, .23])
    lanes = ["North", "East", "South", "West"]
    bars = ax.bar(lanes, [greens[lane] for lane in lanes], color=teal, width=.54)
    ax.bar_label(bars, padding=4, fontsize=10)
    ax.set_ylim(0, max(greens.values(), default=0) + 2)
    ax.set_ylabel("Entries into green")
    ax.grid(axis="y", alpha=.2)
    ax.set_axisbelow(True)
    pdf.savefig(fig)
    plt.close(fig)

    fig = page(2, "Ambulance priority and interpretation")
    section(fig, .773, "How ambulance priority was handled",
            f"The controller granted or maintained priority green {granted} times. In {withdrawn} cases, "
            f"the detection cleared before priority began, and {ended} active priority endings were recorded. "
            "One ambulance episode can generate several entries as the controller confirms detection, "
            "coordinates the yellow transition and returns to normal scheduling.")
    example = next((row for row in ambulance if "will receive GREEN priority" in row["Decision"]), None)
    example_text = (
        f"At {local_time(example):%H:%M:%S} IST, the controller recorded this handoff decision. "
        f"{example['Decision']}" if example else
        "No requested priority handoff was recorded during this observation window."
    )
    section(fig, .578, "A decision from the log", example_text)
    section(fig, .400, "Interpreting the timing difference",
            "The dashboard compares estimated adaptive green allocations with a fixed 30-second slot "
            "per corridor. This describes signal allocation. Measuring actual travel-time savings "
            "requires vehicle waiting or clearance times under comparable conditions. Ambulance holds "
            "and traffic-spike extensions can change how long a lane receives green.")
    section(fig, .206, "Report coverage",
            "The report includes all recorded entries available when the download was requested. "
            "Coverage begins when persistent decision logging was enabled. Counts represent controller "
            "events and detections from the configured video sources.")
    pdf.savefig(fig)
    plt.close(fig)

sys.stdout.buffer.write(output.getvalue())
