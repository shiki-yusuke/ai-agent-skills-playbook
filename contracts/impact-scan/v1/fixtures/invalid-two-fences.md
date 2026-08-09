# Impact scan report (fixture)

This report accidentally carries two `impact-scan:v1` blocks -- ambiguous, since a consumer
cannot tell which one is authoritative.

```impact-scan:v1
{
  "scan_version": "1",
  "repo_commit": "9f2c9c2e6b4b4d0a9a3d6a2f7a1c9e10ab34cd56",
  "candidate_paths": ["src/foo/Bar.ts"],
  "candidate_layers": ["domain"]
}
```

Some intervening text, perhaps from a merge or a re-run that appended instead of replacing.

```impact-scan:v1
{
  "scan_version": "1",
  "repo_commit": "c9e10ab34cd569f2c9c2e6b4b4d0a9a3d6a2f7a1",
  "candidate_paths": ["src/domain/order.ts"],
  "candidate_layers": ["domain"]
}
```
