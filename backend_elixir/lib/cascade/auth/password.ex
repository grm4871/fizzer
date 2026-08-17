defmodule Cascade.Auth.Password do
  @moduledoc "Bcrypt-compatible password policy and verification."

  @bcrypt_max_bytes 72
  @login_max_bytes 4_096
  @dummy_hash "$2b$12$0xQSnejvHHJfgQrY0lUZHODbknE0RkbCdLGD3WCpFE4mctENcqNFW"

  def validate(password) when is_binary(password) do
    cond do
      String.length(password) < 8 ->
        {:error, "Password must be at least 8 characters"}

      byte_size(password) > @bcrypt_max_bytes ->
        {:error, "Password must be at most 72 UTF-8 bytes"}

      true ->
        :ok
    end
  end

  def hash(password) when is_binary(password) do
    with :ok <- validate(password) do
      {:ok, Bcrypt.hash_pwd_salt(password, log_rounds: 12)}
    end
  end

  def verify_login(password, stored_hash)
      when is_binary(password) and (is_binary(stored_hash) or is_nil(stored_hash)) do
    hash = stored_hash || @dummy_hash
    valid_size? = byte_size(password) <= @login_max_bytes
    matches? = Bcrypt.verify_pass(if(valid_size?, do: password, else: ""), hash)
    valid_size? and not is_nil(stored_hash) and matches?
  end
end
