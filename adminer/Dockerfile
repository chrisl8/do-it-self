# This is based on Adminer that is being maintained again at https://github.com/vrana/adminer

# There are a few "official" adminer Docker images, but this has been more reliable for me over time.

FROM php:8.5

RUN apt-get update && apt-get install --no-install-recommends -y libpq-dev git

RUN docker-php-ext-install mysqli pdo pdo_mysql pgsql pdo_pgsql && docker-php-ext-enable pdo_mysql pdo_pgsql

# There are two ways to do this. You can Build from the git main branch. OR You can Pull from release

# Build from main
# WORKDIR /source
# RUN git clone https://github.com/adminerevo/adminerevo.git
# WORKDIR /source/adminerevo
# RUN git submodule update --init \
#     && php compile.php \
#     && cp adminer-*.php /var/www/html/index.php \
#     && cd / \
#     && rm -rf /source \
#     && apt-get remove -y git

# Pull from release
RUN set -x \
    && ADMINEREVO_VERSION=$(curl -s https://api.github.com/repos/vrana/adminer/releases/latest | grep tag_name | cut -d '"' -f 4 | cut -d 'v' -f 2) \
    && curl -fsSL "https://github.com/vrana/adminer/releases/download/v$ADMINEREVO_VERSION/adminer-$ADMINEREVO_VERSION.php" -o /var/www/html/index.php

WORKDIR /
ENV PHP_CLI_SERVER_WORKERS=4
CMD [ "php", "-S", "[::]:8080", "-t", "/var/www/html" ]
