# https://github.com/tonsnoei/photon-docker.git

# https://whichjdk.com/
FROM eclipse-temurin:21-jre

ARG PHOTON_VERSION

WORKDIR /photon
ADD https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-opensearch-${PHOTON_VERSION}.jar /photon/photon.jar
COPY entrypoint.sh ./entrypoint.sh

VOLUME /photon/photon_data

ENTRYPOINT /photon/entrypoint.sh
