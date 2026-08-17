defmodule CascadeWeb.StaticTest do
  use ExUnit.Case, async: true

  alias CascadeWeb.Static

  test "cache policy matches Vite fingerprint and sentinel rules" do
    assert Static.cache_control("/client/dist/assets/main-a1b2.js") ==
             "public, max-age=31536000, immutable"

    assert Static.cache_control("/client/dist/version.json") == "no-store"
    assert Static.cache_control("/client/dist/app.html") == "no-cache"
    assert Static.cache_control("/client/dist/favicon.jpeg") == nil
  end
end
