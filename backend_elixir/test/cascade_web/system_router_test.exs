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
        downloads_dir: downloads
      )

    on_exit(fn -> File.rm_rf!(root) end)
    {:ok, data: data, downloads: downloads, options: options}
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

  test "Android update metadata is public and versioned", context do
    missing = request(context, :get, "/api/system/android-update")

    assert Jason.decode!(missing.resp_body) == %{
             "available" => false,
             "url" => "/download/android",
             "versionCode" => 10,
             "versionName" => "dev-2026.08.13-native-updater"
           }

    File.write!(Path.join(context.data, "cascade-android.apk"), "apk")
    available = request(context, :get, "/api/system/android-update")
    assert Jason.decode!(available.resp_body)["available"] == true
  end

  defp request(context, method, path) do
    conn(method, path)
    |> assign(:domain_options, context.options)
    |> CascadeWeb.SystemRouter.call(context.options)
  end
end
