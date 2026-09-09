# Foxxers.
#
# Node standard library only — no npm, no build step — so this is a copy and a
# CMD. There is nothing to install and nothing to compile.
FROM node:22-alpine

# Everything except /app/data is baked into the image. /app/data is the only
# thing that must survive a rebuild: it holds foxxers.json (the whole database)
# and .session-key (which signs every session and job token — losing it signs
# every logged-in user out and invalidates every customer's job link).
WORKDIR /app
COPY server ./server
COPY web ./web
COPY scripts ./scripts

# 0.0.0.0 inside the container, NOT the app's 127.0.0.1 default: a server bound
# to loopback inside a container is unreachable from the host, and the symptom
# is a connection refused that looks like the container failed to start. The
# host publishes this to 127.0.0.1 only — see docs/deploy.md — so it is still
# never exposed directly to the internet.
ENV FOXXERS_HOST=0.0.0.0 \
    FOXXERS_PORT=8120 \
    FOXXERS_DATA=/app/data

# Runs as node rather than root. The data directory has to be owned by that
# user or the first write fails.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8120

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FOXXERS_PORT||8120)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
