# Headless container: Antigravity Bridge + Web Extension
# Chromium under Xvfb, up to 10 simultaneous Google accounts,
# viewable and interactive over noVNC on port 6080.
FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    DISPLAY=:99

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget curl gnupg ca-certificates \
    xvfb fluxbox x11vnc novnc websockify \
    supervisor procps net-tools dbus-x11 \
    fonts-liberation fonts-thai-tlwg fonts-noto-color-emoji \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# noVNC index.html symlink
RUN if [ -d /usr/share/novnc ] && [ ! -f /usr/share/novnc/index.html ]; then \
      ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html; \
    fi

# Chrome profile dirs for up to 10 accounts
RUN for i in $(seq 0 9); do mkdir -p /app/chrome-data/profile$i; done && \
    mkdir -p /var/log /var/run

COPY deploy/supervisord.conf /app/deploy/supervisord.conf
COPY deploy/start-vnc.sh     /app/deploy/start-vnc.sh
COPY deploy/start-browser.sh /app/deploy/start-browser.sh

RUN chmod +x /app/deploy/start-vnc.sh /app/deploy/start-browser.sh

EXPOSE 6080 8000

CMD ["/usr/bin/supervisord", "-c", "/app/deploy/supervisord.conf"]
