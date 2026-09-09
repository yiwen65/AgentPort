ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 dbus gnome-keyring libdbus-1-3 libssl3t64 ca-certificates socat git procps && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1550 agentportreview && useradd -u 1550 -g 1550 -m -s /bin/sh agentportreview
COPY bin/ /opt/agentport/bin/
COPY review_gateway.py review_access_control.py supervisor.py /opt/agentport/
ENV HOME=/home/agentportreview AGENTPORT_DATA_DIR=/home/agentportreview/data AGENTPORT_HOST_BIN=/opt/agentport/bin/agentport-host PYTHONDONTWRITEBYTECODE=1
USER 1550:1550
WORKDIR /home/agentportreview
ENTRYPOINT ["dbus-run-session", "--", "python3", "/opt/agentport/supervisor.py"]
