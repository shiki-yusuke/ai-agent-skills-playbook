# Impact scan report (fixture)

This report's fence carries trailing content after the tag ("lang=json") -- per the skill's
literal spec, the info string IS the string "impact-scan:v1" itself, nothing else. sol
architect-review 2nd round must C: this MUST now be treated as zero valid blocks (a previous
round's leniency, mirroring one consumer's own implementation choice, has been reverted from
the wire contract).

```impact-scan:v1 lang=json
{
  "scan_version": "1",
  "repo_commit": "9f2c9c2e6b4b4d0a9a3d6a2f7a1c9e10ab34cd56",
  "candidate_paths": ["src/foo/Bar.ts"],
  "candidate_layers": ["domain"]
}
```
