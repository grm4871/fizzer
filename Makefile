.PHONY: up down reset destroy build db-reset backup

build:
	podman build -f ergo.Dockerfile -t netaris-ergo .

up:
	podman network create netaris-net || true
	podman run -d --name netaris-postgres -p 5433:5432 \
		--network netaris-net \
		-e POSTGRES_USER=netaris \
		-e POSTGRES_PASSWORD=netaris_dev_password \
		-e POSTGRES_DB=netaris \
		postgres:16-alpine
	podman run -d --name netaris-ergo -p 6667:6667 \
		--network netaris-net \
		-v ./ircd.yaml:/ircd/ircd.yaml:ro \
		-e DATABASE_URL=postgresql://netaris:netaris_dev_password@netaris-postgres:5432/netaris \
		localhost/netaris-ergo
	sleep 2
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < init.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms_triggers.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/jacket.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/reacts.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/create.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/subs_and_notifs.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/seed.sql
	podman exec netaris-postgres psql -U netaris -c "ALTER SYSTEM SET log_statement = 'all';" && \
	podman exec netaris-postgres psql -U netaris -c "SELECT pg_reload_conf();"
	npm run dev

down:
	podman stop netaris-postgres || true
	podman stop netaris-ergo || true
	podman rm -f netaris-postgres || true
	podman rm -f netaris-ergo || true

reset: build
	podman stop netaris-postgres || true
	podman stop netaris-ergo || true
	podman rm -f netaris-postgres || true
	podman rm -f netaris-ergo || true
	podman network create netaris-net || true
	podman run -d --name netaris-postgres -p 5433:5432 \
		--network netaris-net \
		-e POSTGRES_USER=netaris \
		-e POSTGRES_PASSWORD=netaris_dev_password \
		-e POSTGRES_DB=netaris \
		postgres:16-alpine
	podman run -d --name netaris-ergo -p 6667:6667 \
		--network netaris-net \
		-v ./ircd.yaml:/ircd/ircd.yaml:ro \
		-e DATABASE_URL=postgresql://netaris:netaris_dev_password@netaris-postgres:5432/netaris \
		localhost/netaris-ergo
	sleep 1
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < init.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms_triggers.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/jacket.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/reacts.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/create.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/subs_and_notifs.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/seed.sql
	podman exec netaris-postgres psql -U netaris -c "ALTER SYSTEM SET log_statement = 'all';" && \
	podman exec netaris-postgres psql -U netaris -c "SELECT pg_reload_conf();"

db-reset:
	podman stop netaris-postgres || true
	podman rm -f netaris-postgres || true
	podman network create netaris-net || true
	podman run -d --name netaris-postgres -p 5433:5432 \
		--network netaris-net \
		-e POSTGRES_USER=netaris \
		-e POSTGRES_PASSWORD=netaris_dev_password \
		-e POSTGRES_DB=netaris \
		postgres:16-alpine
	sleep 1
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < init.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms_triggers.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/jacket.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/reacts.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/create.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/subs_and_notifs.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/seed.sql
	podman exec netaris-postgres psql -U netaris -c "ALTER SYSTEM SET log_statement = 'all';" && \
	podman exec netaris-postgres psql -U netaris -c "SELECT pg_reload_conf();"

backup:
	podman stop netaris-postgres || true
	podman rm -f netaris-postgres || true
	podman network create netaris-net || true
	podman run -d --name netaris-postgres -p 5433:5432 \
		--network netaris-net \
		-e POSTGRES_USER=netaris \
		-e POSTGRES_PASSWORD=netaris_dev_password \
		-e POSTGRES_DB=netaris \
		postgres:16-alpine
	sleep 1
	podman exec -i netaris-postgres psql -U netaris -d netaris < backup.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < zmigrations/migration_feb.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < init.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/perms_triggers.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/jacket.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/reacts.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/create.sql && \
	podman exec -i netaris-postgres psql -U netaris -d netaris < sql/constraints.sql
	npm run dev

destroy:
	podman stop netaris-postgres || true
	podman stop netaris-ergo || true
	podman rm -fv netaris-postgres || true
	podman rm -fv netaris-ergo || true
	podman network rm netaris-net || true
