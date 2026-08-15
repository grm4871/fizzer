# Redistribution guide

This is a release checklist, not legal advice. The MIT license applies to
Fizzer-authored material; it does not replace third-party terms.

## Must resolve before making the repository public

- Confirm that every contributor whose work remains in the Git history agrees
  to the MIT license or that the project already owns the necessary copyright.
- Establish provenance and redistribution permission for new binary or branded
  assets before adding them to `client/public/`. The generated favicon and
  Android APK are project-owned release artifacts.
- Review the use of third-party product names and logos as nominative references.
  The MIT license grants no trademark rights; avoid implying endorsement.

## Must resolve before distributing desktop binaries

- Preserve the license text and source-code availability required by
  `@resvg/resvg-js` (MPL-2.0). Other audited runtime npm dependencies use
  permissive licenses or offer a permissive license choice. The dependency
  inventory must be regenerated for each release because lockfiles change.
- Desktop packages include the project MIT license, third-party notices, the
  MPL-2.0 text for resvg-js, and Electron/Chromium's generated notices.

## Checked

- Claude support uses a separately installed and authenticated Claude Code CLI;
  the desktop package does not redistribute Anthropic's SDK or executable.
- No tracked environment file, private key, credential, database, or production
  secret was found. The tracked `.env.example` files contain placeholders.
- The checked-in Gradle wrapper carries its Apache-2.0 notice.
- Installed Elixir dependencies declare MIT, Apache-2.0, BSD, or ISC-family
  licenses. The npm lockfiles are predominantly MIT, ISC, Apache-2.0, BSD,
  BlueOak, Unlicense, and CC-BY licensed, with the exceptions called out above.
- The Fizzer gem desktop/mobile icons appear to be project-authored, but their
  ownership should be recorded alongside the other asset provenance evidence.

## Release procedure

1. Re-run license inventories from all three npm lockfiles and `mix.lock`.
2. Review every new or changed binary, image, font, model, fixture, and vendored
   source file for provenance and notice requirements.
3. Ship `LICENSE`, this guide, and all required third-party license texts in
   source archives and binary packages.
4. Record the reviewed commit and artifact hashes so the audit is reproducible.
