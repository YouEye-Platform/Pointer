# Benchmark and icon presentation

Pointer web is a renderer for Pointer server's benchmark contract. It never fetches Artificial
Analysis, BenchLM, LMArena, LiveBench, Aider, or another benchmark source directly.

## Dynamic benchmark UI

The Models page initializes its sort as `recommended`. Pointer server supplies the active
general-source set, normalized consensus, per-source effective ranks, and `benchmarkDescriptors`. Pointer web builds sort options,
column toggles, labels, units and attribution from those descriptors; there is no benchmark-ID
allowlist in the page.

Default-visible columns come from each descriptor's `defaultVisible`. A user may add or remove any
descriptor returned by Pointer server. A percent value in the 0–1 range is displayed as a percentage; point
scores and published ranks remain source-specific. Model detail displays every numeric metric and
the original source model/configuration label. Pointer web never calculates the consensus or
rewrites a source score; it renders the server-owned equal-weight percentile result.

Admins configure the optional Artificial Analysis source on the Admin page. The password input is
never prefilled. Saving sends the submitted value once to Pointer server over the authenticated API and then
clears it. Subsequent reads receive only `hasCredential`. Removing the key tells Pointer server to disable AA
and rebuild its ranking; Pointer web has no local credential state.

Artificial Analysis free access is subject to its current internal-use, attribution, and request
limit terms. The UI makes the source optional and explains that the keyless BenchLM/LMArena
fallback remains available.

## Bundled icon policy

Pointer server supplies stable semantic `providerIconKey` and `modelIconKey` values. Model-family
identity wins over a generic creator mark; unknown and custom identities use a neutral local glyph.
Pointer web maps only an allowlisted key to a vendored asset and never accepts a URL from API data.
Model and provider marks render directly on a transparent surface without a border, background,
rounded tile, or clipping mask.

Thirty-seven selected SVG files are vendored in `public/icons/brands/` from
`@lobehub/icons-static-svg` version `1.94.0` (npm integrity
`sha512-Inx1TYkjLH6YeHOIHeVW9+OM/xxRnk8TmcQVKquFUDBmE3X9sUuRGt7kALrrDBNNAbrWz7Qq6fAiFj9E9Mmw9Q==`).
They are served by each Pointer instance; browsers do not contact LobeHub, a CDN, model providers,
or creator websites. The prior `public/icons/providers/*.png` Git LFS pointer text remains removed.

Lobe Icons is Copyright © 2023 LobeHub and distributed under the MIT License. The complete notice
ships at `public/icons/brands/NOTICE.txt` and is linked as **Icon licences** in the authenticated
sidebar. Brand names and marks may remain trademarks of their respective owners; Pointer uses them
only for identification and does not claim ownership, affiliation, sponsorship, or endorsement.
This review was completed on 2026-07-28 against the package version and source above.

The exact vendored files are:

`ai21-brand-color.svg`, `anthropic.svg`, `arcee-color.svg`, `aws-color.svg`, `aya-color.svg`,
`baidu-color.svg`, `cerebras-color.svg`, `chatglm-color.svg`, `claude-color.svg`, `codex-color.svg`,
`cohere-color.svg`, `commanda-color.svg`, `deepinfra-color.svg`, `deepseek-color.svg`,
`fireworks-color.svg`, `gemini-color.svg`, `gemma-color.svg`, `google-color.svg`, `grok.svg`,
`groq.svg`, `kimi-color.svg`, `kimi.svg`, `meta-color.svg`, `microsoft-color.svg`, `minimax-color.svg`,
`mistral-color.svg`, `nvidia-color.svg`, `openai.svg`, `openrouter-color.svg`,
`perplexity-color.svg`, `qwen-color.svg`, `sambanova-color.svg`, `together-color.svg`,
`upstage-color.svg`, `xai.svg`, `yi-color.svg`, and `zhipu-color.svg`.

To remove third-party marks, delete `public/icons/brands/*.svg` while retaining the notice if a
distributed copy still contains the marks. `IconAvatar` then falls back safely on image error.
Pointer's own source-code licence is unchanged.
