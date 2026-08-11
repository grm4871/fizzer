defmodule Mix.Tasks.Cascade.LoadFixturesTest do
  use ExUnit.Case, async: true

  alias Mix.Tasks.Cascade.LoadFixtures

  test "validates bounded, production-shaped fixture options" do
    assert LoadFixtures.validate_options!(
             users: 10_000,
             group_size: 25,
             output: "/tmp/fixtures.jsonl",
             prefix: "capacity",
             runner_percent: 80
           ) == %{
             users: 10_000,
             group_size: 25,
             group_count: 400,
             output: "/tmp/fixtures.jsonl",
             prefix: "capacity",
             runner_percent: 80
           }
  end

  test "rejects unsafe or misleading cardinality options" do
    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(users: 0, output: "/tmp/fixtures.jsonl")
    end

    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(users: 10, output: "/tmp/fixtures.jsonl", group_size: 1)
    end

    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(users: 10, output: "/tmp/fixtures.jsonl", prefix: "../prod")
    end

    assert_raise Mix.Error, fn ->
      LoadFixtures.validate_options!(
        users: 10,
        output: "/tmp/fixtures.jsonl",
        runner_percent: 101
      )
    end
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
