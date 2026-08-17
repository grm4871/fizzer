defmodule Cascade.Auth.TokenTest do
  use ExUnit.Case, async: false

  alias Cascade.Auth.Token

  test "round trips the jsonwebtoken-compatible user claims" do
    user = %{id: 42, username: "sol", auth_version: 7}
    token = Token.sign_user(user)

    assert {:ok, %{id: 42, username: "sol", auth_version: 7, access: "user"}} =
             Token.verify(token)

    assert [header, _payload, _signature] = String.split(token, ".")
    assert %{"alg" => "HS256"} = header |> Base.url_decode64!(padding: false) |> Jason.decode!()
  end

  test "rejects a token signed by a different secret" do
    token = Token.sign_user(%{id: 42, username: "sol", auth_version: 0})
    previous = System.get_env("JWT_SECRET")
    System.put_env("JWT_SECRET", "different-secret")

    try do
      assert {:error, :invalid_or_expired} = Token.verify(token)
    after
      System.put_env("JWT_SECRET", previous)
    end
  end

  test "accepts pre-auth-version user sessions the Node backend still supports" do
    now = System.system_time(:second)
    signer = Joken.Signer.create("HS256", System.fetch_env!("JWT_SECRET"))

    {:ok, token, _claims} =
      Joken.encode_and_sign(
        %{
          "id" => 7,
          "username" => "legacy",
          "iat" => now,
          "exp" => now + 60
        },
        signer
      )

    assert {:ok, %{id: 7, username: "legacy", auth_version: 0, access: "user"}} =
             Token.verify(token)
  end
end
