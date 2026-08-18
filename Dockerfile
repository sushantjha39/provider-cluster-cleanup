# Runs the cleanup UI inside the cluster.
#
# In-cluster there is no port-forward: the app talks to the Mongo replica set
# directly through its headless service, and the driver picks the PRIMARY on
# its own. That removes the kubeconfig upload and the pod-index selector.
FROM node:20-alpine

WORKDIR /app

# Only production deps; the optional SQL drivers are not needed for Mongo.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src
COPY config.example.yaml ./

# config.yaml and .env arrive from a ConfigMap and a Secret at runtime.
# Run unprivileged; nothing here needs root.
RUN addgroup -S app && adduser -S -G app app \
    && mkdir -p /app/logs && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV PORT=4300

# The server binds loopback by default, which would be unreachable from a
# Service. In-cluster it must listen on all interfaces — network isolation is
# handled by the Service and NetworkPolicy instead.
ENV BIND_HOST=0.0.0.0

EXPOSE 4300

CMD ["node", "src/server.js"]
