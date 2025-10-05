FROM node:20-alpine
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "index.js"]