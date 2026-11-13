FROM php:8.3-apache-bookworm


ENV OHRM_VERSION 5.9
ENV OHRM_MD5 380d85deba0f82174a7db346c9347b87

RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

RUN set -ex; \
	savedAptMark="$(apt-mark showmanual)"; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		libfreetype6-dev \
		libjpeg-dev \
		libpng-dev \
		libzip-dev \
		libldap2-dev \
		libicu-dev \
		unzip \
	; \
	\
	cd .. && rm -r html; \
	curl -fSL -o orangehrm.zip "https://sourceforge.net/projects/orangehrm/files/stable/${OHRM_VERSION}/orangehrm-${OHRM_VERSION}.zip"; \
	echo "${OHRM_MD5} orangehrm.zip" | md5sum -c -; \
	unzip -q orangehrm.zip "orangehrm-${OHRM_VERSION}/*"; \
	mv orangehrm-$OHRM_VERSION html; \
	rm -rf orangehrm.zip; \
	chown www-data:www-data html; \
	chown -R www-data:www-data html/lib/confs html/src/cache html/src/log html/src/config; \
	chmod -R 775 html/lib/confs html/src/cache html/src/log html/src/config; \
	\
	docker-php-ext-configure gd --with-freetype --with-jpeg; \
	docker-php-ext-configure ldap \
	    --with-libdir=lib/$(uname -m)-linux-gnu/ \
	; \
	\
	docker-php-ext-install -j "$(nproc)" \
		gd \
		opcache \
		intl \
		pdo_mysql \
		zip \
		ldap \
	; \
	\
	apt-mark auto '.*' > /dev/null; \
	apt-mark manual $savedAptMark; \
	ldd "$(php -r 'echo ini_get("extension_dir");')"/*.so \
		| awk '/=>/ { so = $(NF-1); if (index(so, "/usr/local/") == 1) { next }; gsub("^/(usr/)?", "", so); print so }' \
		| sort -u \
		| xargs -r dpkg-query -S \
		| cut -d: -f1 \
		| sort -u \
		| xargs -rt apt-mark manual; \
	\
	apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
	rm -rf /var/cache/apt/archives; \
	rm -rf /var/lib/apt/lists/*

RUN { \
		echo 'opcache.memory_consumption=128'; \
		echo 'opcache.interned_strings_buffer=8'; \
		echo 'opcache.max_accelerated_files=4000'; \
		echo 'opcache.revalidate_freq=60'; \
		echo 'opcache.fast_shutdown=1'; \
		echo 'opcache.enable_cli=1'; \
	} > /usr/local/etc/php/conf.d/opcache-recommended.ini; \
	\
	if command -v a2enmod; then \
		a2enmod rewrite; \
	fi;

# --- platform additions ---------------------------------------------------------------------------
#
# Two deliberate changes to the upstream Dockerfile, both recorded in README.md:
#
#   1. `VOLUME ["/var/www/html"]` is **removed**. It declares the whole application — including the
#      `lib/confs` configuration an install writes — as an anonymous volume. Compose materialises
#      that volume on first run, so the installed tree would be shadowed by an empty one and every
#      restart would present a fresh, uninstalled application. The platform mounts a named volume on
#      `lib/confs` only, which is the directory the product actually persists.
#   2. The entrypoint installs the product once before Apache starts (`seamnex-bootstrap.sh`). Upstream
#      expects a human to complete the web installer; the platform declares the database and admin
#      values the installer needs, so the install runs at boot instead of waiting for a browser.
COPY seamnex-install-once.php /usr/local/bin/seamnex-install-once.php
COPY seamnex-bootstrap.sh /usr/local/bin/seamnex-bootstrap.sh
RUN chmod 0755 /usr/local/bin/seamnex-bootstrap.sh
ENTRYPOINT ["/usr/local/bin/seamnex-bootstrap.sh"]
