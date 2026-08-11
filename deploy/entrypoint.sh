#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  set -- start
fi

exec /app/release/bin/cascade_elixir "$@"
