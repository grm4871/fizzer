#!/bin/bash
set -e

# Read the onboarding.md file content
ONBOARDING_CONTENT=$(cat /docker-entrypoint-initdb.d/onboarding.md)

# Insert the onboarding netdoc using psql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    INSERT INTO netdoc (name, content, creator_id, allow_comments, allow_edits)
    VALUES ('Welcome to Netaris', \$content\$$ONBOARDING_CONTENT\$content\$, '00000000-0000-0000-0000-000000000000', false, false)
    ON CONFLICT DO NOTHING;
EOSQL

echo "Onboarding netdoc inserted successfully"
