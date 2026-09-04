defmodule CascadeWeb.DomainDispatch do
  @moduledoc "Routes a request to one isolated parity-domain router without speculative fallthrough."

  defmacro __using__(_options) do
    quote do
      use Plug.Router
      Module.register_attribute(__MODULE__, :domain_routes, accumulate: true)
      @on_definition CascadeWeb.DomainDispatch
      @before_compile CascadeWeb.DomainDispatch
    end
  end

  # Plug has no route catalog API; collect metadata from its generated match clauses.
  def __on_definition__(env, :defp, :do_match, [_conn, method, _path, _host], _guards, body)
      when is_binary(method) do
    Macro.prewalk(body, fn
      {{:., _, [module, :__put_route__]}, _, [_conn, path, _callback]} = node ->
        if Macro.expand(module, env) == Plug.Router do
          Module.put_attribute(env.module, :domain_routes, {method, path})
        end

        node

      node ->
        node
    end)
  end

  def __on_definition__(_env, _kind, _name, _args, _guards, _body), do: :ok

  defmacro __before_compile__(env) do
    routes = env.module |> Module.get_attribute(:domain_routes) |> Enum.reverse()

    quote do
      def catalog, do: unquote(Macro.escape(routes))
    end
  end

  @type domain :: {module(), module()} | {module(), module(), keyword()}

  @spec dispatch(Plug.Conn.t(), [domain()]) :: {:handled, Plug.Conn.t()} | :not_found
  def dispatch(conn, domains) do
    Enum.reduce_while(domains, :not_found, fn domain, :not_found ->
      {_catalog, router, options} = normalize_domain(domain)
      # Match only: rejected domains must not parse bodies or run their fallback handlers.
      candidate = router.match(%{conn | private: Map.delete(conn.private, :plug_route)}, [])

      if Plug.Router.match_path(candidate) == "/*_path" do
        {:cont, :not_found}
      else
        conn = Plug.Conn.assign(conn, :domain_options, options)
        {:halt, {:handled, router.call(conn, router.init(options))}}
      end
    end)
  end

  defp normalize_domain({catalog, router}), do: {catalog, router, []}
  defp normalize_domain({catalog, router, options}), do: {catalog, router, options}
end
