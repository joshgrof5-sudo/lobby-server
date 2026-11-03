FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/social.sqlite
EXPOSE 8080
CMD ["node", "server.mjs"]
