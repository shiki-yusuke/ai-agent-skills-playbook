# Impact scan report (fixture)

sol architect-review 3rd round must4: this block's `open_items` contains a string with literal
backtick characters, but they never sit alone on their own line -- a naive whole-text regex
scanning for the next "```" could mistake them for the closing fence and truncate the block
early. Line-anchored extraction is immune to this: only a line that IS exactly "```" (nothing
else) closes the block.

```impact-scan:v1
{
  "scan_version": "1",
  "repo_commit": "9f2c9c2e6b4b4d0a9a3d6a2f7a1c9e10ab34cd56",
  "candidate_paths": ["src/foo/Bar.ts"],
  "candidate_layers": ["domain"],
  "open_items": ["see ```example``` in the review comment for context"]
}
```
