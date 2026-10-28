# syntax=docker/dockerfile:1

# ── 构建阶段 ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY public ./public
RUN npm run build

# ── 运行阶段 ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    ZHIXU_DATA_DIR=/data

# tsx 已在 dependencies 中，生产依赖可完全由 lockfile 复现安装。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 只保留运行所需产物：前端构建输出、服务端、服务端真正 import 的 src 类型/协议/状态模块，
# 以及运维文档引用的备份与生产预检脚本。不复制 eval 评测数据或临时 reviewer 脚本。
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node src/types.ts src/bookTypes.ts ./src/
COPY --chown=node:node \
  src/lib/backup.ts \
  src/lib/bookProtocol.ts \
  src/lib/diagnostic.ts \
  src/lib/learningState.ts \
  src/lib/review.ts \
  src/lib/sessionMerge.ts \
  ./src/lib/
COPY --chown=node:node scripts/backup-db.ts scripts/check-production-env.ts scripts/cli.ts ./scripts/
COPY --chown=node:node tsconfig.json ./

# 数据目录（SQLite、凭据密钥与备份）。以卷挂载持久化，仅数据目录需要可写。
RUN mkdir -p /data && chown -R node:node /data

VOLUME ["/data"]

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ZHIXU_PORT||3001)+'/api/ready').then(r=>{if(!r.ok)throw 0;}).catch(()=>process.exit(1))"

# 直接以 node 启动，不经过 npm 包装层：SIGTERM 直达服务进程，
# 配合 compose 的 stop_grace_period 完成 server.close() 与 SQLite 关闭。
# --production 启用来源校验与静态托管。
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "server/index.ts", "--production"]
