## Summary

<!-- Describe the concrete problem and the resulting behavior. -->


## Change type

- [ ] Bug fix
- [ ] Feature or behavior change
- [ ] Documentation or CI
- [ ] Refactor or maintenance

## Validation

<!-- List exact commands and relevant manual checks. -->

- `npm run check`:
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`:
- Native/manual checks:

## Platform and data impact

- Tested on:
- Not tested on:
- Does this affect plugins, terminal commands, Git, filesystem access, recovery,
  persisted settings, or permissions? If yes, explain the trust or migration impact.

## Documentation and release impact

- [ ] I updated `docs/product-spec.md` and `CHANGELOG.md` for feature or behavior changes.
- [ ] I synchronized the README and both English and Traditional Chinese website/user guides.
- [ ] I updated affected shortcuts, settings, limits, permissions, persistence and platform notes.
- [ ] I reviewed affected screenshots, SEO metadata, and third-party notices.
- Documentation surfaces not affected (explain why):
- [ ] I documented any user-visible limitation or platform-specific behavior.
- [ ] This PR does not require release/signing secrets, or the maintainer-only setup
      is described here:

## Checklist

- [ ] The diff is focused and does not include unrelated generated files or lockfile changes.
- [ ] I removed secrets, credentials, recovery data, private source, and sensitive logs.
- [ ] I added or updated meaningful tests when behavior changed.
- [ ] I ran the checks above, or explained why a check could not run.
- [ ] I am authorized to submit this work and have not assumed a project license that
      maintainers have not selected.
