# MINAI on Pi — Stage 0 interface index

This is the interface review checklist for later phases.

## Implemented in Stage 0

- literal System One request/question/answer types;
- System One runtime validators;
- service registry;
- common model/guidance/artifact/event types.

## To design before implementation

- remote/local JEV backend interface;
- guidance catalog and model-specific instance resolver;
- model catalog, provider, and hoster interfaces;
- model selector interface;
- context and artifact store interface;
- task graph, scheduler, plan-version, and NEWPLAN interfaces;
- Python manifest, discovery, creator, runner, and sandbox interfaces;
- normalized OpenAI/Ollama request/result interfaces;
- request lifecycle, cancellation, timeout, and runtime event interfaces.

## Rules

1. Preserve literal external contracts first.
2. Keep implementation-specific metadata out of public JEV answers.
3. Keep domain policy in the consuming extension.
4. Keep provider/hoster details behind interfaces.
5. Make optional extension absence explicit.
6. Test contracts with fakes before real backends.
