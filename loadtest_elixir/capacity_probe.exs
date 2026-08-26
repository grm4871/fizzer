# Runtime-loaded capacity probe modules. Metrics is required before its Server collector.
Code.require_file(Path.expand("lib/capacity_probe_metrics.exs", __DIR__))
Code.require_file(Path.expand("lib/capacity_probe_server.exs", __DIR__))
