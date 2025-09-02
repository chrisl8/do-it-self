# https://github.com/Morgyn/docker-starbound
FROM debian

RUN apt-get update && apt-get install -y --no-install-recommends --no-install-suggests \
    locales \
    ca-certificates \
    lib32gcc-s1 \
    libstdc++6 \
    curl \
    wget \
    build-essential \
    procps # For ps command

# Set the locale
# https://stackoverflow.com/a/28406007/4982408
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8

RUN mkdir -p /steamcmd

RUN cd /steamcmd \
    && wget -o /tmp/steamcmd.tar.gz http://media.steampowered.com/installer/steamcmd_linux.tar.gz \
    && tar zxvf steamcmd_linux.tar.gz \
    && rm steamcmd_linux.tar.gz \
    && chmod +x ./steamcmd.sh

ADD start.sh /start.sh
ADD update.sh /update.sh
# Add initial require update flag
ADD .update /.update

RUN chmod ugo+rwx /start.sh \
    && chmod ugo+rwx /update.sh

WORKDIR /

ENTRYPOINT ["./start.sh"]

# Further starbound notes:
# https://starbounder.org/Guide:Setting_Up_Multiplayer
# https://godlike.host/how-to-install-mods-on-the-starbound-server/
