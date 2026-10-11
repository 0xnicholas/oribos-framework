# Agent skills

Installable agent skills for building with Oribos — consumed by coding agents, not by the
framework itself.

- [`oribos/`](oribos/) — the Oribos onboarding skill: the import map, core recipes, and the
  deliberately-absent list that keeps agents from inventing APIs the framework cut on purpose.

Install: copy `skills/oribos` into your agent's skills directory (for example
`~/.agents/skills/`), or use your tooling's `skills add`-style command against this repository.
Skills ship with the repository at every tag; the published npm tarballs do not include them.
