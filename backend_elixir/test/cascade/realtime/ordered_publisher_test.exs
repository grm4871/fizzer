defmodule Cascade.Realtime.OrderedPublisherTest do
  use ExUnit.Case, async: false

  alias Cascade.Realtime.OrderedPublisher

  test "concurrent mutations execute in FIFO order and all events have one sender" do
    publisher = start_supervised!({OrderedPublisher, name: nil})
    parent = self()

    first =
      Task.async(fn ->
        OrderedPublisher.mutate(
          fn ->
            send(parent, {:entered, :first, self()})

            receive do
              :release -> :ok
            end

            OrderedPublisher.chat(
              fn intent ->
                send(parent, {:event, self(), intent})
                :ok
              end,
              %{id: 1}
            )
          end,
          publisher
        )
      end)

    assert_receive {:entered, :first, ^publisher}

    second =
      Task.async(fn ->
        OrderedPublisher.mutate(
          fn ->
            send(parent, {:entered, :second, self()})

            OrderedPublisher.chat(
              fn intent ->
                send(parent, {:event, self(), intent})
                :ok
              end,
              %{id: 2}
            )
          end,
          publisher
        )
      end)

    refute_receive {:entered, :second, _pid}, 100
    send(publisher, :release)

    assert_receive {:event, ^publisher, %{id: 1}}
    assert_receive {:entered, :second, ^publisher}
    assert_receive {:event, ^publisher, %{id: 2}}
    assert :ok = Task.await(first)
    assert :ok = Task.await(second)
  end

  test "nested mutations are reentrant" do
    publisher = start_supervised!({OrderedPublisher, name: nil})

    assert {:outer, {:inner, ^publisher}} =
             OrderedPublisher.mutate(
               fn ->
                 {:outer, OrderedPublisher.mutate(fn -> {:inner, self()} end, publisher)}
               end,
               publisher
             )
  end

  test "a failed mutation is reraised to its caller without killing the publisher" do
    publisher = start_supervised!({OrderedPublisher, name: nil})

    assert_raise RuntimeError, "mutation failed", fn ->
      OrderedPublisher.mutate(fn -> raise "mutation failed" end, publisher)
    end

    assert Process.alive?(publisher)
    assert :recovered = OrderedPublisher.mutate(fn -> :recovered end, publisher)
  end
end
