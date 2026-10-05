# Stage 3 — Local JEV cascade foundation

This stage adds the local backend seam without requiring FlashRank, embeddings, or model weights. It provides a deterministic classifier suitable for offline operation and a cascade that can later host embedding, cross-encoder, and fallback-LLM tiers.

## Boundary

```text
SystemOneRequest
  → LocalSystemOneService
      → ordered LocalSystemOneTier[]
      → first successful exact System One response
```

Tiers are generic: they receive the literal request and return a literal response or `undefined`. They do not know that a Choice question might represent guidance or model routing.

The deterministic tier is deliberately modest. For Choice it uses token overlap between state and option descriptions; Score and Noul use stable, documented heuristics to guarantee a valid offline answer. It is a safety fallback, not a quality claim.

## Configuration

`backend: "local"` uses the local cascade. `backend: "auto"` currently resolves to the local cascade so the system remains usable without network access. Remote, embedding, FlashRank, local-model, and LLM tiers will be added behind the same tier interface later.

`escalate_to_llm` is accepted as configuration metadata but is not acted on until a model-hoster adapter exists. No recursive JEV call is made by this stage.

## Acceptance

- Local output is literal System One output and passes shared validation.
- Choice outputs include all declared options and normalized probabilities.
- Score outputs include a valid score, legend, and distribution.
- Noul outputs contain a probability in `[0, 1]`.
- A cascade can try injected tiers in order and continue after an undefined result.
- Abort signals are honored before and between tiers.
- No domain-specific guidance/model/tool policy is added.
