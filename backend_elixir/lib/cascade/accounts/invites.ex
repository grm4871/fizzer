defmodule Cascade.Accounts.Invites do
  @moduledoc "Seven-day chat/vault invite compatibility and single-use registration validation."

  alias Cascade.Accounts.{JWT, SQL}

  @ttl 7 * 24 * 60 * 60
  @roles ~w(owner editor viewer)

  def sign_vault(vault_id, role) when role in ["editor", "viewer"] do
    JWT.sign(%{"type" => "vault-invite", "vaultId" => vault_id, "role" => role}, @ttl)
  end

  def verify_vault(token) do
    with {:ok, claims} <- JWT.verify(token),
         "vault-invite" <- claims["type"],
         vault_id when is_binary(vault_id) <- claims["vaultId"],
         role when role in @roles <- claims["role"],
         false <- role == "owner" do
      {:ok, %{vault_id: vault_id, role: role}}
    else
      _ -> {:error, "Invalid invite link"}
    end
  end

  def verify_chat(token) do
    with {:ok, claims} <- JWT.verify(token),
         "chat-invite" <- claims["type"],
         vault_id when is_binary(vault_id) <- claims["sourceVaultId"],
         channel_id when is_binary(channel_id) <- claims["sourceChannelId"] do
      {:ok, %{vault_id: vault_id, channel_id: channel_id}}
    else
      _ -> {:error, "Invalid invite link"}
    end
  end

  def valid_registration_hash(raw_token) do
    token = raw_token |> to_string() |> String.trim()

    if token == "" do
      nil
    else
      token_hash = :crypto.hash(:sha256, token) |> Base.encode16(case: :lower)

      cond do
        SQL.one("SELECT 1 FROM registration_invites_used WHERE token_hash = ?", [token_hash]) ->
          nil

        valid_chat_source?(token) ->
          token_hash

        valid_vault?(token) ->
          token_hash

        true ->
          nil
      end
    end
  end

  defp valid_chat_source?(token) do
    with {:ok, invite} <- verify_chat(token) do
      SQL.one(
        """
        SELECT note.id FROM notes note JOIN vaults vault ON vault.id = note.vault_id
        WHERE note.id = ? AND vault.id = ?
        """,
        [invite.channel_id, invite.vault_id]
      ) != nil
    else
      _ -> false
    end
  end

  defp valid_vault?(token) do
    with {:ok, invite} <- verify_vault(token) do
      SQL.one("SELECT id FROM vaults WHERE id = ?", [invite.vault_id]) != nil
    else
      _ -> false
    end
  end
end
