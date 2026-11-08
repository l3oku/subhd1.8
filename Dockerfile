FROM node:24-alpine

RUN apk add --no-cache 7zip libarchive-tools

WORKDIR /app

# 代理出口（SUBHD_PROXIES）要用到 undici，所以镜像里得先把依赖装上
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7000

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:7000/healthz >/dev/null || exit 1

CMD ["node", "src/index.js"]