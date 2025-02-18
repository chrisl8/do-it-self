# https://github.com/tonsnoei/photon-docker.git

# https://whichjdk.com/
FROM eclipse-temurin:21-jre

# Install pbzip2 for parallel extraction
RUN apt-get update \
    && apt-get -y install \
    pbzip2 \
    wget \
    && rm -rf /var/lib/apt/lists/*

ARG PHOTON_VERSION

WORKDIR /photon
ADD https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar /photon/photon.jar
COPY entrypoint.sh ./entrypoint.sh

VOLUME /photon/photon_data

ENTRYPOINT /photon/entrypoint.sh
