# Impact scan report (fixture)

This report's fence is tagged `impact-scan:v2`, not `impact-scan:v1` -- similar-looking but a
different tag entirely, so it MUST NOT be picked up as a valid v1 block (equivalent to the
report having zero v1 blocks, not to a version-2-shaped v1 block).

```impact-scan:v2
{
  "scan_version": "1",
  "repo_commit": "9f2c9c2e6b4b4d0a9a3d6a2f7a1c9e10ab34cd56",
  "candidate_paths": ["src/foo/Bar.ts"],
  "candidate_layers": ["domain"]
}
```
