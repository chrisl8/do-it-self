# https://hub.docker.com/r/uroni/urbackup-server
FROM debian:latest

ARG VERSION

COPY entrypoint.sh /usr/bin/

RUN URL=https://hndl.urbackup.org/Server/latest/debian/bookworm/urbackup-server_${VERSION}_amd64.deb \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y wget \
    && wget -q "$URL" -O /root/urbackup-server.deb \
    && echo "urbackup-server urbackup/backuppath string /backups" | debconf-set-selections \
    && apt-get install -y --no-install-recommends /root/urbackup-server.deb \
    && apt-get clean \
    && cp -R /usr/share/urbackup /web-backup \
    && chmod +x /usr/bin/entrypoint.sh

# Note this is basically information in Dockerfile now days.
# You still have to add these ports to docker compose files to actually expose them.
# https://docs.docker.com/reference/dockerfile/#expose
EXPOSE 55413
EXPOSE 55414
EXPOSE 55415
EXPOSE 35623/udp

# /usr/share/urbackup will not be exported to a volume by default, but it still can be bind mounted
VOLUME [ "/var/urbackup", "/var/log", "/backups" ]
ENTRYPOINT ["/usr/bin/entrypoint.sh"]
CMD ["run"]
