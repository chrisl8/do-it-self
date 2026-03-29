FROM node:lts-slim
RUN npm install -g serve
WORKDIR /app
EXPOSE 8080
CMD ["serve", "/app/dist", "-l", "8080", "-s"]
