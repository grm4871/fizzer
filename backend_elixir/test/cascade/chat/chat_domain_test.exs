defmodule Cascade.ChatSchemaTest do
  @moduledoc "Focused chat schema migration and invariant contracts."
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  import Cascade.ChatDomainTestSupport
  alias Cascade.Chat.{Agents, Channel, Messages, RoomContext, Schema}
  alias Cascade.Content.Store
  alias Cascade.Missions.Dispatches
  alias Cascade.Runs.RunnerLifecycle

  @node_column_signatures %{
    "chat_messages" => [
      ["id", "TEXT", 0, nil, 1],
      ["channel_id", "TEXT", 1, nil, 0],
      ["vault_id", "TEXT", 1, nil, 0],
      ["author", "TEXT", 1, nil, 0],
      ["body", "TEXT", 1, "''", 0],
      ["created_at", "TEXT", 1, "datetime('now')", 0],
      ["activity_at", "TEXT", 0, nil, 0],
      ["actor_user_id", "INTEGER", 0, nil, 0],
      ["status", "TEXT", 0, nil, 0],
      ["agent_id", "TEXT", 0, nil, 0],
      ["registration_id", "TEXT", 0, nil, 0],
      ["run_id", "INTEGER", 0, nil, 0],
      ["blocks_json", "TEXT", 0, nil, 0],
      ["harness_log", "TEXT", 0, nil, 0],
      ["images_json", "TEXT", 0, nil, 0],
      ["attachments_json", "TEXT", 0, nil, 0],
      ["reply_to_json", "TEXT", 0, nil, 0],
      ["forwarded_from_json", "TEXT", 0, nil, 0],
      ["change_request_json", "TEXT", 0, nil, 0],
      ["mission_json", "TEXT", 0, nil, 0],
      ["mission_task_id", "TEXT", 0, nil, 0],
      ["clarification_json", "TEXT", 0, nil, 0]
    ],
    "chat_agent_members" => [
      ["id", "TEXT", 0, nil, 1],
      ["channel_id", "TEXT", 1, nil, 0],
      ["vault_id", "TEXT", 1, nil, 0],
      ["agent_id", "TEXT", 1, nil, 0],
      ["display_name", "TEXT", 1, "''", 0],
      ["avatar_url", "TEXT", 1, "''", 0],
      ["mention", "TEXT", 1, "''", 0],
      ["model", "TEXT", 1, "''", 0],
      ["reasoning_effort", "TEXT", 1, "''", 0],
      ["priority_service_tier", "INTEGER", 1, "0", 0],
      ["cwd", "TEXT", 1, "''", 0],
      ["context_prompt", "TEXT", 1, "''", 0],
      ["taggable_by_agents", "INTEGER", 1, "0", 0],
      ["reply_to_every_message", "INTEGER", 1, "0", 0],
      ["orchestrator", "INTEGER", 1, "0", 0],
      ["pingable_by_others", "INTEGER", 1, "0", 0],
      ["yolo", "INTEGER", 1, "0", 0],
      ["conversation_id", "TEXT", 1, "''", 0],
      ["created_at", "TEXT", 1, "datetime('now')", 0],
      ["updated_at", "TEXT", 1, "datetime('now')", 0],
      ["vault_agent_id", "TEXT", 1, "''", 0]
    ],
    "chat_channel_links" => [
      ["local_channel_id", "TEXT", 0, nil, 1],
      ["local_vault_id", "TEXT", 1, nil, 0],
      ["source_channel_id", "TEXT", 1, nil, 0],
      ["source_vault_id", "TEXT", 1, nil, 0],
      ["created_by", "INTEGER", 1, nil, 0],
      ["created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0]
    ],
    "chat_note_grants" => [
      ["message_id", "TEXT", 1, nil, 1],
      ["channel_id", "TEXT", 1, nil, 0],
      ["note_id", "TEXT", 1, nil, 2],
      ["granted_by", "INTEGER", 1, nil, 0],
      ["created_at", "TEXT", 1, "datetime('now')", 0],
      ["title_snapshot", "TEXT", 0, nil, 0],
      ["content_snapshot", "TEXT", 0, nil, 0],
      ["preview_snapshot", "TEXT", 0, nil, 0]
    ]
  }

  @node_foreign_key_signatures %{
    "chat_messages" => [
      ["actor_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
      ["channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
    ],
    "chat_agent_members" => [
      ["channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
    ],
    "chat_channel_links" => [
      ["created_by", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
      ["local_channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["local_vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"],
      ["source_channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["source_vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
    ],
    "chat_note_grants" => [
      ["channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["granted_by", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
      ["message_id", "chat_messages", "id", "NO ACTION", "CASCADE", "NONE"],
      ["note_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"]
    ]
  }

  setup do
    Cascade.ChatDomainTestSupport.setup()
  end
  defp assert_node_columns(table) do
    actual =
      SQL.all("PRAGMA table_info(#{table})")
      |> Enum.map(fn [_cid | definition] -> definition end)

    assert actual == Map.fetch!(@node_column_signatures, table)

    foreign_keys =
      SQL.all("PRAGMA foreign_key_list(#{table})")
      |> Enum.map(fn [_id, _seq, target, source, destination, on_update, on_delete, match] ->
        [source, target, destination, on_update, on_delete, match]
      end)
      |> Enum.sort()

    assert foreign_keys == Enum.sort(Map.fetch!(@node_foreign_key_signatures, table))
  end

  test "fresh schema creates every table, index, FTS table, and trigger explicitly" do
    for trigger <- ~w(chat_messages_ai chat_messages_ad chat_messages_au),
        do: SQL.exec("DROP TRIGGER IF EXISTS #{trigger}")

    SQL.exec("DROP TABLE IF EXISTS chat_messages_fts")

    for table <-
          ~w(chat_note_grants chat_channel_settings chat_channel_links vault_agent_exclusions chat_agent_members vault_agents chat_messages),
        do: SQL.exec("DROP TABLE IF EXISTS #{table}")

    assert :ok = Schema.ensure!()

    for table <-
          ~w(chat_messages chat_agent_members vault_agents vault_agent_exclusions chat_channel_links chat_channel_settings chat_note_grants chat_messages_fts) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]) == [1]
    end

    for index <-
          ~w(chat_messages_channel_idx chat_messages_activity_idx chat_messages_run_idx chat_agent_members_channel_idx vault_agents_vault_idx vault_agents_owner_idx chat_channel_links_source_idx chat_note_grants_channel_idx) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", [index]) == [1]
    end

    for table <- Map.keys(@node_column_signatures), do: assert_node_columns(table)

    refute SQL.table_sql("chat_agent_members") =~ "UNIQUE(channel_id,vault_agent_id)"
    assert SQL.table_sql("chat_channel_links") =~ "UNIQUE(local_vault_id,source_channel_id)"
    assert SQL.table_sql("chat_messages") =~ "REFERENCES users(id)"
    assert SQL.table_sql("chat_note_grants") =~ "PRIMARY KEY(message_id,note_id)"

    for trigger <- ~w(chat_messages_ai chat_messages_ad chat_messages_au) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?", [trigger]) ==
               [1]
    end
  end

  test "Node upgrade canonicalizes legacy Elixir ordering without losing chat data" do
    {source, source_channel} = chat_vault(1, "Schema source", "Source")
    {local, local_channel} = chat_vault(2, "Schema local", "Local")
    shared_note = Store.create_note(source.id, 1, %{title: "Shared", content: "payload"})

    identity = Ecto.UUID.generate()

    SQL.exec(
      "INSERT INTO vault_agents(id,vault_id,agent_id,display_name,mention,owner_user_id) VALUES(?,?,'codex','Sol','sol',1)",
      [identity, source.id]
    )

    Cascade.DB.Repo.checkout(fn ->
      SQL.exec("PRAGMA foreign_keys=OFF")

      try do
        SQL.transaction(fn ->
          for trigger <- ~w(chat_messages_ai chat_messages_ad chat_messages_au),
              do: SQL.exec("DROP TRIGGER IF EXISTS #{trigger}")

          SQL.exec("DROP TABLE IF EXISTS chat_messages_fts")

          for table <- ~w(chat_note_grants chat_channel_links chat_agent_members chat_messages),
              do: SQL.exec("DROP TABLE #{table}")

          SQL.exec("""
          CREATE TABLE chat_messages (
            id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,author TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')),
            activity_at TEXT,actor_user_id INTEGER REFERENCES users(id),status TEXT,agent_id TEXT,
            registration_id TEXT,run_id INTEGER,blocks_json TEXT,harness_log TEXT,images_json TEXT,
            attachments_json TEXT,reply_to_json TEXT,forwarded_from_json TEXT,change_request_json TEXT,
            clarification_json TEXT,mission_json TEXT,mission_task_id TEXT)
          """)

          SQL.exec("""
          CREATE TABLE chat_agent_members (
            id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,vault_agent_id TEXT NOT NULL DEFAULT '',
            agent_id TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',
            mention TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT '',
            priority_service_tier INTEGER NOT NULL DEFAULT 0,cwd TEXT NOT NULL DEFAULT '',context_prompt TEXT NOT NULL DEFAULT '',
            taggable_by_agents INTEGER NOT NULL DEFAULT 0,reply_to_every_message INTEGER NOT NULL DEFAULT 0,
            orchestrator INTEGER NOT NULL DEFAULT 0,pingable_by_others INTEGER NOT NULL DEFAULT 0,yolo INTEGER NOT NULL DEFAULT 0,
            conversation_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')),
            updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(channel_id,vault_agent_id))
          """)

          SQL.exec("""
          CREATE TABLE chat_channel_links (
            local_channel_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
            local_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
            source_channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            source_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE(local_vault_id,source_channel_id))
          """)

          SQL.exec("""
          CREATE TABLE chat_note_grants (
            message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            granted_by INTEGER NOT NULL REFERENCES users(id),title_snapshot TEXT,content_snapshot TEXT,
            preview_snapshot TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),
            PRIMARY KEY(message_id,note_id))
          """)

          SQL.exec(
            "INSERT INTO chat_messages(rowid,id,channel_id,vault_id,author,body,created_at,clarification_json,mission_json,mission_task_id) VALUES(41,'schema-message',?,?,'alice','preserve me','2026-08-10T12:00:00.000Z','{\"question\":\"q\"}','{\"title\":\"m\"}','task-1')",
            [source_channel.id, source.id]
          )

          SQL.exec(
            "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention,created_at,updated_at) VALUES('schema-member',?,?,?,'codex','Sol','sol','2026-08-10T12:01:00.000Z','2026-08-10T12:02:00.000Z')",
            [source_channel.id, source.id, identity]
          )

          SQL.exec(
            "INSERT INTO chat_channel_links VALUES(?,?,?,?,1,'2026-08-10T12:03:00.000Z')",
            [local_channel.id, local.id, source_channel.id, source.id]
          )

          SQL.exec(
            "INSERT INTO chat_note_grants VALUES('schema-message',?,?,1,'Shared','payload','preview','2026-08-10T12:04:00.000Z')",
            [source_channel.id, shared_note.id]
          )
        end)
      after
        SQL.exec("PRAGMA foreign_keys=ON")
      end
    end)

    assert :ok = Schema.ensure!()
    for table <- Map.keys(@node_column_signatures), do: assert_node_columns(table)

    assert ["preserve me", ~s({"title":"m"}), "task-1", ~s({"question":"q"})] ==
             SQL.one(
               "SELECT body,mission_json,mission_task_id,clarification_json FROM chat_messages WHERE id='schema-message'"
             )

    assert [41] == SQL.one("SELECT rowid FROM chat_messages WHERE id='schema-message'")

    assert [41] ==
             SQL.one(
               "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'preserve' AND rowid=41"
             )

    assert ["schema-member", identity, "2026-08-10T12:01:00.000Z"] ==
             SQL.one(
               "SELECT id,vault_agent_id,created_at FROM chat_agent_members WHERE id='schema-member'"
             )

    assert ["Shared", "payload", "preview", "2026-08-10T12:04:00.000Z"] ==
             SQL.one(
               "SELECT title_snapshot,content_snapshot,preview_snapshot,created_at FROM chat_note_grants WHERE message_id='schema-message'"
             )

    assert [source_channel.id, "2026-08-10T12:03:00.000Z"] ==
             SQL.one(
               "SELECT source_channel_id,created_at FROM chat_channel_links WHERE local_channel_id=?",
               [local_channel.id]
             )

    assert [] = SQL.all("PRAGMA foreign_key_check")
  end

  test "legacy per-vault identities upgrade on one checked-out connection and merge by owner handle" do
    {one, first_channel} = chat_vault(1, "Legacy one", "First")
    {two, second_channel} = chat_vault(1, "Legacy two", "Second")

    Cascade.DB.Repo.checkout(fn ->
      SQL.exec("PRAGMA foreign_keys=OFF")

      try do
        SQL.exec("DROP TABLE vault_agent_exclusions")
        SQL.exec("DROP TABLE chat_agent_members")
        SQL.exec("DROP TABLE vault_agents")

        SQL.exec("""
        CREATE TABLE vault_agents (
          id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,agent_id TEXT NOT NULL,display_name TEXT NOT NULL,
          avatar_url TEXT NOT NULL DEFAULT '',mention TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL DEFAULT '',context_prompt TEXT NOT NULL DEFAULT '',owner_user_id INTEGER,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(vault_id,mention)
        )
        """)

        SQL.exec("""
        CREATE TABLE chat_agent_members (
          id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,vault_id TEXT NOT NULL,vault_agent_id TEXT NOT NULL DEFAULT '',
          agent_id TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',
          mention TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT '',
          priority_service_tier INTEGER NOT NULL DEFAULT 0,cwd TEXT NOT NULL DEFAULT '',context_prompt TEXT NOT NULL DEFAULT '',
          taggable_by_agents INTEGER NOT NULL DEFAULT 0,reply_to_every_message INTEGER NOT NULL DEFAULT 0,
          orchestrator INTEGER NOT NULL DEFAULT 0,pingable_by_others INTEGER NOT NULL DEFAULT 0,yolo INTEGER NOT NULL DEFAULT 0,
          conversation_id TEXT NOT NULL DEFAULT '',created_at TEXT,updated_at TEXT
        )
        """)

        SQL.exec(
          "INSERT INTO vault_agents VALUES('old-a',?,'codex','Sol','','sol','','','',1,'2020-01-01','2020-01-01')",
          [one.id]
        )

        SQL.exec(
          "INSERT INTO vault_agents VALUES('old-b',?,'codex','Sol','','sol','','','',1,'2021-01-01','2021-01-01')",
          [two.id]
        )

        SQL.exec(
          "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention) VALUES('member-a',?,?,'old-a','codex','Sol','sol')",
          [first_channel.id, one.id]
        )

        SQL.exec(
          "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention) VALUES('member-b',?,?,'old-b','codex','Sol','sol')",
          [second_channel.id, two.id]
        )
      after
        SQL.exec("PRAGMA foreign_keys=ON")
      end
    end)

    assert :ok = Schema.ensure!()
    assert [["old-a", 1, "sol"]] = SQL.all("SELECT id,owner_user_id,mention FROM vault_agents")
    assert SQL.all("SELECT DISTINCT vault_agent_id FROM chat_agent_members") == [["old-a"]]
    assert SQL.table_sql("vault_agents") =~ "UNIQUE(owner_user_id,mention)"
  end
end
