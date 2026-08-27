# Working in `autorecorder/`

**Before editing anything here, read [ADAPT.md](ADAPT.md).**

This folder is a portable screen-recording suite shared across every CopilotKit
framework repo adapted per framework.

Two rules override any instinct to tidy:

1. **`core/` is frozen.** It holds no framework-specific values — they all come
   from `config/`. If a port seems to need a `core/` change, report it instead of
   making it: it means something leaked into shared code and every other repo has
   the same bug.

2. **`npm run doctor` is the definition of done.** Not "the config looks right".
   The command exits 0, or the adaptation is not finished. Say which check fails
   rather than describing the work as complete.

The adaptation surface is exactly: `config/project.config.ts`,
`config/pages.config.ts`, `config/selectors.config.ts`, and `actions/`.

When a change here is worth keeping across repos, it belongs in `core/` and
should be ported to the other copies — say so explicitly so it can be.
