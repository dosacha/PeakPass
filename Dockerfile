# 빌드 단계
FROM node:18-alpine AS builder
WORKDIR /app

# 의존성 설치
COPY package*.json ./
RUN npm ci

# 소스 복사 및 빌드
COPY . .
RUN npm run build

# 실행 단계
FROM node:18-alpine
WORKDIR /app

# 시그널 처리용 dumb-init 설치
RUN apk add --no-cache dumb-init

# 비루트 사용자 생성
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# 빌드 결과 복사
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/public ./public
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# 스크립트 복사
COPY --chown=nodejs:nodejs src/infra/migrations ./migrations

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# dumb-init 사용
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
