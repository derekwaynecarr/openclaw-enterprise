#!/usr/bin/env bash
# EXPERIMENT ONLY (ci-speed measurement, reverted before landing).
# cpu-profile.sh start|mark <phase>|report <lane>
# Samples the aggregate /proc/stat cpu line every 2 s and reports, per phase,
# how busy the runner's CPUs were. Nothing here may fail the lane.
set -u
dir="${RUNNER_TEMP:-.}/cpu-profile"
mkdir -p "$dir" 2>/dev/null || true
case "${1:-}" in
  start)
    (
      while :; do
        printf '%s %s\n' "$(date +%s)" "$(head -n 1 /proc/stat)"
        sleep 2
      done
    ) >"$dir/samples" 2>/dev/null &
    echo $! >"$dir/pid"
    # Probe: can this kernel do bridge netfilter (k3d NetworkPolicy lanes)?
    {
      printf 'netfilter-probe kernel=%s before=%s ' "$(uname -r)" "$(test -e /proc/sys/net/bridge/bridge-nf-call-iptables && echo yes || echo no)"
      # Report only: loading the module would change Docker bridge filtering for the lane.
      printf 'module=%s builtin=%s\n' "$(modinfo -n br_netfilter 2>/dev/null || echo none)" \
        "$(grep -s -c 'br_netfilter' "/lib/modules/$(uname -r)/modules.builtin"; true)"
    } || true
    ;;
  mark)
    printf '%s %s\n' "${2:-phase}" "$(date +%s)" >>"$dir/marks"
    ;;
  report)
    kill "$(cat "$dir/pid" 2>/dev/null)" 2>/dev/null || true
    python3 - "$dir" "${2:-lane}" "$(nproc)" <<'EOF' || true
import sys
d, lane, ncpu = sys.argv[1], sys.argv[2], int(sys.argv[3])
rows = []
for line in open(f"{d}/samples"):
    p = line.split()
    if len(p) < 10 or p[1] != "cpu":
        continue
    v = list(map(int, p[2:10]))  # user nice system idle iowait irq softirq steal
    rows.append((int(p[0]), v))
marks = [l.split() for l in open(f"{d}/marks")] if rows else []
marks = [(n, int(t)) for n, t in marks] + [("end", 1 << 62)]
out = [f"cpu-profile lane={lane} cpus={ncpu}"]
for (name, t0), (_, t1) in zip(marks, marks[1:]):
    seg = [r for r in rows if t0 <= r[0] <= t1]
    if len(seg) < 2:
        continue
    a, b = seg[0][1], seg[-1][1]
    dv = [y - x for x, y in zip(a, b)]
    tot = sum(dv) or 1
    busy = tot - dv[3] - dv[4]
    sat = 0
    for (_, x), (_, y) in zip(seg, seg[1:]):
        dd = [q - p for p, q in zip(x, y)]
        t = sum(dd) or 1
        if (t - dd[3] - dd[4]) / t >= 0.9:
            sat += 1
    secs = seg[-1][0] - seg[0][0]
    out.append(
        f"{name}: {secs}s busy={100 * busy / tot:.0f}% iowait={100 * dv[4] / tot:.0f}% "
        f"steal={100 * dv[7] / tot:.0f}% cpu-seconds={busy / 100:.0f} saturated={100 * sat / max(1, len(seg) - 1):.0f}%"
    )
print(" | ".join(out))
EOF
    ;;
esac
exit 0
