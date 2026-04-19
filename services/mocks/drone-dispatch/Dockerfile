FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js .
EXPOSE 4003
CMD ["node", "index.js"]
