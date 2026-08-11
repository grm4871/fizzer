defmodule Cascade.Auth.PasswordTest do
  use ExUnit.Case, async: true

  alias Cascade.Auth.Password

  test "matches the existing bcrypt byte boundary" do
    assert {:error, "Password must be at least 8 characters"} = Password.validate("short")
    assert :ok = Password.validate(String.duplicate("é", 36))

    assert {:error, "Password must be at most 72 UTF-8 bytes"} =
             Password.validate(String.duplicate("é", 37))
  end

  test "hashes and verifies a valid credential" do
    assert {:ok, hash} = Password.hash("correct horse battery staple")
    assert String.starts_with?(hash, "$2b$12$")
    assert Password.verify_login("correct horse battery staple", hash)
    refute Password.verify_login("wrong password", hash)
    refute Password.verify_login("wrong password", nil)
  end
end
