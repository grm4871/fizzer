#!/bin/bash
set -e

# Configuration
COMPOSE_FILE="compose2.yml"
CONTAINER_NAME="netaris-staging-db"
DUMP_FILE="netaris_backup_2026-01-11.dump"
TARGET_DUMP_PATH="/tmp/old_backup.dump"

echo "======================================================================"
echo "Resetting Staging Database (Blank Slate)"
echo "======================================================================"

# Check if dump file exists locally
if [ ! -f "$DUMP_FILE" ]; then
    echo "❌ Error: Dump file '$DUMP_FILE' not found in current directory!"
    echo "Please ensure you have the backup file before resetting."
    exit 1
fi

# Detect Runtime
if command -v docker >/dev/null 2>&1; then
    DOCKER_CMD="docker"
elif command -v podman >/dev/null 2>&1; then
    DOCKER_CMD="podman"
else
    echo "❌ Error: Neither docker nor podman found."
    exit 1
fi

# 1. Tear down existing staging environment (volumes included)
echo "[1/4] Tearing down existing staging environment..."
# Check for compose
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
elif command -v podman-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="podman-compose"
else
    echo "❌ Error: No compose tool found (docker compose, docker-compose, or podman-compose)."
    exit 1
fi

$DOCKER_COMPOSE -f $COMPOSE_FILE down -v
echo "✓ Staging environment removed"

# 2. Start fresh
echo ""
echo "[2/4] Starting fresh staging environment..."
$DOCKER_COMPOSE -f $COMPOSE_FILE up -d
echo "✓ Staging container started"

# 3. Wait for DB to be ready
echo ""
echo "[3/4] Waiting for database to be ready..."
echo "Waiting for postgres on port 5434..."

# Function to check readiness
wait_for_db() {
    local retries=30
    local wait=2
    until $DOCKER_CMD exec $CONTAINER_NAME pg_isready -U netaris -d netaris >/dev/null 2>&1; do
        if [ $retries -eq 0 ]; then
            echo "❌ Timed out waiting for database."
            exit 1
        fi
        echo -n "."
        sleep $wait
        retries=$((retries-1))
    done
    echo ""
}

wait_for_db
echo "✓ Database is ready"

# 4. Prepare for migration (Copy dump file)
echo ""
echo "[4/4] Copying dump file to container..."
$DOCKER_CMD cp "$DUMP_FILE" "$CONTAINER_NAME":"$TARGET_DUMP_PATH"
echo "✓ Dump file copied to $TARGET_DUMP_PATH inside container"

echo ""
echo "======================================================================"
echo "Staging DB Reset Complete!"
echo "======================================================================"
echo ""
echo "You can now run the migration script:"
echo ""
echo "CONTAINER=$CONTAINER_NAME ./migrate_final_b36.sh"
echo ""
