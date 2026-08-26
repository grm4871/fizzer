defmodule CascadeWeb.AccountRouter do
  @moduledoc "Mountable HTTP surface for account, vault membership, discovery, moderation, DM, activity, and battery domains."

  use Plug.Router

  import Plug.Conn
  import CascadeWeb.AccountRouterHelpers, except: [put_domain_options: 2]

  alias Cascade.Accounts.{
    AndroidBattery,
    CommunityActivity,
    DirectMessages,
    Invites,
    Moderation,
    ProductFeedback,
    PublicVaults,
    SQL,
    VaultMembers
  }

  alias Cascade.Accounts.Accounts, as: AccountDomain
  alias Cascade.Auth.Accounts, as: AuthAccounts
  alias Cascade.Auth.Session
  alias CascadeWeb.{Auth, JSON, RateLimiter}

  plug :put_domain_options
  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason,
    length: 12 * 1_024 * 1_024

  plug :dispatch

  def put_domain_options(conn, options), do: CascadeWeb.AccountRouterHelpers.put_domain_options(conn, options)

  post "/api/auth/register" do
    case AccountDomain.register(conn.body_params,
           require_invite:
             Keyword.get(
               conn.assigns.domain_options,
               :require_invite,
               Cascade.Config.require_invite_registration?()
             )
         ) do
      {:ok, user, token} -> respond_session(conn, 201, user, token)
      {:error, status, message} -> JSON.send(conn, status, %{error: message})
    end
  end

  post "/api/auth/password" do
    authenticated(conn, :account, fn conn, user ->
      case AccountDomain.change_password(
             user.id,
             body(conn, "currentPassword", ""),
             body(conn, "newPassword", "")
           ) do
        {:ok, _updated, token} ->
          notify(conn, :on_disconnect_user, user.id)
          respond_password(conn, token)

        {:error, status, message} ->
          JSON.send(conn, status, %{error: message})
      end
    end)
  end

  put "/api/me/profile" do
    authenticated(conn, :account, fn conn, user ->
      case AccountDomain.update_profile(
             user.id,
             body(conn, "displayName", ""),
             body(conn, "avatarUrl", "")
           ) do
        {:ok, profile} ->
          notify(conn, :on_profile_updated, %{userId: user.id, profile: profile})
          JSON.send(conn, 200, %{user: profile})

        {:error, status, message} ->
          JSON.send(conn, status, %{error: message})
      end
    end)
  end

  post "/api/auth/reset/issue" do
    authenticated(conn, :account, fn conn, user ->
      case AccountDomain.issue_reset(user.id, body(conn, "username", "")) do
        {:ok, result} -> JSON.send(conn, 200, result)
        {:error, status, message} -> JSON.send(conn, status, %{error: message})
      end
    end)
  end

  post "/api/auth/reset" do
    case AccountDomain.redeem_reset(body(conn, "token", ""), body(conn, "newPassword", "")) do
      {:ok, user, token} ->
        notify(conn, :on_disconnect_user, user.id)
        public = AuthAccounts.public_user(user)
        payload = %{ok: true, user: public, owner: AuthAccounts.owner?(user.id)}
        respond_session(conn, 200, user, token, payload)

      {:error, status, message} ->
        JSON.send(conn, status, %{error: message})
    end
  end

  post "/api/auth/agent-token" do
    authenticated(conn, :account, fn conn, user ->
      JSON.send(conn, 200, %{token: AccountDomain.agent_token(user)})
    end)
  end

  get "/api/admin/users" do
    authenticated(conn, nil, fn conn, user ->
      case AccountDomain.list_users(user.id) do
        {:ok, users} -> JSON.send(conn, 200, %{users: users})
        {:error, status, message} -> JSON.send(conn, status, %{error: message})
      end
    end)
  end

  get "/api/vaults/:id/members" do
    authenticated(conn, nil, fn conn, user ->
      case VaultMembers.accessible_vault(id, user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        _ ->
          JSON.send(conn, 200, %{
            members: VaultMembers.list(id),
            role: VaultMembers.role(id, user.id)
          })
      end
    end)
  end

  post "/api/vaults/:id/members" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, _vault ->
        cond do
          VaultMembers.role(id, user.id) != "owner" ->
            JSON.send(conn, 403, %{error: "Only the vault owner can invite members"})

          DirectMessages.vault_holds_direct_messages?(id) ->
            JSON.send(conn, 400, %{error: "A vault containing direct messages cannot be shared"})

          true ->
            add_member(conn, id, user.id)
        end
      end)
    end)
  end

  patch "/api/vaults/:id/members/:user_id" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, _vault ->
        update_member(conn, id, user.id, user_id)
      end)
    end)
  end

  delete "/api/vaults/:id/members/:user_id" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, _vault ->
        remove_member(conn, id, user.id, user_id)
      end)
    end)
  end

  post "/api/vaults/:id/invite-link" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, vault ->
        create_vault_invite(conn, vault, user.id)
      end)
    end)
  end

  get "/api/vault-invites/:token" do
    case resolve_vault_invite(token) do
      {:ok, invite, vault} ->
        owner = SQL.one("SELECT username FROM users WHERE id=?", [vault.created_by])

        JSON.send(conn, 200, %{
          invite: %{
            vaultName: vault.name,
            role: invite.role,
            owner: if(owner, do: hd(owner), else: "unknown")
          }
        })

      _ ->
        JSON.send(conn, 404, %{error: "Invite not found"})
    end
  end

  post "/api/vault-invites/:token/accept" do
    authenticated(conn, :account, fn conn, user -> accept_vault_invite(conn, token, user.id) end)
  end

  get "/api/vaults/:id/visibility" do
    authenticated(conn, nil, fn conn, user ->
      case VaultMembers.accessible_vault(id, user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        _ ->
          JSON.send(
            conn,
            200,
            Map.put(PublicVaults.settings(id), :role, VaultMembers.role(id, user.id))
          )
      end
    end)
  end

  put "/api/vaults/:id/visibility" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, _vault ->
        case PublicVaults.update(id, user.id, conn.body_params) do
          {:ok, settings} ->
            notify(conn, :on_visibility_changed, Map.put(settings, :vaultId, id))
            JSON.send(conn, 200, settings)

          {:error, message} ->
            domain_error(conn, message)
        end
      end)
    end)
  end

  get "/api/vaults/:id/public-home-notes" do
    vault_read(conn, id, :notes, &PublicVaults.home_note_choices/2)
  end

  get "/api/vaults/:id/join-requests" do
    vault_read(conn, id, :requests, &PublicVaults.join_requests/2)
  end

  patch "/api/vaults/:id/join-requests/:request_id" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, _vault ->
        review_join_request(conn, id, request_id, user.id)
      end)
    end)
  end

  get "/api/public-vaults" do
    authenticated(conn, nil, fn conn, user ->
      options = [
        query: query(conn, "q", ""),
        limit: number_query(conn, "limit"),
        offset: number_query(conn, "offset")
      ]

      JSON.send(conn, 200, %{vaults: PublicVaults.list(user.id, options)})
    end)
  end

  get "/api/public-vaults/:id" do
    authenticated(conn, nil, fn conn, user ->
      case PublicVaults.detail(id, user.id) do
        nil -> JSON.send(conn, 404, %{error: "Vault not found"})
        vault -> JSON.send(conn, 200, %{vault: vault})
      end
    end)
  end

  post "/api/public-vaults/:id/join" do
    authenticated(conn, :account, fn conn, user ->
      case PublicVaults.join(id, user.id) do
        {:ok, result} ->
          notify(conn, :on_vault_members_changed, %{vaultId: id})
          JSON.send(conn, if(result.alreadyMember, do: 200, else: 201), result)

        {:error, message} ->
          domain_error(conn, message)
      end
    end)
  end

  get "/api/vaults/:id/bans" do
    vault_read(conn, id, :bans, &Moderation.list_bans/2)
  end

  post "/api/vaults/:id/bans" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, _vault ->
        case Moderation.ban(id, user.id, integer(body(conn, "userId")), body(conn, "reason")) do
          {:ok, ban} ->
            notify(conn, :on_vault_members_changed, %{vaultId: id})
            JSON.send(conn, 201, %{ban: ban})

          {:error, message} ->
            domain_error(conn, message)
        end
      end)
    end)
  end

  delete "/api/vaults/:id/bans/:user_id" do
    authenticated(conn, :vault, fn conn, user ->
      with_vault(conn, id, user.id, fn conn, _vault ->
        case Moderation.unban(id, user.id, integer(user_id)) do
          :ok -> JSON.send(conn, 200, %{ok: true})
          {:error, message} -> domain_error(conn, message)
        end
      end)
    end)
  end

  post "/api/vaults/:id/reports" do
    authenticated(conn, :vault, fn conn, user -> create_report(conn, id, user.id) end)
  end

  get "/api/vaults/:id/reports" do
    authenticated(conn, nil, fn conn, user -> list_vault_reports(conn, id, user.id) end)
  end

  patch "/api/vaults/:id/reports/:report_id" do
    authenticated(conn, :vault, fn conn, user ->
      review_vault_report(conn, id, report_id, user.id)
    end)
  end

  get "/api/admin/reports" do
    authenticated(conn, nil, fn conn, user -> list_admin_reports(conn, user.id) end)
  end

  patch "/api/admin/reports/:report_id" do
    authenticated(conn, :account, fn conn, user ->
      review_admin_report(conn, report_id, user.id)
    end)
  end

  post "/api/product-feedback" do
    authenticated(conn, :account, fn conn, user ->
      case RateLimiter.check(:product_feedback, user.id, 10, 60_000) do
        :ok ->
          case ProductFeedback.create(user.id, conn.body_params) do
            {:ok, feedback} -> JSON.send(conn, 201, %{feedback: feedback})
            {:error, message} -> JSON.send(conn, 400, %{error: message})
          end

        {:error, retry_after} ->
          conn
          |> put_resp_header("retry-after", Integer.to_string(retry_after))
          |> JSON.send(429, %{error: "Too many feedback submissions. Try again shortly."})
      end
    end)
  end

  get "/api/admin/product-feedback" do
    authenticated(conn, nil, fn conn, user ->
      case ProductFeedback.list(user.id, query(conn, "status", "open")) do
        {:ok, feedback} -> JSON.send(conn, 200, %{feedback: feedback})
        {:error, message} -> domain_error(conn, message)
      end
    end)
  end

  patch "/api/admin/product-feedback/:feedback_id" do
    authenticated(conn, :account, fn conn, user ->
      case positive_integer(feedback_id, "Invalid feedback id") do
        {:ok, id} ->
          case ProductFeedback.review(id, user.id, body(conn, "action")) do
            {:ok, feedback} -> JSON.send(conn, 200, %{feedback: feedback})
            {:error, message} -> domain_error(conn, message)
          end

        {:error, message} ->
          JSON.send(conn, 400, %{error: message})
      end
    end)
  end

  get "/api/me/dm-settings" do
    authenticated(conn, nil, fn conn, user ->
      JSON.send(conn, 200, %{allowDirectMessages: DirectMessages.allows?(user.id)})
    end)
  end

  put "/api/me/dm-settings" do
    authenticated(conn, :account, fn conn, user ->
      case body(conn, "allowDirectMessages") do
        allow when is_boolean(allow) ->
          JSON.send(conn, 200, %{allowDirectMessages: DirectMessages.set_allows(user.id, allow)})

        _ ->
          JSON.send(conn, 400, %{error: "allowDirectMessages must be a boolean"})
      end
    end)
  end

  get "/api/me/blocks" do
    authenticated(conn, nil, fn conn, user ->
      JSON.send(conn, 200, %{blocks: DirectMessages.list_blocks(user.id)})
    end)
  end

  post "/api/me/blocks" do
    authenticated(conn, :account, fn conn, user ->
      username_limited(conn, user.id, fn conn -> block_user(conn, user.id) end)
    end)
  end

  delete "/api/me/blocks/:username" do
    authenticated(conn, :account, fn conn, user ->
      username_limited(conn, user.id, fn conn ->
        with {:ok, target} <- DirectMessages.resolve_user(username),
             do: DirectMessages.unblock(user.id, target.id)

        JSON.send(conn, 200, %{ok: true})
      end)
    end)
  end

  get "/api/me/direct-messages" do
    authenticated(conn, nil, fn conn, user ->
      JSON.send(conn, 200, %{conversations: DirectMessages.list(user.id)})
    end)
  end

  post "/api/direct-messages" do
    authenticated(conn, :account, fn conn, user ->
      username_limited(conn, user.id, fn conn -> open_direct_message(conn, user.id) end)
    end)
  end

  get "/api/community/updates" do
    authenticated(conn, nil, fn conn, user ->
      JSON.send(
        conn,
        200,
        CommunityActivity.list(
          user,
          number_query(conn, "limit"),
          query(conn, "includeAgentMemory") == "1"
        )
      )
    end)
  end

  post "/api/community/updates/read" do
    authenticated(conn, :account, fn conn, user ->
      target_id = body(conn, "targetId", "") |> to_string() |> String.trim()

      cond do
        target_id == "" ->
          JSON.send(conn, 400, %{error: "targetId is required"})

        CommunityActivity.mark_read(user.id, target_id) ->
          notify(conn, :on_community_changed, user.id)
          JSON.send(conn, 200, %{ok: true})

        true ->
          JSON.send(conn, 404, %{error: "Update source not found"})
      end
    end)
  end

  post "/api/community/updates/read-all" do
    authenticated(conn, :account, fn conn, user ->
      CommunityActivity.mark_all_read(user.id)
      notify(conn, :on_community_changed, user.id)
      JSON.send(conn, 200, %{ok: true})
    end)
  end

  post "/api/diagnostics/android-battery" do
    authenticated(conn, :account, fn conn, user ->
      with {:ok, sample} <- AndroidBattery.parse(conn.body_params),
           :ok <- AndroidBattery.record(user.id, sample) do
        JSON.send(conn, 202, %{ok: true})
      else
        {:error, message} -> JSON.send(conn, 400, %{error: message})
      end
    end)
  end

  get "/api/diagnostics/android-battery" do
    authenticated(conn, nil, fn conn, user ->
      all_users = query(conn, "all") == "1"

      if all_users and not AuthAccounts.owner?(user.id) do
        JSON.send(conn, 403, %{error: "Owner only"})
      else
        JSON.send(conn, 200, %{
          samples:
            AndroidBattery.list(if(all_users, do: nil, else: user.id), number_query(conn, "days"))
        })
      end
    end)
  end

  match _ do
    JSON.send(conn, 404, %{error: "Not found"})
  end

end
