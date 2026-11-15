# One room's game server: Node 22 and one bundled file (the platform runtime plus the app's
# game/server.ts, bundled by scripts/build-game-images.mjs). There is no RUN step on purpose: the
# image is built for arm64 on any runner without emulation, and nothing from a branch executes
# while it is built.
FROM --platform=linux/arm64 node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node server.mjs server.mjs.map ./
USER node
# UDP 40000-40019: one port per connected player (the app's security group opens exactly these).
EXPOSE 40000-40019/udp
CMD ["node", "--enable-source-maps", "server.mjs"]
