FROM node:22.23.5-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.23.5-alpine
WORKDIR /app
ENV NODE_ENV=production
# `prisma migrate deploy` runs from this image (prisma and dotenv are production dependencies).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
