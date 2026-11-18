FROM php:8.3-apache-bookworm


ENV OHRM_VERSION 5.9
ENV OHRM_MD5 380d85deba0f82174a7db346c9347b87

RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

# --- platform addition: the build host's Debian mirror -------------------------------------------
#
# The step below fetches from deb.debian.org. On a host whose egress filters that archive, `apt-get
# update` sits in the TLS handshake for minutes and then installs the same packages anyway — the
# first build of this tree spent its whole budget there. `APT_MIRROR` (forwarded by the `build` stage
# from `.env`) repoints the sources file at a mirror that host can reach: the same packages, one hop
# earlier, and nothing about the archive is patched.
#
# It defaults to empty on purpose: CI and a clean machine keep upstream, because a mirror is a fact
# about the network, not about the product. The value is an *origin*, the same shape `APK_MIRROR`
# takes: `/debian` and the sibling `/debian-security` are appended here, because every mirror serves
# the security suite beside the archive rather than under it (`…/debian-security`, not
# `…/debian/debian-security`). The rewrite is a no-op when the argument is empty, and it covers both
# shapes Debian ships — the deb822 `debian.sources` of bookworm and the one-line `sources.list` of
# anything older.
ARG APT_MIRROR=
RUN set -eu; \
    if [ -n "$APT_MIRROR" ]; then \
      mirror="${APT_MIRROR%/}"; \
      for file in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        [ -f "$file" ] || continue; \
        sed -i \
          -e "s|https\?://deb\.debian\.org/debian-security|$mirror/debian-security|g" \
          -e "s|https\?://security\.debian\.org/debian-security|$mirror/debian-security|g" \
          -e "s|https\?://deb\.debian\.org/debian|$mirror/debian|g" \
          "$file"; \
      done; \
    fi

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
# Four deliberate changes to the upstream Dockerfile, all recorded in README.md:
#
#   1. `VOLUME ["/var/www/html"]` is **removed**. It declares the whole application — including the
#      `lib/confs` configuration an install writes — as an anonymous volume. Compose materialises
#      that volume on first run, so the installed tree would be shadowed by an empty one and every
#      restart would present a fresh, uninstalled application. The platform mounts a named volume on
#      `lib/confs` only, which is the directory the product actually persists.
#   2. The entrypoint installs the product once before Apache starts (`seamnex-bootstrap.sh`). Upstream
#      expects a human to complete the web installer; the platform declares the database and admin
#      values the installer needs, so the install runs at boot instead of waiting for a browser.
#   3. `HTTPS` is derived from the edge's `X-Forwarded-Proto`. The edge terminates TLS and reaches this
#      container over plain HTTP, so without the rule the product builds every absolute URL — the
#      installer redirect, the post-login location, password-reset links — as `http://`, and a browser
#      on `https://<host>:8443` is sent to the same host on a scheme nothing listens on. Scoped to the
#      header rather than to an address because the edge's address on the instance network is dynamic;
#      only the edge can reach this container, which is the trust boundary that makes it safe.
#   4. The image states its own licence and carries the inventory it names. A container image is a
#      distribution of three bodies of code under three sets of terms, and the product's terms are
#      **unverified** in this tree (`IMAGE-LICENCES.md` says which, and why the label names them as a
#      custom reference rather than as a fact nobody checked).
COPY seamnex-install-once.php /usr/local/bin/seamnex-install-once.php
COPY seamnex-bootstrap.sh /usr/local/bin/seamnex-bootstrap.sh
COPY IMAGE-LICENCES.md /usr/share/doc/seamnex/orangehrm-licences.md
RUN chmod 0755 /usr/local/bin/seamnex-bootstrap.sh \
	&& printf '%s\n' \
		'# Platform: the edge terminates TLS and forwards X-Forwarded-Proto.' \
		'SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on' \
		> /etc/apache2/conf-enabled/seamnex-forwarded-proto.conf
LABEL org.opencontainers.image.title="OrangeHRM 5.9 (Seamnex render set)" \
	org.opencontainers.image.description="OrangeHRM built from platform/upstream/D07-01; upstream publishes no image, so this tag exists only in the platform's own namespace." \
	org.opencontainers.image.vendor="Seamnex" \
	org.opencontainers.image.source="https://github.com/orbivort/seamnex" \
	org.opencontainers.image.licenses="GPL-3.0-only AND LicenseRef-OrangeHRM-Upstream" \
	org.opencontainers.image.version="5.9"
ENTRYPOINT ["/usr/local/bin/seamnex-bootstrap.sh"]
