FROM node:24

WORKDIR /app

COPY --chown=node:node package*.json ./

RUN npm install

COPY --chown=node:node . .

EXPOSE 3000 5173

CMD ["npm", "run", "dev"]
