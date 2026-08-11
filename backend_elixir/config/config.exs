import Config

config :cascade_elixir,
  ecto_repos: [Cascade.DB.Repo],
  server: true,
  bind_ip: {127, 0, 0, 1},
  port: 3001,
  http_acceptors: max(System.schedulers_online(), 4),
  http_max_connections: 16_384,
  http_backlog: 65_535,
  realtime_hibernate_after_ms: 5_000,
  qmd_worker_enabled: true,
  runner_orphan_reclaim_ms: 120_000,
  trust_proxy_hops: 0,
  client_dist_dir: Path.expand("../../client/dist", __DIR__),
  network_mode: false,
  allowed_origins: []

config :cascade_elixir, Cascade.DB.Repo,
  database: Path.expand("../../docs.db", __DIR__),
  pool_size: 20,
  journal_mode: :wal,
  busy_timeout: 5_000,
  foreign_keys: :on,
  synchronous: :normal,
  stacktrace: true,
  show_sensitive_data_on_connection_error: false

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

import_config "#{config_env()}.exs"
