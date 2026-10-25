# Serves the browser version (web/) with nginx.
FROM nginx:1.30-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/index.html web/nvg2svg.js /usr/share/nginx/html/

EXPOSE 80
