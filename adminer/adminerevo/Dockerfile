# Copied from https://github.com/shyim/adminerevo-docker and modified.
FROM php:latest

RUN apt-get update && apt-get install --no-install-recommends -y git libpq-dev

RUN docker-php-ext-install mysqli pdo pdo_mysql pgsql pdo_pgsql && docker-php-ext-enable pdo_mysql pdo_pgsql

COPY rootfs /

RUN	set -x \
    &&  ADMINEREVO_VERSION=$(curl -s https://api.github.com/repos/adminerevo/adminerevo/releases/latest | grep tag_name | cut -d '"' -f 4 | cut -d 'v' -f 2) \
    &&	curl -fsSL "https://github.com/adminerevo/adminerevo/releases/download/v$ADMINEREVO_VERSION/adminer-$ADMINEREVO_VERSION.php" -o /var/www/html/adminer.php \
    &&	git clone --recurse-submodules=designs --depth 1 --shallow-submodules --branch "v$ADMINEREVO_VERSION" https://github.com/adminerevo/adminerevo.git /tmp/adminer \
    &&	cp -r /tmp/adminer/designs/ /tmp/adminer/plugins/ /var/www/html \
    &&	rm -rf /tmp/adminer/ \
    &&	apt-get remove -y git

ENTRYPOINT [ "/entrypoint.sh" ]
ENV PHP_CLI_SERVER_WORKERS=4
CMD	[ "php", "-S", "[::]:8080", "-t", "/var/www/html" ]
