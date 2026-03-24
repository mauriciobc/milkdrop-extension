# Checklist — refatoração lean (PR)

Antes de mergear um PR que toca código de produção:

1. `gjs -m tests/run.js` (na raiz do repositório)
2. `gjs -m tests/run-parity.js` (na raiz)
3. Se hot path: `gjs -m tests/bench/run.js` (opcional, recomendado para audio/evaluator/ipc/expr)
4. Se alterou `src/renderer/gl-helper.c` ou build nativo: `meson compile -C build` (ou `just install`)

**Ordem sugerida de fases:** `monitor.js` → `audio.js` → `gl-bridge.js` → `gl-helper.c` → demais módulos menores → `expr/` / `milk-parser.js` por último.

**Restrições (lean-refactor):** sem mudar contratos IPC, D-Bus, GSettings, exports usados por testes; preferir extrair funções e guard clauses a renomear APIs.
