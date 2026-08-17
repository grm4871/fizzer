defmodule CascadeWeb.DomainDispatchTest do
  use ExUnit.Case, async: true

  import Plug.Conn
  import Plug.Test

  alias CascadeWeb.DomainDispatch

  defmodule ExampleCatalog do
    def catalog,
      do: [
        {"GET", "/api/vaults/:id"},
        {"POST", "/api/vaults/:id/notes"}
      ]
  end

  defmodule ExampleRouter do
    use Plug.Router

    plug :match
    plug :dispatch

    get "/api/vaults/:id", do: send_resp(conn, 200, id)
    post "/api/vaults/:id/notes", do: send_resp(conn, 201, id)
  end

  defmodule OptionRouter do
    def init(options), do: options
    def call(conn, options), do: send_resp(conn, 200, Keyword.fetch!(options, :body))
  end

  test "matches exact methods and dynamic path segments" do
    assert DomainDispatch.matches?("GET", "/api/vaults/v1", {"GET", "/api/vaults/:id"})
    refute DomainDispatch.matches?("POST", "/api/vaults/v1", {"GET", "/api/vaults/:id"})

    refute DomainDispatch.matches?(
             "GET",
             "/api/vaults/v1/notes",
             {"GET", "/api/vaults/:id"}
           )
  end

  test "delegates only a declared route and preserves path params" do
    assert {:handled, response} =
             conn(:get, "/api/vaults/v1")
             |> DomainDispatch.dispatch([{ExampleCatalog, ExampleRouter}])

    assert response.status == 200
    assert response.resp_body == "v1"

    assert :not_found =
             conn(:delete, "/api/vaults/v1")
             |> DomainDispatch.dispatch([{ExampleCatalog, ExampleRouter}])
  end

  test "supports an explicit terminal wildcard contract" do
    assert DomainDispatch.matches?("GET", "/anything/here", {"GET", "*"})
    refute DomainDispatch.matches?("POST", "/anything/here", {"GET", "*"})
  end

  test "passes isolated router options without leaking them into dispatch" do
    assert {:handled, response} =
             conn(:get, "/api/vaults/v1")
             |> DomainDispatch.dispatch([
               {ExampleCatalog, OptionRouter, body: "configured"}
             ])

    assert response.resp_body == "configured"
  end
end
