# Contributing to Continuum

Thanks for your interest! Continuum is the open capture + memory layer — a shovel others
build use cases on. Contributions to the core are very welcome.

## Ground rules
- **Sign your commits (DCO).** Add `-s` to every commit (`git commit -s`). This certifies
  you wrote the patch and can submit it under the project license — see
  [developercertificate.org](https://developercertificate.org/).
- **Keep the core pure.** Stages 2–4 take injected adapters (embedder / LLM / graph) and
  must run offline. Don't add a hard dependency on a cloud provider in the core.
- **No new runtime dependencies** without discussion — the project is intentionally
  dependency-free.

## Develop

```bash
git clone https://github.com/nikhilkagita04/continuum && cd continuum
npm test                                              # 36 unit + integration tests, no network
node bin/continuum.mjs verify                          # end-to-end smoke
swiftc daemon/stage1/capture.swift -o daemon/stage1/capture   # build the capture helper (macOS)
```

## Architecture
See [`docs/architecture/ingestion-pipeline.md`](docs/architecture/ingestion-pipeline.md)
for the four-stage design (capture → segment → index → distill). Each stage is a small,
tested module under `daemon/`.

## Pull requests
- Add/keep tests green (`npm test`).
- One focused change per PR; match the surrounding style.
- Describe the *why*, not just the *what*.

By contributing, you agree your contributions are licensed under the project's Apache-2.0 license.
