defmodule CascadeWeb.DomainDispatch do
  @moduledoc "Routes a request to one isolated parity-domain router without speculative fallthrough."

  @type route :: {String.t(), String.t()}
  @type domain :: {module(), module()} | {module(), module(), keyword()}

  @spec dispatch(Plug.Conn.t(), [domain()]) :: {:handled, Plug.Conn.t()} | :not_found
  def dispatch(conn, domains) do
    case Enum.find(domains, fn domain ->
           {catalog, _router, _options} = normalize_domain(domain)
           Enum.any?(catalog.catalog(), &matches?(conn.method, conn.request_path, &1))
         end) do
      nil ->
        :not_found

      domain ->
        {_catalog, router, options} = normalize_domain(domain)

        conn = Plug.Conn.assign(conn, :domain_options, options)
        {:handled, router.call(conn, router.init(options))}
    end
  end

  @spec matches?(String.t(), String.t(), route()) :: boolean()
  def matches?(method, path, {required_method, pattern}) do
    method == required_method and segments_match?(split(pattern), split(path))
  end

  defp segments_match?(["*"], _actual), do: true
  defp segments_match?([], []), do: true

  defp segments_match?([expected | expected_rest], [actual | actual_rest]) do
    (String.starts_with?(expected, ":") or expected == actual) and
      segments_match?(expected_rest, actual_rest)
  end

  defp segments_match?(_, _), do: false

  defp normalize_domain({catalog, router}), do: {catalog, router, []}
  defp normalize_domain({catalog, router, options}), do: {catalog, router, options}

  defp split("/"), do: []

  defp split(path) do
    path
    |> String.trim_leading("/")
    |> String.split("/", trim: true)
  end
end
