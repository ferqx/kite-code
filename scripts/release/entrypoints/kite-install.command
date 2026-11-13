#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH NODE_COMPILE_CACHE NODE_V8_COVERAGE BUN_OPTIONS ELECTRON_RUN_AS_NODE
terminal=$(CDPATH= cd -P -- "${0%/*}/.." && pwd)
exec "$terminal/runtime/node" "$terminal/node_modules/@kite-ai/agent/native-maintenance.mjs" "$@"
