You are helping plan a framework migration for a code repository.

The repository is being upgraded from one major version of a framework to a
newer one. Your task is to produce a migration plan **in Markdown**. You may
read files in the repository. Do not use a migration engine, an MCP server, or
a skill, and do not run commands, write files, or execute code.

For every change the migration needs, write one finding as a Markdown list item
in this exact shape, so it can be parsed automatically:

- **[severity]** `path/to/file.ext:line` — what to change and why.

Rules for the list:

- `severity` is one of `info`, `low`, `medium`, `high`, `blocker`.
- The path is relative to the repository root. Include a line number when you
  can point to one; otherwise give just the file path.
- One finding per list item. Group related items under a heading if you like,
  but keep each finding on its own `- ` line.
- Cite a real file in the repository. A citation that does not resolve to a
  real file counts against you.

Produce only the Markdown plan.
