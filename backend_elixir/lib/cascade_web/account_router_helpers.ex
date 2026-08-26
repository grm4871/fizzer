defmodule CascadeWeb.AccountRouterHelpers do
  @moduledoc "Shared account-router authentication, response, membership, moderation, and query helpers."

  import Plug.Conn

  alias Cascade.Accounts.{
    DirectMessages,
    Invites,
    Moderation,
    PublicVaults,
    SQL,
    VaultMembers
  }

  alias Cascade.Auth.Accounts, as: AuthAccounts
  alias Cascade.Auth.Session
  alias CascadeWeb.{Auth, JSON, RateLimiter}

  def authenticated(conn, gate, fun) do
    options = [access: :user] ++ mutation_option(gate)

    case Auth.require(conn, options) do
      {:ok, conn} -> fun.(conn, conn.assigns.current_user)
      {:error, conn} -> conn
    end
  end

  def mutation_option(nil), do: []
  def mutation_option(:account), do: [mutation_gate: :not_vault_scoped]
  def mutation_option(:vault), do: [mutation_gate: &VaultMembers.mutation_gate/2]

  def with_vault(conn, vault_id, user_id, fun) do
    case VaultMembers.accessible_vault(vault_id, user_id) do
      nil -> JSON.send(conn, 404, %{error: "Vault not found"})
      vault -> fun.(conn, vault)
    end
  end

  def vault_read(conn, vault_id, key, fun) do
    authenticated(conn, nil, fn conn, user ->
      with_vault(conn, vault_id, user.id, fn conn, _vault ->
        case fun.(vault_id, user.id) do
          {:ok, value} -> JSON.send(conn, 200, %{key => value})
          {:error, message} -> domain_error(conn, message)
        end
      end)
    end)
  end

  def add_member(conn, vault_id, actor_id) do
    username =
      body(conn, "username", "")
      |> to_string()
      |> String.trim()
      |> String.replace(~r/^@+/, "")
      |> String.downcase()

    role = body(conn, "role", "editor") |> to_string() |> String.trim() |> String.downcase()

    cond do
      username == "" ->
        JSON.send(conn, 400, %{error: "Username is required"})

      role not in ["editor", "viewer"] ->
        JSON.send(conn, 400, %{error: "Role must be editor or viewer"})

      true ->
        case SQL.one("SELECT id FROM users WHERE username=?", [username]) do
          nil ->
            JSON.send(conn, 404, %{error: "User not found"})

          [target_id] ->
            case VaultMembers.add(vault_id, actor_id, target_id, role) do
              {:ok, member} ->
                notify(conn, :on_vault_members_changed, %{vaultId: vault_id})
                JSON.send(conn, 201, %{member: member})

              {:error, message} ->
                JSON.send(conn, 400, %{error: message})
            end
        end
    end
  end

  def update_member(conn, vault_id, actor_id, user_id_raw) do
    role = body(conn, "role", "") |> to_string() |> String.trim() |> String.downcase()

    cond do
      VaultMembers.role(vault_id, actor_id) != "owner" ->
        JSON.send(conn, 403, %{error: "Only the vault owner can change roles"})

      is_nil(integer(user_id_raw)) ->
        JSON.send(conn, 400, %{error: "Invalid user id"})

      role not in ["editor", "viewer"] ->
        JSON.send(conn, 400, %{error: "Role must be editor or viewer"})

      true ->
        case VaultMembers.set_role(vault_id, actor_id, integer(user_id_raw), role) do
          {:ok, member} ->
            notify(conn, :on_vault_members_changed, %{vaultId: vault_id})
            JSON.send(conn, 200, %{member: member})

          {:error, message} ->
            JSON.send(conn, 400, %{error: message})
        end
    end
  end

  def remove_member(conn, vault_id, actor_id, user_id_raw) do
    target_id = integer(user_id_raw)

    cond do
      is_nil(target_id) ->
        JSON.send(conn, 400, %{error: "Invalid user id"})

      target_id != actor_id and VaultMembers.role(vault_id, actor_id) != "owner" ->
        JSON.send(conn, 403, %{error: "Only the vault owner can remove members"})

      true ->
        case VaultMembers.remove(vault_id, actor_id, target_id) do
          :ok ->
            notify(conn, :on_vault_members_changed, %{vaultId: vault_id})
            JSON.send(conn, 200, %{ok: true})

          {:error, message} ->
            JSON.send(conn, 400, %{error: message})
        end
    end
  end

  def create_vault_invite(conn, vault, actor_id) do
    role = body(conn, "role", "editor") |> to_string() |> String.trim() |> String.downcase()

    cond do
      VaultMembers.role(vault.id, actor_id) != "owner" ->
        JSON.send(conn, 403, %{error: "Only the vault owner can create invite links"})

      DirectMessages.vault_holds_direct_messages?(vault.id) ->
        JSON.send(conn, 400, %{error: "A vault containing direct messages cannot be shared"})

      role not in ["editor", "viewer"] ->
        JSON.send(conn, 400, %{error: "Role must be editor or viewer"})

      true ->
        token = Invites.sign_vault(vault.id, role)

        JSON.send(conn, 200, %{
          token: token,
          role: role,
          url: "#{public_base_url(conn)}/vault-invite/#{URI.encode(token)}"
        })
    end
  end

  def resolve_vault_invite(token) do
    with {:ok, invite} <- Invites.verify_vault(token),
         [id, name, created_by] <-
           SQL.one("SELECT id,name,created_by FROM vaults WHERE id=?", [invite.vault_id]),
         false <- DirectMessages.vault_holds_direct_messages?(id) do
      {:ok, invite, %{id: id, name: name, created_by: created_by}}
    else
      _ -> :error
    end
  end

  def accept_vault_invite(conn, token, user_id) do
    case resolve_vault_invite(token) do
      {:ok, invite, vault} ->
        case VaultMembers.role(vault.id, user_id) do
          role when is_binary(role) ->
            JSON.send(conn, 200, %{
              vaultId: vault.id,
              name: vault.name,
              role: role,
              alreadyMember: true
            })

          nil ->
            case VaultMembers.add(vault.id, vault.created_by, user_id, invite.role) do
              {:ok, _member} ->
                notify(conn, :on_vault_members_changed, %{vaultId: vault.id})
                JSON.send(conn, 201, %{vaultId: vault.id, name: vault.name, role: invite.role})

              {:error, message} ->
                JSON.send(conn, 400, %{error: message})
            end
        end

      :error ->
        JSON.send(conn, 404, %{error: "Invite not found"})
    end
  end

  def review_join_request(conn, vault_id, request_id_raw, actor_id) do
    case positive_integer(request_id_raw, "Invalid join request id") do
      {:error, message} ->
        JSON.send(conn, 400, %{error: message})

      {:ok, request_id} ->
        case PublicVaults.review_join(vault_id, request_id, actor_id, body(conn, "action")) do
          {:ok, result} ->
            if result.role, do: notify(conn, :on_vault_members_changed, %{vaultId: vault_id})
            JSON.send(conn, 200, result)

          {:error, message} ->
            domain_error(conn, message)
        end
    end
  end

  def create_report(conn, vault_id, user_id) do
    input = %{
      vault_id: vault_id,
      reporter_user_id: user_id,
      target_type: body(conn, "targetType"),
      target_id: body(conn, "targetId"),
      reason: body(conn, "reason"),
      detail: body(conn, "detail")
    }

    case Moderation.create_report(input) do
      {:ok, report} -> JSON.send(conn, 201, %{report: report})
      {:error, message} -> domain_error(conn, message)
    end
  end

  def list_vault_reports(conn, vault_id, actor_id) do
    status = query(conn, "status", "open")

    cond do
      status != "all" and not Moderation.report_status?(status) ->
        JSON.send(conn, 400, %{error: "Invalid report status"})

      is_nil(VaultMembers.accessible_vault(vault_id, actor_id)) ->
        JSON.send(conn, 404, %{error: "Vault not found"})

      true ->
        case Moderation.list_vault_reports(vault_id, actor_id, status) do
          {:ok, reports} -> JSON.send(conn, 200, %{reports: reports})
          {:error, message} -> domain_error(conn, message)
        end
    end
  end

  def review_vault_report(conn, vault_id, report_id_raw, actor_id) do
    with true <- not is_nil(VaultMembers.accessible_vault(vault_id, actor_id)),
         {:ok, report_id} <- positive_integer(report_id_raw, "Invalid report id") do
      case Moderation.review_vault_report(vault_id, report_id, actor_id, body(conn, "action")) do
        {:ok, report} -> JSON.send(conn, 200, %{report: report})
        {:error, message} -> domain_error(conn, message)
      end
    else
      false -> JSON.send(conn, 404, %{error: "Vault not found"})
      {:error, message} -> JSON.send(conn, 400, %{error: message})
    end
  end

  def list_admin_reports(conn, actor_id) do
    status = query(conn, "status", "open")

    cond do
      status != "all" and not Moderation.report_status?(status) ->
        JSON.send(conn, 400, %{error: "Invalid report status"})

      true ->
        case Moderation.list_global_reports(actor_id, status) do
          {:ok, reports} -> JSON.send(conn, 200, %{reports: reports})
          {:error, message} -> domain_error(conn, message)
        end
    end
  end

  def review_admin_report(conn, report_id_raw, actor_id) do
    case positive_integer(report_id_raw, "Invalid report id") do
      {:error, message} ->
        JSON.send(conn, 400, %{error: message})

      {:ok, report_id} ->
        case Moderation.review_global_report(report_id, actor_id, body(conn, "action")) do
          {:ok, result} -> JSON.send(conn, 200, result)
          {:error, message} -> domain_error(conn, message)
        end
    end
  end

  def block_user(conn, user_id) do
    case DirectMessages.resolve_user(body(conn, "username")) do
      {:error, _} ->
        JSON.send(conn, 403, %{error: DirectMessages.unreachable_message()})

      {:ok, target} ->
        case DirectMessages.block(user_id, target.id) do
          {:ok, block} -> JSON.send(conn, 201, %{block: block})
          {:error, message} -> JSON.send(conn, 400, %{error: message})
        end
    end
  end

  def open_direct_message(conn, user_id) do
    case DirectMessages.open(user_id, body(conn, "username"),
           on_channel_created: callback(conn, :on_channel_created)
         ) do
      {:ok, result} ->
        JSON.send(conn, if(result.created, do: 201, else: 200), result)

      {:error, "This user is not accepting direct messages" = message} ->
        JSON.send(conn, 403, %{error: message})

      {:error, "Unblock @" <> _ = message} ->
        JSON.send(conn, 403, %{error: message})

      {:error, message} ->
        JSON.send(conn, 400, %{error: message})
    end
  end

  def username_limited(conn, user_id, fun) do
    case RateLimiter.check(:username_action, user_id, 20, 60_000) do
      :ok ->
        fun.(conn)

      {:error, retry_after} ->
        conn
        |> put_resp_header("retry-after", Integer.to_string(retry_after))
        |> JSON.send(429, %{error: "Too many direct message attempts. Please try again shortly."})
    end
  end

  def domain_error(conn, message) do
    status =
      cond do
        message in [
          "Vault not found",
          "Join request not found",
          "Report not found",
          "Feedback not found"
        ] ->
          404

        String.starts_with?(message, "Only the vault owner") or message == "Owner only" ->
          403

        true ->
          400
      end

    JSON.send(conn, status, %{error: message})
  end

  def respond_session(conn, status, user, token, payload \\ nil) do
    browser? = get_req_header(conn, "x-cascade-browser") == ["1"]
    base = payload || %{user: AuthAccounts.public_user(user), owner: AuthAccounts.owner?(user.id)}
    response = if browser?, do: base, else: Map.put(base, :token, token)
    conn |> Session.put_user_cookie(token) |> JSON.send(status, response)
  end

  def respond_password(conn, token) do
    browser? = get_req_header(conn, "x-cascade-browser") == ["1"]
    payload = if browser?, do: %{ok: true}, else: %{ok: true, token: token}
    conn |> Session.put_user_cookie(token) |> JSON.send(200, payload)
  end

  def public_base_url(conn) do
    case Keyword.get(conn.assigns.domain_options, :public_base_url) do
      value when is_binary(value) ->
        String.trim_trailing(value, "/")

      fun when is_function(fun, 1) ->
        fun.(conn) |> String.trim_trailing("/")

      _ ->
        "#{conn.scheme}://#{conn.host}#{if conn.port in [80, 443], do: "", else: ":#{conn.port}"}"
    end
  end

  def notify(conn, key, payload) do
    case callback(conn, key) do
      fun when is_function(fun, 1) -> fun.(payload)
      _ -> :ok
    end
  end

  def callback(conn, key), do: Keyword.get(conn.assigns.domain_options, key)

  def put_domain_options(%{assigns: %{domain_options: _options}} = conn, _compiled), do: conn
  def put_domain_options(conn, options), do: assign(conn, :domain_options, options)
  def body(conn, key, default \\ nil), do: Map.get(conn.body_params, key, default)

  def query(conn, key, default \\ nil) do
    conn = fetch_query_params(conn)
    Map.get(conn.query_params, key, default)
  end

  def number_query(conn, key) do
    case query(conn, key) do
      value when is_binary(value) ->
        case Float.parse(value) do
          {number, ""} -> number
          _ -> nil
        end

      value when is_number(value) ->
        value

      _ ->
        nil
    end
  end

  def integer(value) when is_integer(value), do: value
  def integer(value) when is_float(value) and trunc(value) == value, do: trunc(value)

  def integer(value) when is_binary(value) do
    case Integer.parse(value) do
      {number, ""} -> number
      _ -> nil
    end
  end

  def integer(_), do: nil

  def positive_integer(value, message) do
    case integer(value) do
      number when is_integer(number) and number > 0 -> {:ok, number}
      _ -> {:error, message}
    end
  end
end
