FROM node:22-alpine AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx ng build --configuration production
# El nombre de la carpeta de salida depende del proyecto: se busca donde quedó index.html
RUN d="$(dirname "$(find dist -name index.html | head -n 1)")" && mkdir -p /salida && cp -r "$d"/. /salida/

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /salida /usr/share/nginx/html
EXPOSE 80