defmodule CascadeWeb.OrchestrationRunController do
  @moduledoc "HTTP endpoints for desktop-agent runs, including status, events, and cancellation."

  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Auth.Session
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Runs.{PromptContext, RunnerLifecycle, Store}
  alias CascadeWeb.JSON
  import CascadeWeb.OrchestrationHTTP

  def list_runs(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      with_vault(conn, vault_id, user.id, fn ->
        JSON.send(conn, 200, %{runs: Store.list(vault_id, user.id)})
      end)
    end)
  end

  def active_sessions(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      with_vault(conn, vault_id, user.id, fn ->
        JSON.send(conn, 200, %{sessions: Store.active_sessions(user.id, vault_id)})
      end)
    end)
  end

  def my_active_sessions(conn) do
    authenticated(conn, fn conn, user ->
      JSON.send(conn, 200, %{sessions: Store.active_sessions(user.id)})
    end)
  end

  def local_agents(conn) do
    authenticated(conn, fn conn, _user ->
      # The production release does not share a host filesystem with desktop
      # Claude/Codex sessions. Match the Node route's documented cloud fallback
      # instead of leaking the request through the parity boundary.
      JSON.send(conn, 200, %{
        nodes: [],
        edges: [],
        scannedAt: System.system_time(:millisecond)
      })
    end)
  end

  def create_run(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      case VaultMembers.accessible_vault(vault_id, user.id) do
        nil -> JSON.send(conn, 404, %{error: "Vault not found"})
        vault -> create_direct_run(conn, user, vault)
      end
    end)
  end

  def get_run(conn, raw_id) do
    authenticated(conn, fn conn, user ->
      with_run_access(conn, raw_id, user.id, fn run -> JSON.send(conn, 200, %{run: run}) end)
    end)
  end

  def run_events(conn, raw_id) do
    authenticated(conn, fn conn, user ->
      with_run_access(conn, raw_id, user.id, fn run ->
        JSON.send(conn, 200, %{events: Store.events(run.id)})
      end)
    end)
  end

  def runner_status(conn) do
    authenticated(conn, fn conn, user -> JSON.send(conn, 200, RunnerLifecycle.health(user.id)) end)
  end

  def cancel_run(conn, raw_id) do
    authenticated(conn, fn conn, user ->
      case parse_id(raw_id) |> then(&if(&1, do: Store.get(&1), else: nil)) do
        nil ->
          JSON.send(conn, 404, %{error: "Run not found"})

        run ->
          if Store.owned?(run.id, user.id) do
            success =
              Store.cancel(run.id,
                steering: body(conn)["steering"] == true,
                force: body(conn)["steering"] != true
              )

            JSON.send(conn, 200, %{success: success})
          else
            JSON.send(conn, 404, %{error: "Run not found"})
          end
      end
    end)
  end
  defp create_direct_run(conn, user, vault) do
    params = body(conn)
    prompt = params["prompt"] |> to_string() |> String.trim()

    cond do
      prompt == "" ->
        JSON.send(conn, 400, %{error: "Prompt is required"})

      params["chatDispatchId"] || is_map(params["chat"]) ->
        create_chat_run(conn, user, vault, params, prompt)

      not RunnerLifecycle.wait_online(user.id) ->
        JSON.send(conn, 503, %{
          error:
            "No desktop agent runner is connected. Open Fizzer on your computer (signed in to the same account) to run agents from chat."
        })

      true ->
        agent = if Store.valid_agent?(params["agent"]), do: params["agent"], else: "claude-code"
        note_id = blank_nil(params["note_id"])
        conversation_id = blank_nil(params["conversation_id"])
        model = PromptContext.normalize_model(params["model"])
        context_mode = PromptContext.normalize_context_mode(params["contextMode"])
        sandbox = PromptContext.normalize_sandbox(params["sandbox"])

        resume_session_id =
          if conversation_id do
            Store.find_conversation_session(%{
              vault_id: vault.id,
              note_id: note_id,
              agent: agent,
              conversation_id: conversation_id
            })
          end

        effective_prompt =
          PromptContext.enrich_prompt(
            vault.id,
            user.id,
            prompt,
            agent,
            resume_session_id,
            context_mode
          )

        case Store.start(vault.id, note_id, effective_prompt, agent,
               owner_user_id: user.id,
               conversation_id: conversation_id,
               model: model,
               session_id: resume_session_id
             ) do
          {:ok, run} ->
            delegate_or_fail(
              conn,
              user.id,
              vault.id,
              run,
              agent,
              effective_prompt,
              resume_session_id,
              params,
              %{context_mode: context_mode, sandbox: sandbox}
            )

          {:error, message} ->
            JSON.send(conn, 500, %{error: message})
        end
    end
  end
  defp create_chat_run(conn, user, vault, params, prompt), do: CascadeWeb.OrchestrationChatRunController.create(conn, user, vault, params, prompt)
  defp delegate_or_fail(
         conn,
         user_id,
         vault_id,
         run,
         agent,
         prompt,
         resume_session_id,
         params,
         runtime
       ) do
    vault_root = ContentStore.get_vault(vault_id, user_id).root_path

    delegated =
      RunnerLifecycle.delegate(
        user_id,
        PromptContext.delegate_payload(
          run,
          vault_root,
          agent,
          prompt,
          params,
          resume_session_id,
          runtime
        )
      )

    if delegated do
      JSON.send(conn, 200, %{run: run, reused: false})
    else
      error =
        "Desktop agent runner disconnected before the run could start. Open Fizzer on your computer and try again."

      Store.finish(run.id, "failed", error)
      Store.publish(run.id, "status", %{status: "failed", summary: error})
      JSON.send(conn, 503, %{error: error})
    end
  end

  defp with_run_access(conn, raw_id, user_id, callback) do
    case parse_id(raw_id) |> then(&if(&1, do: Store.get(&1), else: nil)) do
      nil -> JSON.send(conn, 404, %{error: "Run not found"})
      run -> if Store.owned?(run.id, user_id), do: callback.(run), else: JSON.send(conn, 404, %{error: "Run not found"})
    end
  end

end
