# AGENTS.md

## Cursor Cloud specific instructions

This is **Kibana 8.0.0** (a large Bazel/Yarn monorepo). For typical Cursor Cloud
agent work, **checking out the code and bootstrapping deps is enough** — do
**not** start Elasticsearch or the Kibana dev server unless the task explicitly
asks you to run the application end-to-end.

Standard setup/run/test commands are documented in `README.md`,
`CONTRIBUTING.md`, `dev_docs/getting_started/setting_up_a_development_env.mdx`,
and `package.json` `scripts`. Only the non-obvious, environment-specific caveats
are captured below.

### Node / Yarn
- Kibana requires the exact Node version in `.node-version` (**16.11.1**). The VM
  ships a newer default Node (v22) and the exec harness puts its own `node` early
  on `PATH`, so plain `node`/`yarn` may resolve to the wrong version.
- Node 16.11.1 (with a matching global `yarn`) is installed via `nvm` and both
  binaries live in `~/.nvm/versions/node/v16.11.1/bin`. `~/.bashrc` prepends this
  to `PATH`, so **interactive/login shells (including tmux) get Node 16
  automatically**. If you spawn a shell that does not source `~/.bashrc`, prepend
  it yourself: `export PATH="$HOME/.nvm/versions/node/v16.11.1/bin:$PATH"`.

### Bootstrap (dependency install) — handled by the startup update script
- `yarn kbn bootstrap` installs deps and builds packages via the vendored Bazel
  (bazelisk is fetched automatically; no separate Bazel install needed).
- **Caveat:** the final `build_ts_refs` step tries `git fetch
  https://github.com/elastic/kibana.git master` to pull a TS-refs build cache.
  Upstream's default branch is now `main`, so that fetch fails with
  `couldn't find remote ref master` and aborts bootstrap. Run bootstrap with
  `BUILD_TS_REFS_CACHE_ENABLE=false` to skip the cache lookup (TS refs are still
  built locally). The startup update script already does this.

### Lint / test
- Full-repo lint and test suites are enormous; scope them to a path/package.
  - ESLint: `node scripts/eslint <path>`  (style: `node scripts/stylelint`)
  - Jest unit: `node scripts/jest <path>` (e.g. `node scripts/jest packages/kbn-std`)
  - Jest integration / FTR: `node scripts/jest_integration`, `node scripts/functional_tests`
    (these may need Elasticsearch; only run when the task requires them).

### Running Kibana / Elasticsearch (only when explicitly requested)
Do not start these for ordinary code/lint/unit-test tasks.

- Elasticsearch: `yarn es snapshot --license trial` → `http://localhost:9200`,
  credentials `elastic` / `changeme`.
  - **Caveat:** the snapshot's bundled JDK crashes on startup in this container
    with a cgroup v2 NPE (`CgroupV2Subsystem.getInstance ... anyController is
    null`). Export `JDK_JAVA_OPTIONS="-XX:-UseContainerSupport"` in the shell
    that launches ES (kbn-es forwards `process.env` to the ES child).
- Kibana: `yarn start` (after ES is up). First start compiles ~117 optimizer
  bundles. Dev mode serves under a **random base path** (e.g.
  `http://localhost:5601/wuh`); pass `--no-base-path` to pin to `/`. Log in via
  the form with `elastic` / `changeme`.
