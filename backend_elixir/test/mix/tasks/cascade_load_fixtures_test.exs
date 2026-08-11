defmodule Mix.Tasks.Cascade.LoadFixturesTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Mix.Tasks.Cascade.LoadFixtures

  test "validates bounded, production-shaped fixture options" do
    assert LoadFixtures.validate_options!(
             users: 10_000,
             group_size: 25,
             output: "/tmp/fixtures.jsonl",
             prefix: "capacity",
             runner_percent: 80,
             persisted_vaults_base_dir: "/data/.cascade/vaults"
           ) == %{
             users: 10_000,
             group_size: 25,
             group_count: 400,
             output: "/tmp/fixtures.jsonl",
             prefix: "capacity",
             runner_percent: 80,
             persisted_vaults_base_dir: "/data/.cascade/vaults"
           }
  end

  test "rejects unsafe or misleading cardinality options" do
    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(
        users: 0,
        output: "/tmp/fixtures.jsonl",
        persisted_vaults_base_dir: "/data/.cascade/vaults"
      )
    end

    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(
        users: 10,
        output: "/tmp/fixtures.jsonl",
        group_size: 1,
        persisted_vaults_base_dir: "/data/.cascade/vaults"
      )
    end

    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(
        users: 10,
        output: "/tmp/fixtures.jsonl",
        prefix: "../prod",
        persisted_vaults_base_dir: "/data/.cascade/vaults"
      )
    end

    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(
        users: 10,
        output: "/tmp/fixtures.jsonl",
        runner_percent: 101,
        persisted_vaults_base_dir: "/data/.cascade/vaults"
      )
    end

    for value <- [nil, "relative/vaults", "/", "/tmp/vaults", "/data/.cascade/vaults/"] do
      assert_raise Mix.Error, fn ->
        LoadFixtures.validate_options!(
          users: 10,
          output: "/tmp/fixtures.jsonl",
          persisted_vaults_base_dir: value
        )
      end
    end
  end

  test "maps a physical fixture vault to the certified runtime root without escape" do
    physical = "/tmp/cascade-capacity/.cascade/vaults"

    assert LoadFixtures.persisted_vault_root!(
             physical,
             Path.join([physical, "8", "vault-id", "Capacity 0"]),
             "/data/.cascade/vaults"
           ) == "/data/.cascade/vaults/8/vault-id/Capacity 0"

    for root <- [physical, Path.dirname(physical), "/tmp/another-vault"] do
      assert_raise Mix.Error, ~r/must be contained/, fn ->
        LoadFixtures.persisted_vault_root!(
          physical,
          root,
          "/data/.cascade/vaults"
        )
      end
    end
  end

  test "rewrites exactly one new vault row while preserving its physical clone and approved rows" do
    root = tmp_dir!("portable")
    physical_base = Path.join(root, "template/.cascade/vaults")
    physical_root = Path.join([physical_base, "8", "fixture-vault", "Capacity 0"])
    clone_base = Path.join(root, "clone/.cascade/vaults")
    File.mkdir_p!(physical_root)
    File.write!(Path.join(physical_root, "General.md"), "cascade://chat-channel\n")

    suffix = System.unique_integer([:positive])
    username = "portable_fixture_#{suffix}"
    fixture_vault_id = "portable-fixture-vault-#{suffix}"
    approved_vault_id = "approved-vault-#{suffix}"
    approved_root = "/approved/production/vault-#{suffix}"

    [[user_id]] =
      SQL.exec(
        "INSERT INTO users(username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,'',0) RETURNING id",
        [username, "!no-login!", "Portable Fixture"]
      ).rows

    SQL.exec(
      "INSERT INTO vaults(id,name,root_path,created_by) VALUES(?,?,?,?)",
      [fixture_vault_id, "Capacity 0", physical_root, user_id]
    )

    SQL.exec(
      "INSERT INTO vaults(id,name,root_path,created_by) VALUES(?,?,?,?)",
      [approved_vault_id, "Approved", approved_root, user_id]
    )

    on_exit(fn ->
      SQL.exec("DELETE FROM vaults WHERE id IN (?,?)", [fixture_vault_id, approved_vault_id])
      SQL.exec("DELETE FROM users WHERE id=?", [user_id])
    end)

    persisted =
      LoadFixtures.persist_fixture_vault_root!(
        %{id: fixture_vault_id, root_path: physical_root},
        physical_base,
        "/data/.cascade/vaults"
      )

    assert persisted == "/data/.cascade/vaults/8/fixture-vault/Capacity 0"
    assert [^persisted] = SQL.one("SELECT root_path FROM vaults WHERE id=?", [fixture_vault_id])

    assert [^approved_root] =
             SQL.one("SELECT root_path FROM vaults WHERE id=?", [approved_vault_id])

    assert File.read!(Path.join(physical_root, "General.md")) == "cascade://chat-channel\n"

    File.mkdir_p!(Path.dirname(clone_base))
    File.cp_r!(physical_base, clone_base)
    relative = Path.relative_to(persisted, "/data/.cascade/vaults")

    assert File.read!(Path.join([clone_base, relative, "General.md"])) ==
             "cascade://chat-channel\n"
  end

  test "accepts a fresh isolated tree and requires a disposable marker for copied data" do
    root = tmp_dir!("fresh")
    data_dir = Path.join(root, "data")
    database = Path.join(data_dir, "docs.db")
    vaults_dir = Path.join(data_dir, "vaults")
    File.mkdir_p!(vaults_dir)

    assert :ok = LoadFixtures.validate_isolated_paths!(database, data_dir, vaults_dir, [])

    File.write!(database, "existing sqlite data")

    assert_raise Mix.Error, ~r/non-empty fixture databases require/, fn ->
      LoadFixtures.validate_isolated_paths!(database, data_dir, vaults_dir, [])
    end

    File.write!(Path.join(data_dir, ".cascade-load-fixtures-disposable"), "wrong")

    assert_raise Mix.Error, ~r/non-empty fixture databases require/, fn ->
      LoadFixtures.validate_isolated_paths!(database, data_dir, vaults_dir, [])
    end

    File.write!(
      Path.join(data_dir, ".cascade-load-fixtures-disposable"),
      "cascade-load-fixtures-disposable\n"
    )

    assert :ok = LoadFixtures.validate_isolated_paths!(database, data_dir, vaults_dir, [])
  end

  test "resolves symlinks before enforcing the production boundary" do
    root = tmp_dir!("symlink")
    protected = Path.join(root, "protected")
    safe = Path.join(root, "safe")
    File.mkdir_p!(Path.join(protected, "vaults"))
    File.mkdir_p!(safe)
    File.write!(Path.join(protected, "docs.db"), "production")
    File.ln_s!(protected, Path.join(safe, "alias"))

    assert_raise Mix.Error, ~r/forbidden in the production data path/, fn ->
      LoadFixtures.validate_isolated_paths!(
        Path.join(safe, "alias/docs.db"),
        Path.join(safe, "alias"),
        Path.join(safe, "alias/vaults"),
        [protected]
      )
    end
  end

  test "rejects a hard-linked production database outside its textual path" do
    root = tmp_dir!("inode")
    protected = Path.join(root, "protected")
    data_dir = Path.join(root, "safe")
    File.mkdir_p!(Path.join(protected, "vaults"))
    File.mkdir_p!(Path.join(data_dir, "vaults"))
    protected_database = Path.join(protected, "docs.db")
    database = Path.join(data_dir, "docs.db")
    File.write!(protected_database, "production")
    File.ln!(protected_database, database)

    assert_raise Mix.Error, ~r/forbidden in the production data path/, fn ->
      LoadFixtures.validate_isolated_paths!(
        database,
        data_dir,
        Path.join(data_dir, "vaults"),
        [protected]
      )
    end
  end

  defp tmp_dir!(suffix) do
    path =
      Path.join(
        System.tmp_dir!(),
        "cascade-load-fixtures-#{suffix}-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(path)
    on_exit(fn -> File.rm_rf!(path) end)
    path
  end
end
