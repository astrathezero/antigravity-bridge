# Headless container: Antigravity Bridge + Web Extension, driven by Chromium under Xvfb,
# viewable and interactive over noVNC on port 6080.
FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    supervisor \
    procps \
    net-tools \
    dbus-x11 \
    fonts-liberation \
    fonts-thai-tlwg \
    fonts-noto-color-emoji \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure noVNC web directory has an index.html pointing to vnc.html
RUN if [ -d /usr/share/novnc ] && [ ! -f /usr/share/novnc/index.html ]; then \
      ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html; \
    fi

# Create runtime directories
RUN mkdir -p /app/chrome-data /var/log /var/run

EXPOSE 6080 8000

CMD ["/usr/bin/supervisord", "-c", "/app/deploy/supervisord.conf"]
