# Explicit smoke artifact, never the ordinary development or release client.
FROM oven/bun:1.4.4 AS bun
FROM rust:1.97.1-bookworm AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/kite
COPY package.json bun.lock tsconfig.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY release ./release
# Never copy this task's verifier, solution, host environment, or .git into the agent.
COPY integrations/harbor/runtime.ts integrations/harbor/lifetime.ts integrations/harbor/launch.ts integrations/harbor/mock-launch.ts integrations/harbor/runtime.test.ts integrations/harbor/tsconfig.json ./integrations/harbor/
RUN bun install --frozen-lockfile --ignore-scripts \
    && bun run build:files-native \
    && mkdir -p apps/service/dist \
    && bun build apps/service/src/main.ts --target=bun --packages=external --outfile=apps/service/dist/main.js \
    && bun test integrations/harbor/runtime.test.ts \
    && bun x tsc --noEmit -p integrations/harbor/tsconfig.json
ARG KITE_SOURCE_COMMIT
RUN printf '%s' "$KITE_SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{40}$' \
    && printf '{"commit":"%s"}\n' "$KITE_SOURCE_COMMIT" > integrations/harbor/source.json \
    && rm -rf packages/agent/native/files/target

FROM ubuntu:24.04
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /opt/kite /opt/kite
RUN mkdir -p /app /opt/kite-harbor \
    && printf '#!/bin/sh\nexec /usr/local/bin/bun /opt/kite/integrations/harbor/mock-launch.ts "$@"\n' > /opt/kite-harbor/launch \
    && printf '#!/bin/sh\nexec /usr/local/bin/bun /opt/kite/integrations/harbor/launch.ts "$@"\n' > /opt/kite-harbor/launch-real \
    && chmod 755 /opt/kite-harbor/launch /opt/kite-harbor/launch-real
WORKDIR /app
