FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
RUN mkdir -p /var/data && chown -R node:node /app /var/data
USER node
ENV NODE_ENV=production
ENV PORT=4318
ENV NEXTMOVE_DB_FILE=/var/data/nextmove-db.json
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:4318/api/health || exit 1
CMD ["node", "server.js"]
