# Netaris Database Setup with Podman

This guide will help you set up the PostgreSQL database for Netaris using Podman (or Docker).

## Prerequisites

- Podman installed (or Docker)
- Podman Compose installed (or Docker Compose)

### Installing Podman Compose

```bash
# macOS (via Homebrew)
brew install podman-compose

# Or via pip
pip3 install podman-compose
```

## Quick Start

### 1. Start the Database Container

Using **Podman**:
```bash
podman-compose up -d
```

Using **Docker**:
```bash
docker-compose up -d
```

This will:
- Pull the PostgreSQL 16 Alpine image
- Create a container named `netaris-db`
- Initialize the database with the schema from `init.sql`
- Expose PostgreSQL on `localhost:5432`
- Create sample posts for testing

### 2. Check Container Status

```bash
# Podman
podman ps

# Docker
docker ps
```

You should see the `netaris-db` container running.

### 3. View Container Logs

```bash
# Podman
podman logs netaris-db

# Docker
docker logs netaris-db
```

Look for the message: "Netaris database initialized successfully!"

### 4. Start Your Application

```bash
npm run dev
```

The app will connect to the database using the `DATABASE_URL` from your `.env` file.

## Database Configuration

The database credentials are set in [compose.yml](compose.yml):

- **Database**: `netaris`
- **Username**: `netaris`
- **Password**: `netaris_dev_password`
- **Port**: `5432`

Your `.env` file should contain:
```
DATABASE_URL=postgresql://netaris:netaris_dev_password@localhost:5432/netaris
```

## Useful Commands

### Stop the Database
```bash
podman-compose down        # Podman
docker-compose down        # Docker
```

### Stop and Remove Data (Fresh Start)
```bash
podman-compose down -v     # Podman
docker-compose down -v     # Docker
```

### Connect to Database with psql
```bash
# Podman
podman exec -it netaris-db psql -U netaris -d netaris

# Docker
docker exec -it netaris-db psql -U netaris -d netaris
```

### View Database Tables
Once connected via psql:
```sql
\dt                                    -- List tables
SELECT * FROM post;                    -- View all posts
SELECT * FROM post ORDER BY created_at DESC LIMIT 10;  -- Recent posts
```

### Backup Database
```bash
# Podman
podman exec netaris-db pg_dump -U netaris netaris > backup.sql

# Docker
docker exec netaris-db pg_dump -U netaris netaris > backup.sql
```

### Restore Database
```bash
# Podman
podman exec -i netaris-db psql -U netaris netaris < backup.sql

# Docker
docker exec -i netaris-db psql -U netaris netaris < backup.sql
```

## Database Schema

The `post` table structure:

```sql
CREATE TABLE post (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    channel_id UUID NOT NULL,
    author_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

**Indexes:**
- `idx_post_channel_id` - Fast lookups by channel
- `idx_post_created_at` - Fast sorting by date
- `idx_post_channel_created` - Optimized for feed queries

## Troubleshooting

### Port 5432 Already in Use
If you have another PostgreSQL instance running:

```bash
# Find what's using port 5432
lsof -i :5432

# Option 1: Stop your local PostgreSQL
brew services stop postgresql

# Option 2: Change the port in compose.yml
ports:
  - "5433:5432"  # Use 5433 on host instead

# Then update DATABASE_URL in .env
DATABASE_URL=postgresql://netaris:netaris_dev_password@localhost:5433/netaris
```

### Container Won't Start
```bash
# Check logs for errors
podman logs netaris-db

# Remove old containers and try again
podman-compose down -v
podman-compose up -d
```

### Connection Refused Errors
- Make sure the container is running: `podman ps`
- Check the health status: `podman inspect netaris-db | grep -A 5 Health`
- Verify DATABASE_URL in `.env` matches the compose.yml settings

### Init Script Didn't Run
The `init.sql` script only runs when the database is created for the first time. To re-run it:

```bash
# Remove the volume to force re-initialization
podman-compose down -v
podman-compose up -d
```

## Production Considerations

For production deployment:

1. **Change the password** in `compose.yml` and `.env`
2. **Enable SSL** if your provider requires it (edit [db.js](db.js))
3. **Use secrets management** instead of plain text passwords
4. **Set up automated backups**
5. **Configure proper resource limits** in compose.yml
6. **Use a stronger password** and restrict network access

## Development Workflow

```bash
# Start database
podman-compose up -d

# Start backend and frontend
npm run dev

# When done developing
podman-compose down

# Fresh start (clears all data)
podman-compose down -v && podman-compose up -d
```
