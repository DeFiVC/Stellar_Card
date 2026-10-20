# Contributing to the SDK

## Release notes and versions

For a user-facing SDK change, include a Changeset with your pull request:

1. From `stellar_card-sdk`, run `npx changeset`.
2. Select `stellar_card` and the appropriate `patch`, `minor`, or `major` bump.
3. Write a concise summary of the user-visible change and commit the generated file under `.changeset/`.

Changesets are versioned and released automatically. When a changeset-bearing pull request is merged to `main`, the release workflow opens or updates a `Version Packages` pull request. Merging that PR updates `package.json` and `CHANGELOG.md`; the workflow then publishes the SDK to npm with provenance and creates a GitHub Release from the generated changelog.

Do not manually edit the SDK version or changelog for routine releases. Changes that do not affect published SDK behavior do not need a Changeset.

## Release credentials

The repository must have an `NPM_TOKEN` Actions secret with permission to publish `stellar_card`. The workflow also requires GitHub Actions permissions for contents, pull requests, and the OIDC identity token; these are declared in `.github/workflows/release-sdk.yml`.
