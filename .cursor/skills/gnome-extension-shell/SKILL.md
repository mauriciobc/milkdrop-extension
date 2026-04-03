---
name: gnome-extension-shell
description: Desenvolver, revisar e depurar extensoes GNOME Shell com GJS (ciclo enable/disable, sinais, fontes GLib, subprocessos, regras de review e integracao com renderer GTK/GL).
---

# GNOME Extension + GNOME Shell

## Quando usar esta skill

Use quando o pedido envolver:

- `extension.js`, `monitor.js`, `prefs.js` ou ciclo de vida da extensao
- sinais (`connect`/`disconnect`), fontes GLib (`timeout_add`, `idle_add`)
- subprocessos (`Gio.Subprocess`) e IPC em extensoes
- regras de review do ecosistema GNOME

## Principios operacionais (oficiais)

Fonte: GNOME JS Guide / Review Guidelines.

1. **Nao criar objetos GNOME no init**
   - Nada de `Gio.Settings`, `St.Widget`, `Meta.*` no escopo de modulo/construtor que dependa de runtime.
   - Criar recursos dinamicos em `enable()`.
2. **Cleanup rigoroso em `disable()`**
   - Destruir widgets/objetos
   - Desconectar sinais
   - Remover todas as `source id` GLib
3. **Sem spam de log**
   - Evitar logs por frame no processo do shell
4. **Separar mundos Shell vs Prefs**
   - Shell: nao importar `Gtk`, `Gdk`, `Adw`
   - Prefs: nao importar `Clutter`, `Meta`, `St`, `Shell`

## Checklist de implementacao segura (Shell process)

1. **Lifecycle**
   - Tudo que nasce em `enable()` precisa morrer em `disable()`
   - Conferir campos que guardam IDs (`_sourceId`, `_handlerId`, etc.)
2. **Main loop**
   - Se adicionou `GLib.timeout_add/idle_add`, remover explicitamente no teardown
3. **Sinais**
   - Se conectou sinal, armazenar ID e desconectar no teardown
4. **Subprocesso**
   - Evitar bloquear thread principal
   - Garantir encerramento limpo em `disable()` (cancel/close/force_exit apenas quando necessario)
5. **IPC / fila**
   - Manter fila limitada para nao travar shell
   - Priorizar drop de payload de frame em vez de bloquear UI

## Checklist de integracao GtkGLArea + renderer nativo

1. Confirmar que o renderer nativo usa contexto GL valido no thread correto
2. Em resize: atualizar viewport/FBO com tamanho em pixels fisicos (HiDPI)
3. Se integrar biblioteca GL externa (ex.: projectM):
   - renderizar em FBO controlado pela aplicacao
   - evitar disputa de estado GL com GtkGLArea
4. Validar telemetria essencial:
   - helper pronto
   - erro de shader/contexto
   - latencia render/readback

## Regras de decisao rapida

- **Mudanca pequena e local?** edite cirurgicamente, sem refatorar adjacentes.
- **Bug de lifecycle?** prefira corrigir teardown antes de adicionar novos guards.
- **Duvida entre robustez e simplicidade?** escolha simplicidade com teste de regressao.

## Resultado esperado da analise

Ao responder um problema GNOME Shell, devolver:

1. Hipotese principal (1 frase)
2. Quais itens do checklist falharam
3. Correcao minima
4. Como verificar (teste/log/fluxo enable-disable)
