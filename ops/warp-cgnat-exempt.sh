#!/bin/sh
# Re-assert the Tailscale CGNAT exemption vs Cloudflare WARP.
#
# WARP's org policy does two things that each independently kill the
# tailnet data path (while `tailscale ping` still looks fine, since disco
# bypasses netfilter + policy routing):
#   1. table inet cloudflare-warp drops all of 100.64.0.0/10 in its
#      input and output chains.
#   2. a high-priority ip rule sends CGNAT traffic out CloudflareWARP.
# WARP re-inserts #2 at DIFFERENT priorities after reboot/reconnect
# (observed 32765 and 5207), so a fixed priority for our rule is not safe.
#
# What we do (idempotent, self-healing, runs as root from a 30s timer):
#   - insert the two nft accepts if WARP flushed them;
#   - delete any prior CGNAT ip rule we placed, at whatever priority;
#   - re-add it one above WARP's most-precedent rule so we always win.
#
# The durable fix is an IT/Cloudflare-ZT ticket to remove 100.64.0.0/10
# from the WARP include policy server-side (like the 100.109/16 Docker
# carve-out). This script is the per-host band-aid until then.
set -u

# 1) nft accepts (only if WARP dropped them)
nft list chain inet cloudflare-warp output 2>/dev/null |
  grep -q 'ip daddr 100.64.0.0/10 accept' ||
  nft insert rule inet cloudflare-warp output ip daddr 100.64.0.0/10 accept

nft list chain inet cloudflare-warp input 2>/dev/null |
  grep -q 'ip saddr 100.64.0.0/10 accept' ||
  nft insert rule inet cloudflare-warp input ip saddr 100.64.0.0/10 accept

# 2) remove our CGNAT ip rule at whatever priority a prior run left it
ip rule list 2>/dev/null |
  awk -F: '/ to 100\.64\.0\.0\/10 lookup 52$/ {print $1}' |
  while read -r p; do
    [ -n "$p" ] && ip rule del priority "$p" 2>/dev/null
  done

# 3) find WARP's most-precedent (lowest-number) rule, sit one above it
# WARP's rule is recognizable by fwmark 0x100cf (its own mark) and/or its
# route table (observed 65743); match either so a policy update can't
# sneak its rule ahead of us.
warp_min=$(ip rule list 2>/dev/null \
  | awk '/fwmark 0x100cf|lookup 65743/ {split($1,a,":"); print a[1]+0}' \
  | sort -n | head -1)

if [ -n "$warp_min" ] && [ "$warp_min" -gt 10 ] 2>/dev/null; then
  my_priority=$((warp_min - 1))
else
  my_priority=1000
fi

ip rule add priority "$my_priority" to 100.64.0.0/10 lookup 52
