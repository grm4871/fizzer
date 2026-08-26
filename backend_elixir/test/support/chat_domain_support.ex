defmodule Cascade.ChatDomainTestSupport do
  @moduledoc "Shared isolated database setup and HTTP/query helpers for chat contract tests."

  import Plug.Conn
  import Plug.Test
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Channel, Schema}
  alias Cascade.Content.Store

  def setup do
    root = Path.join(System.tmp_dir!(), "cascade-elixir-chat-#{System.unique_integer([:positive])}")
    previous = System.get_env("CASCADE_VAULTS_BASE_DIR")
    System.put_env("CASCADE_VAULTS_BASE_DIR", root)
    Cascade.Accounts.Schema.ensure!()
    Cascade.Runs.Schema.ensure!()
    Schema.ensure!()
    Cascade.Missions.Schema.ensure!()
    reset_database()
    SQL.exec("INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES (1,'alice','x','Alice','',0),(2,'bob','x','Bob','',0),(3,'carol','x','Carol','',0)")
    ExUnit.Callbacks.on_exit(fn ->
      reset_database()
      File.rm_rf!(root)
      if previous, do: System.put_env("CASCADE_VAULTS_BASE_DIR", previous), else: System.delete_env("CASCADE_VAULTS_BASE_DIR")
    end)
    :ok
  end

  def chat_request(method, path, token, body, options \\ []) do
    request = conn(method, path, Jason.encode!(body)) |> put_req_header("authorization", "Bearer " <> token) |> put_req_header("content-type", "application/json")
    request = if options == [], do: request, else: assign(request, :domain_options, options)
    CascadeWeb.ChatRouter.call(request, CascadeWeb.ChatRouter.init([]))
  end

  def capture_queries(operation) do
    parent = self(); ref = make_ref(); handler_id = "chat-query-count-#{System.unique_integer([:positive])}"
    :ok = :telemetry.attach(handler_id, [:cascade, :db, :repo, :query], fn _event, _measurements, metadata, _config -> send(parent, {ref, IO.iodata_to_binary(metadata.query)}) end, nil)
    try do
      result = operation.(); :telemetry.detach(handler_id); {result, collect_queries(ref, [])}
    after
      :telemetry.detach(handler_id)
    end
  end

  def collect_queries(ref, queries) do
    receive do
      {^ref, query} -> collect_queries(ref, [query | queries])
    after
      0 -> Enum.reverse(queries)
    end
  end

  def route_resolution_query?(query), do: String.contains?(query, "SELECT local.id,local.vault_id")
  def message_fetch_query?(query), do: String.contains?(query, "FROM chat_messages WHERE id=? AND channel_id=?")

  def chat_vault(user_id, name, title) do
    vault = Store.create_vault(user_id, %{name: name})
    channel = Store.create_note(vault.id, user_id, %{title: title, content: "cascade://chat-channel"})
    {vault, channel}
  end

  def reset_database do
    for table <- ~w(chat_note_grants chat_channel_settings vault_agent_exclusions chat_agent_members chat_channel_links chat_messages work_item_dependencies work_item_runs work_item_reviews work_items vault_agents note_versions note_links note_tags tags notes folders vault_members vaults registration_invites_used users), do: if(SQL.table_exists?(table), do: SQL.exec("DELETE FROM #{table}"))
    File.rm_rf!(Store.vaults_base_dir())
  end
end
