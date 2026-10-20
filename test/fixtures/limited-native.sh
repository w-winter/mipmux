#!/bin/bash
# Test-only descriptor limit for the native bridge: a deterministic exhaustion reproducer, not a production cap.
ulimit -n "$MIPMUX_FD_LIMIT" && exec "$MIPMUX_NATIVE" "$@"
