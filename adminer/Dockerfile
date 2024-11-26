FROM php:8.3

RUN apt-get update && apt-get install --no-install-recommends -y libpq-dev

RUN docker-php-ext-install mysqli pdo pdo_mysql pgsql pdo_pgsql && docker-php-ext-enable pdo_mysql pdo_pgsql

RUN set -x \
    && ADMINEREVO_VERSION=$(curl -s https://api.github.com/repos/adminerevo/adminerevo/releases/latest | grep tag_name | cut -d '"' -f 4 | cut -d 'v' -f 2) \
    && curl -fsSL "https://github.com/adminerevo/adminerevo/releases/download/v$ADMINEREVO_VERSION/adminer-$ADMINEREVO_VERSION.php" -o /var/www/html/index.php

ENV PHP_CLI_SERVER_WORKERS=4
CMD [ "php", "-S", "[::]:8080", "-t", "/var/www/html" ]
