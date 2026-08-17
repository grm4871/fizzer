# Contributing to Fizzer

Fizzer welcomes focused bug reports, documentation improvements, agent adapter
work, and product changes that make multiplayer human-agent collaboration more
reliable and understandable.

## Before changing code

- Search existing issues and discussions before opening a duplicate.
- For a large feature or architectural change, open an issue first so the
  direction can be agreed before substantial implementation work.
- Never include credentials, private workspace data, production host details,
  database files, logs, or `.private/` contents.

## Local setup

Follow the [source quickstart](README.md#run-from-source), then create a branch
from `master`. Keep changes scoped and update documentation when a public
command, configuration setting, or behavior changes.

Run the checks relevant to your change:

```bash
npm run build
npm test
npm run test:cli-agents
npm run test:electron
```

The full release matrix is documented in
[`docs/release-matrix.md`](docs/release-matrix.md). Pull requests should state
what changed, why, and exactly what was verified.

## Contributions and licensing

By submitting a contribution, you agree that it may be distributed under the
project's [MIT License](LICENSE). You must have the right to submit the code,
text, or assets in your contribution and preserve required third-party notices.

Be direct, constructive, and respectful. Critique the work rather than the
person, and do not publish another person's private information. Participation
is subject to the [community standards](CODE_OF_CONDUCT.md).
