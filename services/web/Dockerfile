FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8080/ws/dashboard
ARG NEXT_PUBLIC_BACKEND_HTTP_URL=http://localhost:8080
ARG NEXT_PUBLIC_SIM_WS_URL=ws://localhost:4001
ARG NEXT_PUBLIC_CHAOS_ENABLED=true

ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
ENV NEXT_PUBLIC_BACKEND_WS_URL=${NEXT_PUBLIC_BACKEND_WS_URL}
ENV NEXT_PUBLIC_BACKEND_HTTP_URL=${NEXT_PUBLIC_BACKEND_HTTP_URL}
ENV NEXT_PUBLIC_SIM_WS_URL=${NEXT_PUBLIC_SIM_WS_URL}
ENV NEXT_PUBLIC_CHAOS_ENABLED=${NEXT_PUBLIC_CHAOS_ENABLED}
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
