defmodule CascadeWeb.SystemRouterTest do
  use ExUnit.Case, async: true

  import Plug.Conn
  import Plug.Test

  setup do
    root = Path.join(System.tmp_dir!(), "cascade-system-#{System.unique_integer([:positive])}")
    data = Path.join(root, "data")
    client = Path.join(root, "client")
    downloads = Path.join(root, "downloads")
    Enum.each([data, client, downloads], &File.mkdir_p!/1)

    options =
      CascadeWeb.SystemRouter.init(
        data_dir: data,
        client_dir: client,
        downloads_dir: downloads,
        deploy_secret: "deploy-test-secret"
      )

    on_exit(fn -> File.rm_rf!(root) end)
    {:ok, data: data, downloads: downloads, options: options}
  end

  test "deploy queue uses constant-time bearer/header auth and preserves status", context do
    missing = request(context, :post, "/api/deploy", %{ref: "main"})
    assert missing.status == 401
    assert Jason.decode!(missing.resp_body) == %{"error" => "Deploy token required"}

    invalid = request(context, :post, "/api/deploy", %{ref: "main"}, "wrong")
    assert invalid.status == 401

    queued =
      request(context, :post, "/api/admin/deploy", %{ref: "  main  "}, "deploy-test-secret")

    assert queued.status == 202
    assert Jason.decode!(queued.resp_body) == %{"ref" => "main", "status" => "queued"}

    File.write!(
      Path.join(context.data, "deploy.result"),
      Jason.encode!(%{status: "ok", commit: "abc123"})
    )

    status = request(context, :get, "/api/deploy/status", nil, "deploy-test-secret")

    assert Jason.decode!(status.resp_body) == %{
             "pending" => true,
             "last" => %{"status" => "ok", "commit" => "abc123"}
           }
  end

  test "installer routes serve fixed files and clear missing-build errors", context do
    unknown = request(context, :get, "/download/plan9")
    assert unknown.status == 404
    assert Jason.decode!(unknown.resp_body) == %{"error" => "Unknown platform"}

    missing = request(context, :get, "/download/windows")
    assert missing.status == 404
    assert Jason.decode!(missing.resp_body)["platform"] == "windows"

    installer = Path.join(context.downloads, "Fizzer-Setup.exe")
    File.write!(installer, "installer")
    served = request(context, :get, "/download/windows")
    assert served.status == 200
    assert served.resp_body == "installer"

    assert get_resp_header(served, "content-disposition") == [
             ~s(attachment; filename="Fizzer-Setup.exe")
           ]

    chooser = request(context, :get, "/download/mac")
    assert chooser.status == 200
    assert chooser.resp_body =~ "/download/mac-arm64"
    assert chooser.resp_body =~ "/download/mac-x64"
  end

  defp request(context, method, path, body \\ nil, token \\ nil) do
    conn =
      if is_nil(body) do
        conn(method, path)
      else
        conn(method, path, Jason.encode!(body))
        |> put_req_header("content-type", "application/json")
      end

    conn = if token, do: put_req_header(conn, "authorization", "Bearer #{token}"), else: conn

    conn
    |> assign(:domain_options, context.options)
    |> CascadeWeb.SystemRouter.call(context.options)
  end
end
