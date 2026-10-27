# Finanzas Familiares — imagen de produccion
# Etapa unica: el proyecto corre con Node ESM sin build step.
FROM node:24-alpine

# node:sqlite esta integrado en Node >=22.13. Solo se instalarn las
# dependencias declaradas en package.json (dotenv, express, telegraf y,
# opcionalmente, imapflow/mailparser).
WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

# Dependencias primero: la capa se cachea si no cambian.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

# Codigo de la aplicacion.
COPY src ./src
COPY scripts ./scripts
COPY package.json ./

# Usuario sin privilegios; el volumen de datos debe ser escribible por uid 1001.
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app \
  && mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 3000

# Datos persistentes montar --volume finanzas-data:/app/data
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
