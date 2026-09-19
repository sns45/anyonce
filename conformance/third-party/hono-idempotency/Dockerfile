FROM node:22.23.2-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY app.mjs ./

EXPOSE 3000
CMD ["node", "app.mjs"]
