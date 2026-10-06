#!/bin/sh
# Test-only descriptor limit for the native bridge: a deterministic exhaustion reproducer, not a production cap.
ulimit -n "$SMIP_FD_LIMIT" && exec "$SMIP_NATIVE" "$@"
