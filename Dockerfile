# ledgerline pipeline image: the thin per-project layer on top of the pipeline base
# (Node, git, the Claude Code CLI and bd).
#
# It adds EXACTLY the npm packages pipeline.config.json declares under "dependencies",
# which are exactly package.json's devDependencies at the same pinned versions (the
# service itself has no runtime dependencies). All three lists must match: change one,
# change all, and rebuild. Task containers have no network, so nothing can be installed
# at run time.
#
# Packages resolve from /node_modules, above the /workspace clone: Node's resolver, jest's
# preset lookup and TypeScript's @types lookup all walk parent directories, so nothing is
# written into the task's working tree. npm cannot install at / itself, so the packages
# live in /opt/deps and /node_modules links there. /node_modules/.bin is on PATH, so
# pipeline commands call jest and tsc directly, never through npx.
#
# Build: docker build -t pipeline-ledgerline:local .
FROM pipeline-base:local

USER root
WORKDIR /opt/deps
RUN echo '{"private":true}' > package.json \
    && npm install --no-save --no-package-lock --no-fund --no-audit \
      @types/jest@30.0.0 \
      @types/node@20.19.43 \
      jest@30.5.2 \
      ts-jest@29.4.15 \
      typescript@5.9.3 \
    && ln -s /opt/deps/node_modules /node_modules \
    && rm -rf /root/.npm
ENV PATH=/node_modules/.bin:$PATH

USER node
WORKDIR /workspace
