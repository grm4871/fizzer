defmodule Cascade.Publishing do
  @moduledoc "Native published-note storage, safe Markdown rendering, public pages, and oEmbed."

  alias Cascade.Content.{Query, Store}
  alias Cascade.Publishing.Scrubber

  @public_css """
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      line-height: 1.7;
      background: #0f0e0d;
      color: #e8e4df;
    }
    .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
    .meta { color: #9a9288; font-size: 0.9rem; margin-bottom: 28px; }
    h1 { font-size: 2rem; font-weight: 300; letter-spacing: -0.03em; margin: 0 0 8px; }
    .content h1, .content h2, .content h3 { letter-spacing: -0.02em; }
    .content h2 { margin-top: 2rem; }
    .content pre {
      background: #1a1816;
      border: 1px solid #2a2622;
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      font-size: 0.9rem;
    }
    .content code {
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 0.9em;
      background: #1a1816;
      padding: 0.15em 0.35em;
      border-radius: 4px;
    }
    .content pre code { background: none; padding: 0; }
    .content a { color: #d4a24a; }
    .content blockquote {
      border-left: 3px solid #3a342c;
      margin: 1rem 0;
      padding-left: 1rem;
      color: #b8b0a4;
    }
    .content table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    .content th, .content td { border: 1px solid #2a2622; padding: 8px 10px; text-align: left; }
    .embed body { background: transparent; }
    .embed .wrap { padding: 16px; }
    .embed .meta { display: none; }
  """

  def ensure_schema do
    Query.execute("""
    CREATE TABLE IF NOT EXISTS published_notes (
      slug TEXT PRIMARY KEY,
      note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_username TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    )
    """)

    Query.execute(
      "CREATE INDEX IF NOT EXISTS idx_published_notes_note_id ON published_notes(note_id)"
    )

    :ok
  end

  def sanitize_public_content(content) do
    content
    |> to_string()
    |> redact_private_for_public()
    |> String.replace(~r/\{\{ai:[^}]+\}\}/u, "")
    |> String.replace(~r/!\[\[([^\]]+)\]\]/u, "[\\1]")
    |> String.replace(~r/\[\[([^\]]+)\]\]/u, "\\1")
    |> expand_sized_images()
  end

  def render_markdown(content) do
    {markdown, data_urls} =
      content
      |> sanitize_public_content()
      |> String.replace(~r/<[^>\n]+>/u, "")
      |> protect_raster_data_urls()

    markdown
    |> MDEx.to_html!(extension: [table: true, strikethrough: true])
    |> HtmlSanitizeEx.Scrubber.scrub(Scrubber)
    |> String.replace(~r/\s+(?:href|src)=""/iu, "")
    |> force_link_rel()
    |> restore_raster_data_urls(data_urls)
    |> block_remote_images()
    |> String.trim_trailing()
    |> Kernel.<>("\n")
  end

  def get_info(note_id) do
    Query.map(
      """
      SELECT slug, title, author_username, published_at, updated_at
      FROM published_notes WHERE note_id = ? AND revoked_at IS NULL
      """,
      [note_id],
      [:slug, :title, :author_username, :published_at, :updated_at]
    )
  end

  def get_by_slug(slug) do
    Query.map(
      """
      SELECT slug, note_id, title, content, author_username, published_at, updated_at, revoked_at
      FROM published_notes WHERE slug = ? AND revoked_at IS NULL
      """,
      [slug],
      [
        :slug,
        :note_id,
        :title,
        :content,
        :author_username,
        :published_at,
        :updated_at,
        :revoked_at
      ]
    )
  end

  def publish(note_id, user_id, username, _snapshot \\ nil) do
    note = Store.get_note(note_id)

    cond do
      is_nil(note) ->
        raise ArgumentError, "Note not found"

      note.is_archived != 0 ->
        raise ArgumentError, "Cannot publish archived notes"

      is_nil(Store.get_writable_vault(note.vault_id, user_id)) ->
        raise ArgumentError, "Note not found"

      true ->
        :ok
    end

    existing =
      Query.map(
        "SELECT slug, published_at FROM published_notes WHERE note_id = ?",
        [note_id],
        [:slug, :published_at]
      )

    slug = if existing, do: existing.slug, else: random_slug()
    now = DateTime.utc_now() |> DateTime.to_iso8601()
    title = if String.trim(note.title) == "", do: note.title, else: String.trim(note.title)
    content = sanitize_public_content(note.content)

    if existing do
      Query.execute(
        "UPDATE published_notes SET title = ?, content = ?, author_username = ?, updated_at = ?, revoked_at = NULL WHERE note_id = ?",
        [title, content, username, now, note_id]
      )
    else
      Query.execute(
        "INSERT INTO published_notes (slug, note_id, title, content, author_username, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [slug, note_id, title, content, username, now, now]
      )
    end

    %{
      slug: slug,
      published_at: if(existing, do: existing.published_at, else: now),
      updated_at: now
    }
  end

  def unpublish(note_id, user_id) do
    note = Store.get_note(note_id)

    if note && Store.get_writable_vault(note.vault_id, user_id) do
      result =
        Query.execute(
          "UPDATE published_notes SET revoked_at = ? WHERE note_id = ? AND revoked_at IS NULL",
          [DateTime.utc_now() |> DateTime.to_iso8601(), note_id]
        )

      result.num_rows > 0
    else
      false
    end
  end

  def public_base_url(conn, env \\ System.get_env()) do
    configured = env |> Map.get("CASCADE_PUBLIC_URL", "") |> String.trim()

    if configured != "" do
      http_origin!(configured, "CASCADE_PUBLIC_URL must be an absolute HTTP(S) origin")
    else
      forwarded = conn |> Plug.Conn.get_req_header("x-forwarded-proto") |> List.first()
      proto = forwarded |> to_string() |> String.split(",") |> List.first() |> String.trim()
      proto = if proto in ["http", "https"], do: proto, else: to_string(conn.scheme)
      host = conn |> Plug.Conn.get_req_header("host") |> List.first() || "localhost"
      requested = http_origin("#{proto}://#{host}") || "https://localhost"

      allowed =
        env
        |> Map.get("CASCADE_ALLOWED_ORIGINS", "")
        |> String.split(",")
        |> Enum.map(&http_origin(String.trim(&1)))
        |> Enum.reject(&is_nil/1)

      if requested in allowed, do: requested, else: List.first(allowed) || requested
    end
  end

  def public_json(published, base) do
    %{
      slug: published.slug,
      title: published.title,
      content: sanitize_public_content(published.content),
      author: published.author_username,
      published_at: published.published_at,
      updated_at: published.updated_at,
      url: "#{base}/p/#{published.slug}"
    }
  end

  def oembed(published, base) do
    page_url = "#{base}/p/#{published.slug}"

    %{
      version: "1.0",
      type: "rich",
      provider_name: "Cascade",
      provider_url: base,
      title: published.title,
      author_name: published.author_username,
      html:
        ~s(<iframe src="#{page_url}?embed=1" width="600" height="420" frameborder="0" sandbox="allow-same-origin"></iframe>),
      width: 600,
      height: 420,
      description: preview_text(published.content)
    }
  end

  def parse_public_url(url, base) do
    with %URI{scheme: scheme, host: host, port: port, path: path} <- URI.parse(to_string(url)),
         %URI{scheme: ^scheme, host: ^host, port: ^port} <- URI.parse(base),
         [slug] <- Regex.run(~r{^/p/([^/]+)$}u, path || "", capture: :all_but_first) do
      slug
    else
      _ -> nil
    end
  end

  def render_page(published, base, embed \\ false) do
    page_url = "#{base}/p/#{published.slug}"
    title = html_escape(published.title)
    description = published.content |> preview_text() |> html_escape()
    body_html = render_markdown(published.content)
    oembed_url = "#{base}/oembed?url=#{URI.encode_www_form(page_url)}"

    """
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>#{title}</title>
      <meta name="description" content="#{description}" />
      <meta property="og:type" content="article" />
      <meta property="og:title" content="#{title}" />
      <meta property="og:description" content="#{description}" />
      <meta property="og:url" content="#{page_url}" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content="#{title}" />
      <meta name="twitter:description" content="#{description}" />
      <meta name="robots" content="noindex" />
      <link rel="alternate" type="application/json+oembed" href="#{html_escape(oembed_url)}" title="#{title}" />
      <style>
    #{@public_css}</style>
    </head>
    <body class="#{if embed, do: "embed", else: ""}">
      <article class="wrap">
        <header>
          <h1>#{title}</h1>
          <p class="meta">by #{html_escape(published.author_username)} · #{html_escape(published.updated_at)}</p>
        </header>
        <div class="content">#{body_html}</div>
      </article>
    </body>
    </html>
    """
    |> String.trim_trailing()
  end

  defp redact_private_for_public(content) do
    Regex.replace(
      ~r/^[\t ]*:::private[\t ]*\r?\n[\s\S]*?^[\t ]*:::[\t ]*$/imu,
      content,
      "> Private block omitted from the public note."
    )
  end

  defp expand_sized_images(markdown) do
    Regex.replace(
      ~r/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/u,
      markdown,
      fn full, raw_alt, url ->
        case Regex.run(~r/^(.*?)\|(\d{1,5})(?:x(\d{1,5}))?\s*$/u, raw_alt) do
          [_, alt, width | _] when width != "0" ->
            ~s(<img src="#{html_escape(url)}" alt="#{html_escape(String.trim(alt))}" width="#{width}" style="max-width:100%;height:auto" />)

          _ ->
            full
        end
      end
    )
  end

  defp protect_raster_data_urls(markdown) do
    pattern = ~r/data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+\/_=-]+/iu

    Regex.scan(pattern, markdown)
    |> List.flatten()
    |> Enum.uniq()
    |> Enum.with_index()
    |> Enum.reduce({markdown, %{}}, fn {url, index}, {text, urls} ->
      marker = "https://cascade.invalid/__data_image_#{index}__"
      {String.replace(text, url, marker), Map.put(urls, marker, url)}
    end)
  end

  defp restore_raster_data_urls(html, urls) do
    Enum.reduce(urls, html, fn {marker, url}, output -> String.replace(output, marker, url) end)
  end

  defp block_remote_images(html) do
    Regex.replace(
      ~r/<img\b([^>]*?)\bsrc="(https?:\/\/[^"]+)"([^>]*)>/iu,
      html,
      fn _full, before, url, after_attrs ->
        attrs = before <> after_attrs

        label =
          case Regex.run(~r/\balt="([^"]*)"/iu, attrs, capture: :all_but_first) do
            [alt] when alt != "" -> "External image: " <> alt
            _ -> "External image"
          end

        ~s(<a href="#{url}" rel="noopener noreferrer">#{label}</a>)
      end
    )
  end

  defp force_link_rel(html) do
    Regex.replace(~r/<a\b([^>]*)>/iu, html, fn _full, attrs ->
      attrs = Regex.replace(~r/\s+rel=(?:"[^"]*"|'[^']*')/iu, attrs, "")
      "<a#{attrs} rel=\"noopener noreferrer\">"
    end)
  end

  defp preview_text(content, max_len \\ 200) do
    plain =
      content
      |> sanitize_public_content()
      |> String.replace(~r/[#*_`~\[\]()!]/u, "")
      |> String.replace(~r/\s+/u, " ")
      |> String.trim()

    if String.length(plain) > max_len,
      do: String.slice(plain, 0, max_len) <> "…",
      else: plain
  end

  defp http_origin!(raw, message), do: http_origin(raw) || raise(ArgumentError, message)

  defp http_origin(raw) do
    case URI.parse(raw) do
      %URI{scheme: scheme, host: host, userinfo: nil} = uri
      when scheme in ["http", "https"] and is_binary(host) and host != "" ->
        default_port =
          (scheme == "http" && uri.port == 80) || (scheme == "https" && uri.port == 443)

        "#{scheme}://#{host}#{if uri.port && !default_port, do: ":#{uri.port}", else: ""}"

      _ ->
        nil
    end
  end

  defp html_escape(value) do
    value
    |> to_string()
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
  end

  defp random_slug, do: :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)
end
