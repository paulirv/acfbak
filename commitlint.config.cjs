// Conventional Commit linting for BoB-provisioned automated versioning (#276).
// commit-and-tag-version derives version bumps from these commit types, so
// enforcing the convention is what keeps automated releases reliable.
//
// This file is only the shared rule set. The enforcement wiring — installing
// commitlint, and a commit-msg hook that coexists with BoB's no-AI-attribution
// pre-commit hook — is provisioned separately (see #278). Shipping the config
// here keeps the versioning template set self-contained and forward-compatible.
module.exports = {
  extends: ['@commitlint/config-conventional'],
};
