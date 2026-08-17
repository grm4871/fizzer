defmodule Cascade.Publishing.Scrubber do
  @moduledoc false

  use HtmlSanitizeEx, extend: :strip_tags

  allow_tag_with_these_attributes("p", [])
  allow_tag_with_these_attributes("br", [])
  allow_tag_with_these_attributes("hr", [])
  allow_tag_with_these_attributes("h1", [])
  allow_tag_with_these_attributes("h2", [])
  allow_tag_with_these_attributes("h3", [])
  allow_tag_with_these_attributes("h4", [])
  allow_tag_with_these_attributes("h5", [])
  allow_tag_with_these_attributes("h6", [])
  allow_tag_with_these_attributes("blockquote", [])
  allow_tag_with_these_attributes("pre", [])
  allow_tag_with_these_attributes("code", [])
  allow_tag_with_these_attributes("strong", [])
  allow_tag_with_these_attributes("em", [])
  allow_tag_with_these_attributes("del", [])
  allow_tag_with_these_attributes("ul", [])
  allow_tag_with_these_attributes("ol", [])
  allow_tag_with_these_attributes("li", [])
  allow_tag_with_uri_attributes("a", ["href"], ["http", "https", "mailto"])
  allow_tag_with_these_attributes("a", ["title", "rel"])
  allow_tag_with_uri_attributes("img", ["src"], ["http", "https"])
  allow_tag_with_these_attributes("img", ["alt", "title", "width", "height"])
  allow_tag_with_these_attributes("table", [])
  allow_tag_with_these_attributes("thead", [])
  allow_tag_with_these_attributes("tbody", [])
  allow_tag_with_these_attributes("tr", [])
  allow_tag_with_these_attributes("th", ["align"])
  allow_tag_with_these_attributes("td", ["align"])
end
