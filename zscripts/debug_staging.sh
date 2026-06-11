#!/bin/bash
set -e

CONTAINER="netaris-staging-db"

echo "======================================================================"
echo "DEBUGGING COMPLETED STAGING CONTAINER"
echo "======================================================================"

# Detect Runtime
if command -v docker >/dev/null 2>&1; then
    DOCKER_CMD="docker"
elif command -v podman >/dev/null 2>&1; then
    DOCKER_CMD="podman"
else
    echo "❌ Error: Neither docker nor podman found."
    exit 1
fi
echo "Using runtime: $DOCKER_CMD"

echo ""
echo "[1] Checking Container Status in 'ps -a'"
$DOCKER_CMD ps -a --filter name=$CONTAINER

echo ""
echo "[2] Checking Container Logs (Last 50 lines)"
$DOCKER_CMD logs --tail 50 $CONTAINER || echo "❌ Could not retrieve logs"

echo ""
echo "[3] Checking Volume Mounts"
$DOCKER_CMD inspect $CONTAINER --format '{{json .Mounts}}' | grep "Source" || echo "❌ Could not inspect mounts"
