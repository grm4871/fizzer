defmodule Cascade.Accounts.JWT do
  @moduledoc false

  def sign(claims, ttl_seconds, secret \\ Cascade.Config.jwt_secret!()) do
    now = System.system_time(:second)
    signer = Joken.Signer.create("HS256", secret)

    {:ok, token, _claims} =
      Joken.encode_and_sign(
        Map.merge(%{"iat" => now, "exp" => now + ttl_seconds}, claims),
        signer
      )

    token
  end

  def verify(token, secret \\ Cascade.Config.jwt_secret!()) when is_binary(token) do
    signer = Joken.Signer.create("HS256", secret)

    with {:ok, claims} <- Joken.verify(token, signer),
         exp when is_integer(exp) <- claims["exp"],
         true <- exp > System.system_time(:second) do
      {:ok, claims}
    else
      _ -> {:error, :invalid}
    end
  end

  def peek(token) do
    case Joken.peek_claims(token) do
      {:ok, claims} -> {:ok, claims}
      _ -> {:error, :invalid}
    end
  end
end
