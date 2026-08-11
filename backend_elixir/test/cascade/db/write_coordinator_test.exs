defmodule Cascade.DB.WriteCoordinatorTest do
  use ExUnit.Case, async: true

  alias Cascade.DB.WriteCoordinator

  setup do
    coordinator = start_supervised!({WriteCoordinator, name: nil})
    %{coordinator: coordinator}
  end

  test "executes lock bodies in their caller and permits nested locks", %{
    coordinator: coordinator
  } do
    caller = self()

    assert {:ok, ^caller} =
             WriteCoordinator.with_lock(coordinator, fn ->
               WriteCoordinator.with_lock(coordinator, fn -> {:ok, self()} end)
             end)

    assert %{completed: 1, locked: false, queue_depth: 0} =
             WriteCoordinator.stats(coordinator)
  end

  test "grants queued callers in FIFO order", %{coordinator: coordinator} do
    parent = self()
    release_owner = make_ref()

    owner =
      spawn_link(fn ->
        WriteCoordinator.with_lock(coordinator, fn ->
          send(parent, :owner_acquired)

          receive do
            ^release_owner -> :ok
          end
        end)
      end)

    assert_receive :owner_acquired

    waiters =
      for ordinal <- 1..4 do
        pid =
          spawn_link(fn ->
            receive do
              :start ->
                WriteCoordinator.with_lock(coordinator, fn ->
                  send(parent, {:acquired, ordinal})
                end)
            end
          end)

        send(pid, :start)
        wait_until(fn -> WriteCoordinator.stats(coordinator).queue_depth == ordinal end)
        pid
      end

    send(owner, release_owner)

    for ordinal <- 1..4 do
      assert_receive {:acquired, ^ordinal}, 1_000
    end

    Enum.each([owner | waiters], &assert_process_exited/1)
  end

  test "promotes the next caller when the lock owner dies", %{coordinator: coordinator} do
    parent = self()

    owner =
      spawn(fn ->
        WriteCoordinator.with_lock(coordinator, fn ->
          send(parent, :owner_acquired)
          Process.sleep(:infinity)
        end)
      end)

    assert_receive :owner_acquired

    waiter =
      spawn_link(fn ->
        WriteCoordinator.with_lock(coordinator, fn -> send(parent, :waiter_acquired) end)
      end)

    wait_until(fn -> WriteCoordinator.stats(coordinator).queue_depth == 1 end)
    Process.exit(owner, :kill)

    assert_receive :waiter_acquired, 1_000
    assert_process_exited(waiter)

    assert %{owner_deaths: 1, completed: 2, locked: false, queue_depth: 0} =
             WriteCoordinator.stats(coordinator)
  end

  test "removes a queued caller that dies", %{coordinator: coordinator} do
    parent = self()
    release_owner = make_ref()

    owner =
      spawn_link(fn ->
        WriteCoordinator.with_lock(coordinator, fn ->
          send(parent, :owner_acquired)

          receive do
            ^release_owner -> :ok
          end
        end)
      end)

    assert_receive :owner_acquired
    waiter = spawn(fn -> WriteCoordinator.with_lock(coordinator, fn -> :never end) end)
    wait_until(fn -> WriteCoordinator.stats(coordinator).queue_depth == 1 end)
    Process.exit(waiter, :kill)
    wait_until(fn -> WriteCoordinator.stats(coordinator).queue_depth == 0 end)
    send(owner, release_owner)
    assert_process_exited(owner)
  end

  test "read-only guards reject mutation helpers" do
    assert :ok = WriteCoordinator.assert_read_only!("SELECT 1")
    assert :ok = WriteCoordinator.assert_read_only!("PRAGMA table_info(users)")
    assert :ok = WriteCoordinator.assert_read_only!("WITH ids AS (SELECT 1) SELECT * FROM ids")

    assert_raise ArgumentError, ~r/write statement/, fn ->
      WriteCoordinator.assert_read_only!("INSERT INTO users(username) VALUES('nope')")
    end

    assert_raise ArgumentError, ~r/write statement/, fn ->
      WriteCoordinator.assert_read_only!("WITH ids AS (SELECT 1) DELETE FROM users")
    end

    assert_raise ArgumentError, ~r/write statement/, fn ->
      WriteCoordinator.assert_read_only!("PRAGMA user_version=123")
    end
  end

  defp wait_until(fun, attempts \\ 100)

  defp wait_until(_fun, 0), do: flunk("condition did not become true")

  defp wait_until(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(5)
      wait_until(fun, attempts - 1)
    end
  end

  defp assert_process_exited(pid) do
    ref = Process.monitor(pid)
    assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 1_000
  end
end
