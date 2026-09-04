defmodule CascadeWeb.DomainDispatchTest do
  use ExUnit.Case, async: true

  import Plug.Conn
  import Plug.Test

  alias CascadeWeb.DomainDispatch

  defmodule ExampleRouter do
    use CascadeWeb.DomainDispatch

    plug :match
    plug Plug.Parsers, parsers: [:json], json_decoder: Jason
    plug :dispatch

    get "/api/vaults/:id", do: send_resp(conn, 200, id)
    post "/api/vaults/:id/notes", do: send_resp(conn, 201, id)
    get "/p/:slug.json", do: send_resp(conn, 200, "json:" <> slug)
    get "/p/:slug", do: send_resp(conn, 200, "page:" <> slug)
    get "/files/*rest", do: send_resp(conn, 200, Enum.join(rest, "/"))
    match _, do: send_resp(conn, 404, "not found")
  end

  defmodule OptionRouter do
    use CascadeWeb.DomainDispatch

    plug :match
    plug :dispatch

    get "/api/vaults/:id", do: send_resp(conn, 200, conn.assigns.domain_options[:body])
    match _, do: send_resp(conn, 404, "not found")
  end

  @domains [{ExampleRouter, ExampleRouter}]

  test "catalog comes from declarations in matching order and excludes fallback" do
    assert ExampleRouter.catalog() == [
             {"GET", "/api/vaults/:id"},
             {"POST", "/api/vaults/:id/notes"},
             {"GET", "/p/:slug.json"},
             {"GET", "/p/:slug"},
             {"GET", "/files/*rest"}
           ]
  end

  test "delegates declared paths with Plug decoding, suffix, wildcard, and precedence semantics" do
    for {method, path} <- [delete: "/api/vaults/v1", get: "/api/vaults/v1/notes"] do
      assert :not_found = DomainDispatch.dispatch(conn(method, path), @domains)
    end

    for {path, body} <- [
          {"/api/vaults/v%201", "v 1"},
          {"/p/example.json", "json:example"},
          {"/p/example", "page:example"},
          {"/files/a/b", "a/b"},
          {"/files", ""}
        ] do
      assert {:handled, response} = DomainDispatch.dispatch(conn(:get, path), @domains)
      assert response.status == 200
      assert response.resp_body == body
    end
  end

  test "first matching domain wins and receives its runtime options" do
    assert {:handled, response} =
             DomainDispatch.dispatch(conn(:get, "/api/vaults/v1"), [
               {OptionRouter, OptionRouter, body: "configured"},
               {ExampleRouter, ExampleRouter}
             ])

    assert response.resp_body == "configured"
  end

  test "skips an unmatched domain without leaking its fallback params" do
    request =
      conn(:get, "/p/example.json")
      |> put_private(:plug_route, {"/*_path", fn conn, _ -> conn end})

    assert {:handled, response} =
             DomainDispatch.dispatch(request, [
               {OptionRouter, OptionRouter},
               {ExampleRouter, ExampleRouter}
             ])

    assert response.resp_body == "json:example"
    assert response.path_params == %{"slug" => "example"}
  end

  test "selection does not parse unmatched bodies or leak speculative path params" do
    request =
      conn(:post, "/missing", "invalid json")
      |> put_req_header("content-type", "application/json")

    assert :not_found = DomainDispatch.dispatch(request, @domains)
    assert request.path_params == %{}
    assert {:ok, "invalid json", _conn} = read_body(request)
  end
end
