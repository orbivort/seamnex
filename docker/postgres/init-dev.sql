-- Development bootstrap: three databases in one cluster with separate roles (design §4.2).
-- The platform schema itself is created by packages/db migrations, never here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak') THEN
    CREATE ROLE keycloak LOGIN PASSWORD 'keycloak_dev_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n') THEN
    CREATE ROLE n8n LOGIN PASSWORD 'n8n_dev_password';
  END IF;
END
$$;

SELECT 'CREATE DATABASE seamnex_keycloak OWNER keycloak'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'seamnex_keycloak')\gexec

SELECT 'CREATE DATABASE seamnex_n8n OWNER n8n'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'seamnex_n8n')\gexec

GRANT ALL PRIVILEGES ON DATABASE seamnex_keycloak TO keycloak;
GRANT ALL PRIVILEGES ON DATABASE seamnex_n8n TO n8n;
