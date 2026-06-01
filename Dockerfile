FROM node:20-alpine

# Instala a dependência obrigatória do Prisma para o Alpine
RUN apk add --no-cache openssl

WORKDIR /app

RUN mkdir -p /app/database

COPY package*.json ./

RUN npm install

COPY . .

RUN npx prisma generate

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push && npm start"]