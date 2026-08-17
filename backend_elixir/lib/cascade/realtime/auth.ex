defmodule Cascade.Realtime.Auth do
  @moduledoc false

  alias Cascade.Auth.Token
  alias Cascade.Realtime.{AuthBatcher, VerifiedTokenCache}

  def authenticate(namespace_auth, cookie_token) do
    namespace_auth
    |> resolved_token(cookie_token)
    |> authenticate_token()
  end

  def resolved_token(namespace_auth, cookie_token), do: auth_token(namespace_auth) || cookie_token

  def authenticate_token(token) do
    case authenticate_token_with_expiration(token) do
      {:ok, identity, _expires_at} -> {:ok, identity}
      error -> error
    end
  end

  def authenticate_token_with_expiration(token) do
    with token when is_binary(token) and token != "" <- token,
         {:ok, claims, expires_at} <- VerifiedTokenCache.verify(token),
         true <- claims.access == "user",
         {:ok, user} <- AuthBatcher.fetch_by_id(claims.id),
         true <- user.username == claims.username,
         true <- user.auth_version == claims.auth_version do
      identity = %{
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        access: claims.access
      }

      {:ok, identity, expires_at}
    else
      %{access: "agent"} -> {:error, "This operation requires user access"}
      _ -> auth_error(token)
    end
  end

  def rejection_message(token) when is_binary(token) do
    case Token.verify(token) do
      {:ok, %{access: "agent"}} -> "This operation requires user access"
      _ -> "Invalid or expired token"
    end
  end

  def rejection_message(_token), do: "Invalid or expired token"

  defp auth_token(%{"token" => token}) when is_binary(token), do: token
  defp auth_token(%{token: token}) when is_binary(token), do: token
  defp auth_token(_), do: nil

  defp auth_error(token) when is_binary(token) do
    {:error, rejection_message(token)}
  end

  defp auth_error(_), do: {:error, "Invalid or expired token"}
end
