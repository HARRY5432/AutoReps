FROM node:24.14.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
CMD ["npm", "test"]
