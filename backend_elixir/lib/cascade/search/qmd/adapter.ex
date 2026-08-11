defmodule Cascade.Search.QMD.Adapter do
  @moduledoc false

  @callback search(keyword()) ::
              {:ok, %{lexical: [String.t()], vector: [String.t()]}} | {:error, term()}
end
