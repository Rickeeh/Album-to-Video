# Distribution Choice A/B (Post-Intel Validation)

Context: mac universal build flow validated locally on Apple Silicon and Intel.

## Option A: Commit binaries with Git LFS

Tradeoffs:
- Pros: fully offline in CI, deterministic at source level.
- Cons: larger repo footprint, LFS cost/quotas, legal/compliance handling in-repo.

CI impact:
- Simpler bootstrap (no download step).
- Requires LFS support in checkout (`git lfs pull`).

## Option B (Recommended): Internal release assets + checksum download

Tradeoffs:
- Pros: small repo, explicit provenance/versioning of binary payloads, easier rotation.
- Cons: adds download/bootstrap step and checksum management.

CI impact:
- Add pre-build fetch step for `resources/bin/*` from internal release assets.
- Verify SHA256 checksums before packaging.
- Cache downloaded assets per version.

## Recommended decision

Choose Option B for cleaner repo hygiene and controlled binary provenance, while keeping
`extraResources` packaging unchanged.
