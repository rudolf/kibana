# AGENTS.md

## Cursor Cloud specific instructions

This is **Kibana 8.0.0** (a large Bazel/Yarn monorepo). It is a browser-based
analytics/search UI for Elasticsearch, so running the app end-to-end requires an
Elasticsearch instance in addition to the Kibana dev server.

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

### Elasticsearch (required to run Kibana)
- Start it with: `yarn es snapshot --license trial` (downloads/extracts a
  snapshot into `.es/8.0.0`, then runs it). Dev credentials are
  `elastic` / `changeme`; it listens on **http://localhost:9200** (plain HTTP,
  security enabled).
- **Critical caveat:** the snapshot's bundled JDK crashes on startup in this
  container with a cgroup v2 NPE
  (`CgroupV2Subsystem.getInstance ... anyController is null`) while parsing JVM
  options. Work around it by exporting `JDK_JAVA_OPTIONS="-XX:-UseContainerSupport"`
  in the shell that launches ES (kbn-es forwards `process.env` to the ES child,
  so this reaches the JVM option parser). Without it, ES exits with code 1 before
  it starts.

### Kibana dev server
- Start it (in a separate shell, after ES is up) with: `yarn start`.
- The first start compiles ~117 optimizer bundles (a few minutes) before the app
  is available; wait for `Kibana is now available`.
- In dev mode Kibana serves under a **random base path** printed in the logs
  (e.g. `http://localhost:5601/wuh`). Pass `--no-base-path` to `yarn start` to
  pin it to `http://localhost:5601/`. Log in through the form with
  `elastic` / `changeme` (browser sessions use the login form, not HTTP basic
  auth).

### Lint / test
- Full-repo lint and test suites are enormous; scope them to a path/package.
  - ESLint: `node scripts/eslint <path>`  (style: `node scripts/stylelint`)
  - Jest unit: `node scripts/jest <path>` (e.g. `node scripts/jest packages/kbn-std`)
  - Jest integration / FTR: `node scripts/jest_integration`, `node scripts/functional_tests`.
