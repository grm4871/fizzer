defmodule Mix.Tasks.Cascade.LoadFixtures do
  @shortdoc "Provision distinct authenticated users for the isolated capacity harness"
  @moduledoc """
  Provisions a production-shaped, non-production SQLite fixture and writes one
  JSON object per authenticated user for `loadtest_elixir/load.mjs`.

  This task refuses to run unless `CASCADE_ALLOW_LOAD_FIXTURES=1` and refuses
  the production data path, including symlink and inode aliases. Use a fresh
  database and data directory:

      CASCADE_ALLOW_LOAD_FIXTURES=1 \
      DOCS_DB_PATH=/tmp/cascade-capacity/docs.db \
      CASCADE_DATA_DIR=/tmp/cascade-capacity/data \
      mix cascade.load_fixtures --users 10000 \
        --output /tmp/cascade-capacity/fixtures.jsonl

  A non-empty database copy also requires an explicit disposable marker at
  `CASCADE_DATA_DIR/.cascade-load-fixtures-disposable` whose entire content is
  `cascade-load-fixtures-disposable`. This prevents an unused fixture prefix
  from being mistaken for authority to write into an existing database.
  """

  use Mix.Task

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Content.Store

  @requirements ["app.config"]
  @disposable_marker ".cascade-load-fixtures-disposable"
  @disposable_marker_content "cascade-load-fixtures-disposable"
  @production_paths ["/var/lib/cascade", "/data"]
  @switches [
    users: :integer,
    group_size: :integer,
    output: :string,
    prefix: :string,
    runner_percent: :integer
  ]

  @impl true
  def run(argv) do
    {options, rest, invalid} = OptionParser.parse(argv, strict: @switches)

    if rest != [] or invalid != [],
      do: Mix.raise("unexpected arguments: #{inspect(rest ++ invalid)}")

    config = validate_options!(options)
    assert_isolated!()
    Mix.Task.run("app.start")
    ensure_unused_prefix!(config.prefix)
    Logger.configure(level: :warning)

    output = Path.expand(config.output)
    File.mkdir_p!(Path.dirname(output))

    count =
      File.open!(output, [:write, :utf8], fn io ->
        0..(config.group_count - 1)
        |> Enum.reduce(0, fn group_index, created ->
          group_users = min(config.group_size, config.users - created)
          provision_group!(io, config, group_index, created, group_users)
          created + group_users
        end)
      end)

    File.chmod!(output, 0o600)
    SQL.exec("PRAGMA optimize")

    Mix.shell().info(
      "Provisioned #{count} distinct users across #{config.group_count} vaults: #{output}"
    )
  end

  @doc false
  def validate_options!(options) do
    users = Keyword.get(options, :users, 10_000)
    group_size = Keyword.get(options, :group_size, 25)
    output = Keyword.get(options, :output)
    prefix = Keyword.get(options, :prefix, "capacity") |> String.trim()
    runner_percent = Keyword.get(options, :runner_percent, 100)

    unless is_integer(users) and users >= 1 and users <= 100_000,
      do: Mix.raise("--users must be an integer between 1 and 100000")

    unless is_integer(group_size) and group_size >= 2 and group_size <= 100,
      do: Mix.raise("--group-size must be an integer between 2 and 100")

    unless is_binary(output) and String.trim(output) != "",
      do: Mix.raise("--output is required")

    unless Regex.match?(~r/^[a-z][a-z0-9_-]{2,30}$/, prefix),
      do: Mix.raise("--prefix must match [a-z][a-z0-9_-]{2,30}")

    unless is_integer(runner_percent) and runner_percent in 0..100,
      do: Mix.raise("--runner-percent must be between 0 and 100")

    %{
      users: users,
      group_size: group_size,
      group_count: div(users + group_size - 1, group_size),
      output: output,
      prefix: prefix,
      runner_percent: runner_percent
    }
  end

  defp assert_isolated! do
    unless System.get_env("CASCADE_ALLOW_LOAD_FIXTURES") == "1",
      do: Mix.raise("set CASCADE_ALLOW_LOAD_FIXTURES=1 for an isolated fixture database")

    database =
      :cascade_elixir
      |> Application.fetch_env!(Cascade.DB.Repo)
      |> Keyword.fetch!(:database)
      |> Path.expand()

    data_dir =
      System.get_env("CASCADE_DATA_DIR")
      |> case do
        nil -> Path.dirname(database)
        value -> Path.expand(value)
      end

    vaults_dir =
      System.get_env("CASCADE_VAULTS_BASE_DIR")
      |> case do
        nil -> Mix.raise("CASCADE_VAULTS_BASE_DIR is required for isolated capacity fixtures")
        value -> Path.expand(value)
      end

    validate_isolated_paths!(database, data_dir, vaults_dir)
  end

  @doc false
  def validate_isolated_paths!(
        database,
        data_dir,
        vaults_dir,
        production_paths \\ @production_paths
      ) do
    resolved = %{
      database: canonical_path(database),
      data_dir: canonical_path(data_dir),
      vaults_dir: canonical_path(vaults_dir)
    }

    protected =
      production_paths
      |> Enum.flat_map(fn root -> [root, Path.join(root, "docs.db")] end)
      |> Enum.map(&canonical_path/1)

    candidates = Map.values(resolved)

    if Enum.any?(candidates, fn candidate ->
         Enum.any?(protected, fn target -> inside?(candidate, target) end)
       end) or aliases_protected_inode?(candidates, protected) do
      Mix.raise("capacity fixtures are forbidden in the production data path")
    end

    unless inside?(resolved.database, resolved.data_dir) and
             inside?(resolved.vaults_dir, resolved.data_dir),
           do: Mix.raise("capacity database and vault roots must be inside CASCADE_DATA_DIR")

    require_disposable_marker!(resolved.database, resolved.data_dir)
    :ok
  end

  defp inside?(path, root), do: path == root or String.starts_with?(path, root <> "/")

  defp canonical_path(path) do
    path
    |> Path.expand()
    |> Path.split()
    |> resolve_components(40)
  end

  defp resolve_components([root | components], remaining_links) do
    resolve_components(root, components, remaining_links)
  end

  defp resolve_components(path, [], _remaining_links), do: Path.expand(path)

  defp resolve_components(path, [component | rest], remaining_links) do
    candidate = Path.join(path, component)

    case File.lstat(candidate) do
      {:ok, %File.Stat{type: :symlink}} ->
        if remaining_links == 0, do: Mix.raise("too many symbolic links in capacity fixture path")
        target = File.read_link!(candidate)
        target = if Path.type(target) == :absolute, do: target, else: Path.expand(target, path)
        resolve_components(Path.split(Path.join([target | rest])), remaining_links - 1)

      {:ok, _stat} ->
        resolve_components(candidate, rest, remaining_links)

      {:error, :enoent} ->
        Path.expand(Path.join([candidate | rest]))

      {:error, reason} ->
        Mix.raise(
          "cannot inspect capacity fixture path #{candidate}: #{:file.format_error(reason)}"
        )
    end
  end

  defp aliases_protected_inode?(candidates, protected) do
    candidate_stats = Enum.flat_map(candidates, &existing_stat/1)
    protected_stats = Enum.flat_map(protected, &existing_stat/1)

    Enum.any?(candidate_stats, fn candidate ->
      Enum.any?(protected_stats, fn target ->
        candidate.major_device == target.major_device and
          candidate.minor_device == target.minor_device and
          candidate.inode == target.inode
      end)
    end)
  end

  defp existing_stat(path) do
    case File.stat(path) do
      {:ok, stat} ->
        [stat]

      {:error, :enoent} ->
        []

      {:error, reason} ->
        Mix.raise("cannot stat capacity fixture path #{path}: #{:file.format_error(reason)}")
    end
  end

  defp require_disposable_marker!(database, data_dir) do
    case File.stat(database) do
      {:ok, %File.Stat{size: size}} when size > 0 ->
        marker = Path.join(data_dir, @disposable_marker)

        with {:ok, %File.Stat{type: :regular}} <- File.lstat(marker),
             {:ok, contents} <- File.read(marker),
             true <- String.trim(contents) == @disposable_marker_content do
          :ok
        else
          _ ->
            Mix.raise(
              "non-empty fixture databases require #{marker} containing #{@disposable_marker_content}"
            )
        end

      {:ok, _stat} ->
        :ok

      {:error, :enoent} ->
        :ok

      {:error, reason} ->
        Mix.raise(
          "cannot stat capacity fixture database #{database}: #{:file.format_error(reason)}"
        )
    end
  end

  defp ensure_unused_prefix!(prefix) do
    case SQL.one("SELECT COUNT(*) FROM users WHERE username GLOB ?", [prefix <> "_*"]) do
      [0] ->
        :ok

      [count] ->
        Mix.raise("fixture prefix #{prefix} already owns #{count} users; use a fresh database")
    end
  end

  defp provision_group!(io, config, group_index, created, group_users) do
    users =
      0..(group_users - 1)
      |> Enum.map(fn offset ->
        ordinal = created + offset
        username = "#{config.prefix}_#{String.pad_leading(Integer.to_string(ordinal), 6, "0")}"

        [[user_id]] =
          SQL.exec(
            "INSERT INTO users(username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,'',0) RETURNING id",
            [username, "!capacity-fixture-no-password-login!", "Capacity #{ordinal}"]
          ).rows

        %{id: user_id, username: username, auth_version: 0, ordinal: ordinal}
      end)

    [owner | guests] = users
    vault = Store.create_vault(owner.id, %{name: "Capacity #{group_index}"})

    [channel_id] =
      SQL.one(
        "SELECT id FROM notes WHERE vault_id=? AND content='cascade://chat-channel' ORDER BY rowid LIMIT 1",
        [vault.id]
      ) || Mix.raise("capacity vault #{vault.id} did not create a General channel")

    Enum.each(guests, fn user ->
      SQL.exec(
        "INSERT INTO vault_members(vault_id,user_id,role,invited_by) VALUES(?,?,'editor',?)",
        [vault.id, user.id, owner.id]
      )
    end)

    Enum.each(users, fn user ->
      fixture = %{
        token: Token.sign_user(user),
        vaultId: vault.id,
        channelId: channel_id,
        ownedChatChannels: if(user.id == owner.id, do: 1, else: 0),
        runner: rem(user.ordinal, 100) < config.runner_percent,
        runIds: []
      }

      IO.write(io, Jason.encode!(fixture))
      IO.write(io, "\n")
    end)
  end
end
