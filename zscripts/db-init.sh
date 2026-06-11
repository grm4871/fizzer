#!/bin/bash
# db-init.sh - Run Prisma schema sync after PostgreSQL init.sql completes
# This ensures any Prisma-only schema changes are applied to the database

set -e

echo "=================================================="
echo "DB Init: Syncing Prisma schema with database"
echo "=================================================="

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
until pg_isready -h postgres -U netaris -d netaris > /dev/null 2>&1; do
    echo "  PostgreSQL is not ready yet, waiting..."
    sleep 2
done
echo "PostgreSQL is ready!"

# Run Prisma db push to sync schema
echo ""
echo "Running prisma db push..."
npx prisma db push --accept-data-loss --skip-generate

echo ""
echo "=================================================="
echo "DB Init: Schema sync complete!"
echo "=================================================="
