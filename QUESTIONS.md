# QUESTIONS.md — Full Codebase Tech-Lead Review

> Revisão completa de `gnome-milkdrop` conduzida como se eu fosse o tech lead do projeto. O arquivo anterior do QUESTIONS.md foi substituído por este novo ciclo de perguntas, que reflete o estado atual do código. Entenda cada questão como um item independente: ao responder, marque a intenção (ver "How to Answer") e, se for um bug, descreva o comportamento correto que você espera.

---

## Project Understanding Summary

**gnome-milkdrop** é uma extensão do GNOME Shell (GJS) que entrega visualizações MilkDrop-style no desktop, usando uma arquitetura multi-processo:

1. **Shell extension (`src/extension/`)** — roda dentro do processo `gnome-shell`. Dona da captura de áudio (GStreamer), da lifecycle de monitores, da descoberta/rotação de presets `.milk`, da pump de frames (~16ms a 60fps), do servidor IPC (Unix socket), do serviço D-Bus de status, das sobreposições no GNOME Shell (`InjectionManager`) e da clonagem do renderer como "wallpaper vivo".
2. **Renderer process (`src/renderer/renderer.js`)** — aplicação GTK4 standalone por monitor. Conecta ao IPC do lado da extensão, recebe frames, repassa para o C helper via stdin e exibe texturas RGBA8 via `GtkGLArea` / `Gdk.MemoryTexture`.
3. **Native GL helper (`src/renderer/gl-helper.c`)** — executa projectM-4 via EGL pbuffer, faz readback em PBO/SHM memfd e entrega pixels ao renderer via Unix socket com FD passing.
4. **Expressão MilkDrop (`src/extension/expr/`)** — lexer + parser Pratt + compilador em closure-tree (sem `eval`), com contexto `q1..q32`, `t1..t8`, `reg00..reg99`, `megabuf`/`gmegabuf` (1MB `Float64Array` cada).
5. **Parser `.milk` (`src/extension/milk-parser.js` + `preset-loader-process.js`)** — um subprocesso GJS parseia os `.milk` de uma pasta escolhida pelo usuário e devolve JSON, isolando parsing hostil do `gnome-shell`.

Fluxo de dados resumido:

```
GStreamer pulsesrc → appsink PCM 576 samples → audio.js → monitor.js (frame pump)
  → Evaluator.evaluateFrame (shell JS) → IPC (JSON socket) → renderer.js
  → GlBridge (stdin JSON) → gl-helper.c (projectM + EGL) → SHM memfd
  → GlBridge drena FD → Gdk.MemoryTexture → GtkGLArea → WindowActor
  → Clutter.Clone em todos os BackgroundActor (LiveWallpaper)
```

O projeto target é GNOME Shell 47/48/49, Wayland-first. Testes são executados com um runner custom em GJS (sem Jest). O projeto declara "bench, parity, golden frames" no CLAUDE.md.

---

## How to Answer

Para cada pergunta, escreva abaixo do bullet `**Finding:**` a sua resposta. Sugestão de tags:

- `intended` — comportamento deliberado, nada a fazer.
- `bug` — é um bug, precisa ser corrigido. Descreva o comportamento esperado.
- `approved` — melhoria aprovada, corrigir agora.
- `deferred` — melhoria válida, adiar para uma próxima iteração.
- `out-of-scope` — fora do escopo deste projeto.
- `verified` — confirmado por inspeção / teste; não é um problema.
- `needs-investigation` — não sei, preciso investigar antes de decidir.

Se quiser pular uma pergunta sem responder, use `skip`. Perguntas com bloco de código citando o caminho e linhas são mais fáceis de responder contextualizando no editor.

---

## 1. Suspected Bugs (Highest Priority)

### Q1. PCM audio é (provavelmente) descartado em todos os frames por causa de `Float32Array` + `JSON.stringify`

- **Onde:** `src/extension/audio.js:564-571` (features guardam `Float32Array`), `src/extension/frame-state.js:15-16` (snapshot repassa referência), `src/extension/ipc.js:138` (`JSON.stringify`), `src/renderer/gl-bridge.js:362-371` (`Array.isArray` como filtro).
- **Por que importa:** `AudioEngine._defaultFeatures()` aloca `pcmLeft` e `pcmRight` como `Float32Array(576)`. Essas referências são repassadas pelo `snapshotAudioForFrame` para o objeto IPC. Em `JSON.stringify`, a especificação ECMAScript trata `TypedArray` como **objeto indexado**, não como `Array`: o wire format vira `"pcmLeft":{"0":0.1,"1":0.2,...}` em vez de `"pcmLeft":[0.1,0.2,...]`. Do lado do renderer, `gl-bridge.js:_buildFrameHelperPayload` usa `Array.isArray(audio.pcmLeft)` para decidir se usa os samples — como `Array.isArray({...}) === false`, o resultado é `pcmLeft: []` enviado para o helper em **todo frame**.
- **Efeito observado esperado:** projectM recebe PCM zerado → beat detection, `bass_att`, `treb_att`, waveform visualization todos inertes. A visualização fica basicamente congelada do ponto de vista sonoro.
- **Pergunta:** Existe alguma conversão de `Float32Array` para `Array` plano em algum ponto do caminho que eu não vi? Se não, precisamos (a) converter PCM para array plano em `snapshotAudioForFrame` (ou `getFeatures`), ou (b) mudar o transporte para binário (Base64 de `Float32Array.buffer` ou SHM separado, como já sugerido em `.kiro/specs/code-hygiene-fixes/requirements.md` Requisito 10). Qual é o approach pretendido?
- **Finding:**

### Q2. Beat-cuts nunca disparam porque `audio.getFeatures()` não devolve `beat`

- **Onde:** `src/extension/audio.js:109-118` (getFeatures retorna só `source/active/pcmLeft/pcmRight`), `src/extension/frame-state.js:13` (snapshot lê `rawAudio.beat` com fallback 0), `src/extension/monitor.js:1675-1684` (`_maybeRotateOnBeat` gate em `evaluated.audio?.beat`).
- **Por que importa:** O setting `beat-cuts-enabled` é exposto na UI de prefs e documentado em `CLAUDE.md`/`docs/development.md`, mas `AudioEngine` nunca calcula/expõe `beat`, `bass`, `mid`, `treb`, `energy` nem `*_att`. O snapshot devolve tudo zero. `_maybeRotateOnBeat` checa `evaluated.audio?.beat` que é sempre 0 (`Number(undefined ?? 0) === 0`), então a cláusula `evaluated.audio?.beat` é sempre falsy e `_rotatePreset()` nunca é chamado por beat-cut. O setting e a lógica de cooldown são mortos.
- **Pergunta:** Isso é intencional (o helper projectM faz beat detection internamente e não precisamos do lado do shell)? Se sim, o setting `beat-cuts-enabled` deveria ser removido da UI, documentado como "requer reimplementação do spectrum no shell" ou o helper deveria mandar de volta via IPC um sinal de beat para o shell rotar preset? Se for para reintroduzir spectrum/beat no shell, qual pipeline GStreamer (spectrum + RMS) queremos?
- **Finding:**

### Q3. `AudioEngine._startAppsinkPoll` usa variável errada e um appsink "fantasma"

- **Onde:** `src/extension/audio.js:52` (`this._appsink = null`), `:173` (`this._appSink = GstApp.AppSink.new(...)` — note o S maiúsculo), `:174-175` (`if (this._appSink) this._startAppsinkPoll();`), `:440-458` (`_startAppsinkPoll`).
- **Por que importa:** Existem duas properties, `this._appsink` (nunca atribuída) e `this._appSink` (atribuída). O método `_startAppsinkPoll` faz duas coisas inadvertidas:
  1. `if (!this._appsink || !this._enabled) return;` — como `this._appsink` é sempre `null`, **o método sempre retorna imediatamente** e o polling nunca começa.
  2. Mesmo que o guard estivesse certo, `const appSink = GstApp.AppSink.new(null);` cria um **appsink solto sem ligação a elemento nenhum**, e depois usa `appSink.try_pull_sample(0)` neste fantasma — não no `this._appSink` do pipeline. Ou seja, mesmo se chegasse ao loop, não puxaria nenhum sample real.
- **Efeito:** PCM nunca é lido do pipeline → `_features.pcmLeft/pcmRight` ficam zerados → `_lastUpdateUsec` nunca avança → `active` fica `false` eternamente → `snapshotAudioForFrame` manda `pcmLeft: []` (por causa do `rawAudio?.active ? ... : []`).
- **Pergunta:** Você confirma que isso é um bug (provável regressão ao trocar `emit-signals=true` por polling)? A intenção é usar `this._appSink.try_pull_sample(0)` e remover o guard em `this._appsink` / a variável fantasma?
- **Finding:**

### Q4. Não existe spectrum/bass/mid/treb computado no shell — docs dizem o contrário

- **Onde:** `src/extension/audio.js:221-223` (pipeline `src ! queue ! audioconvert ! audioresample ! appsink`), vs `CLAUDE.md:77` ("GStreamer Spectrum (24 bands)"), `docs/development.md`/`docs/extension-benchmark.md`.
- **Por que importa:** A documentação afirma que a extensão calcula 24 bandas de espectro via GStreamer `spectrum`, de onde saem `bass/mid/treb/beat/energy`. O código real não tem elemento `spectrum` no pipeline, não consome mensagens de `element` do bus, não calcula RMS nem FFT por janela. Todas as variáveis `bass/mid/treb/energy/beat` em `frame-state.js`/`expr/context.js` são lidas do `rawAudio`, que nunca recebe esses campos (ver Q2). O per-frame evaluator passa `frameState.bass ?? 0` — sempre 0.
- **Pergunta:** A intenção é que essa computação esteja 100% no helper (projectM faz `pcm_add_float` e cuida de bass/mid/treb/beat internamente, e o shell só precisa entregar PCM)? Ou era para ter sido reintroduzido no shell e ficou pela metade? Esta decisão afeta Q1, Q2 e Q46 abaixo.
- **Finding:**

### Q5. Expression evaluator do shell roda em todo frame mas **o helper ignora o resultado**

- **Onde:** `src/extension/evaluator.js:68-235` (Evaluator), `src/renderer/gl-bridge.js:360-378` (`_buildFrameHelperPayload` só usa `time`, `pcmLeft`, `pcmRight`, `presetPath`).
- **Por que importa:** A pump de frames chama `Evaluator.evaluateFrame` para cada monitor, cada frame. Isso executa `ExpressionEvaluator`, copia 35+ campos de `RENDER_CONTROL_DEFAULTS`, aplica blend, atualiza `_prevExprCtx`, aloca arrays, reseta `_megabuf` em trocas de preset. Todo esse `zoom/rot/dx/dy/decay/...` é empacotado no frame IPC. Mas do outro lado, o helper **só lê `presetPath` + PCM + time**, e o próprio projectM re-executa o `.milk` nativamente em C++. O resultado do evaluator JS só é consumido pelo fallback CSS-like do `glarea.js:vfunc_snapshot` quando o helper está indisponível.
- **Pergunta:** Se projectM é autoritativo, por que continuamos pagando esse custo no main loop do `gnome-shell` a 60fps? Opções:
  - (a) Desativar `Evaluator` quando o helper estiver `ready` (só executa no fallback).
  - (b) Remover o evaluator JS do runtime e manter só como ferramenta de paridade/tests (o diretório `src/extension/expr/` e `tests/parity/` continuam válidos).
  - (c) Manter como está, aceitando o overhead.
- **Finding:**

### Q6. `sanitisePreset` e o "formato JSON legado" são código morto em produção

- **Onde:** `src/extension/presets.js:76-289` (sanitisePreset, sanitiseWaveSpec, sanitiseCustomWaves, sanitiseCustomShapes, DEFAULT_WAVE, DEFAULT_ZOOM_WAVE, DEFAULT_DECAY_WAVE, WAVE_DEFAULTS, SHAPE_DEFAULTS, VALID_WARP_TYPES, VALID_WAVEFORMS). Usado em `tests/bench/presets.bench.js` mas **nenhuma chamada em runtime**.
- **Por que importa:** O subprocess `preset-loader-process.js` já cria o objeto de preset final (`_buildPresetFromMilkText`) a partir do `.milk` parseado, com `customWaves/customShapes` já no formato nested. A função `sanitisePreset` assume um formato "JSON de entrada" com chaves flat (`wavecode_0_enabled`, etc.) que não existe em nenhum caller vivo.
- **Pergunta:** Isso é lixo histórico do caminho antigo "legacy WaveSpec + shaders GLSL custom no renderer GJS"? Removemos sanitisePreset + familia + `BOOTSTRAP_PRESET.frame/vertex/shaders` por serem código morto? Mantemos para retornar ao caminho dual no futuro?
- **Finding:**

### Q7. `BOOTSTRAP_PRESET` tem GLSL/vertex/frame que nada consome

- **Onde:** `src/extension/presets.js:9-74`.
- **Por que importa:** O preset de bootstrap contém `shaders.draw/warp/composite` (GLSL completos), `vertex.warpAmount/Speed/Scale/Type` e `frame.zoom/rot/dx/dy/decay` (WaveSpec). Nenhuma dessas áreas é lida pelo helper projectM nem pelo `glarea` (o fallback usa `state.zoom/rot/t/frame` a partir do frame-state, não do preset). Os shaders embutidos só fariam sentido se existisse um renderer GJS/GL custom, que foi removido.
- **Pergunta:** Reduzir `BOOTSTRAP_PRESET` para apenas `{id, name, description, source}` e usar apenas como marcador de "não há preset externo"? Ou devemos ter um preset `.milk` literal embutido para servir como fallback real para o helper?
- **Finding:**

### Q8. `milk-parser.js:parseCodeBlock` pode perder equações com gaps no índice

- **Onde:** `src/extension/milk-parser.js:51-72`.
- **Por que importa:** O parser de blocos de código (`per_frame_1=`, `per_frame_2=`, ...) quebra o loop se encontrar um gap (`if (lastNum !== -1 && num !== lastNum + 1) break;`). Presets reais do MilkDrop não têm garantia de numeração sem gaps — editores humanos podem pular índices. Quando isso acontece, `frame_eqs` fica truncado e `validatePresetExpressions` pode aceitá-lo (o parser compila o que sobrou). Resultado: preset silenciosamente com comportamento errado.
- **Pergunta:** Devemos mudar para coletar todos os índices, ordenar, e concatenar? Ou o contrato do MilkDrop original é "numeração contínua obrigatória"? (Spoiler: os utilitários oficiais do projectM toleram gaps.)
- **Finding:**

### Q9. `milk-parser.js:parseMilkPreset` faz trabalho duplicado em `init_eqs/frame_eqs/pixel_eqs`

- **Onde:** `src/extension/milk-parser.js:151-220`.
- **Por que importa:** O loop principal (linhas 151-214) acumula `per_frame_init`, `per_frame`, `per_pixel` em `preset.init_eqs/frame_eqs/pixel_eqs` via `+=`. Depois, as linhas 216-218 **sobrescrevem** esses três campos chamando `parseCodeBlock`, que recalcula do zero. Em presets grandes, o `+=` no loop gera milhares de re-concatenações descartadas pouco depois. Hot code-smell.
- **Pergunta:** Remover o caminho no loop e deixar apenas o `parseCodeBlock` final? Ou o loop está ali por outro motivo que eu não vi?
- **Finding:**

### Q10. Socket path IPC é determinístico — colisão entre sessão principal e nested shell

- **Onde:** `src/extension/ipc.js:7-12` (`buildSocketPath`).
- **Por que importa:** O caminho é `${XDG_RUNTIME_DIR}/gnome-milkdrop-${monitorIndex}.sock`. Se você rodar `just nested` (outra sessão `gnome-shell --devkit --wayland` com `dbus-run-session`) enquanto a extensão já está habilitada na sessão principal, as duas vão brigar pelo mesmo socket (`unlink` + `bind`). Resultado: renderers aleatoriamente desconectam, logs "bind failed" sem mensagem clara, etc.
- **Pergunta:** Adicionar um nonce (pid? display name?) ao socket path? Documentar que nested e principal não podem coexistir? (Hoje o `justfile` usa `just nested` mas não desabilita a extensão no host.)
- **Finding:**

### Q11. `IpcServer._handleLine` e `IpcClient._handleLine` não têm limite de tamanho de linha

- **Onde:** `src/extension/ipc.js:243-253`, `src/renderer/ipc-client.js:255-265`.
- **Por que importa:** Um peer malicioso ou bugado pode mandar uma linha enorme sem newline, fazendo `read_line_async` buferizar indefinidamente antes de `JSON.parse` explodir. Para o lado da extensão (que roda no pid `gnome-shell`), isso é perigoso: basta o renderer ficar louco e a shell inteira trava. `.kiro/specs/code-hygiene-fixes/requirements.md` já registrou isso como Requisito 12, mas não foi implementado.
- **Pergunta:** Qual o limite aceitável (2MB como sugerido no requirements.md)? Queremos fechar a conexão e reconectar, ou só droppar a linha?
- **Finding:**

### Q12. `GlBridge.send` tem queue de 120 mas frame payload pode engasgar resize/preset-change

- **Onde:** `src/renderer/gl-bridge.js:565-606`.
- **Por que importa:** Quando o queue enche, `send` tenta dropar o frame mais antigo. Mas se o último item mais antigo não for `frame` e sim `preset-change`/`resize`, a lógica drops esse `preset-change`/`resize` silenciosamente com um warn genérico ("dropping oldest control message"). Isso pode causar o helper a nunca receber um `preset-change` em um cenário de carga.
- **Pergunta:** Deveríamos (a) nunca dropar control messages, deixando-os sempre por último, ou (b) ter filas separadas (`_controlQueue` e `_frameQueue`)?
- **Finding:**

### Q13. `_onRendererExit` incrementa `_crashTimestamps` mesmo em shutdown limpo

- **Onde:** `src/extension/monitor.js:869-893`.
- **Por que importa:** Quando o renderer sai com código != 0 **e** `_stopping` era falso, chamamos `_onExit` → `_onRendererExit`. Esse método sempre registra um crash timestamp, mesmo se a saída foi um OOM kill, um `SIGTERM` externo, o usuário fechou a janela via `xkill`, etc. O contador de "5 crashes em 30s" pode ser disparado por razões não relacionadas ao preset atual, e aí a extensão para de tentar spawnar renderer até o próximo `enable()`.
- **Pergunta:** Devemos diferenciar `status == 0 && !stopping` (exit inesperado mas limpo) de `status != 0` (crash real)? Só contar como crash se o helper reportou `helper-crashed` via IPC?
- **Finding:**

### Q14. `_handleHelperCrashed` só reage em `_probeActive`

- **Onde:** `src/extension/monitor.js:1270-1275`.
- **Por que importa:** Se o helper crashar **depois** que um preset foi commitado (fora da janela de probe), `_handleHelperCrashed` simplesmente ignora a mensagem. O renderer vai reportar `helper-crashed` → o extensão só loga → nenhuma quarentena é registrada → o preset que acabou de crashar o helper continua elegível na próxima rotação.
- **Pergunta:** Deveríamos marcar o preset atual em quarentena mesmo quando `_probeActive === false`, usando `_currentPreset.id`? Há um motivo pelo qual o fix atual só cobre a janela do probe?
- **Finding:**

### Q15. `parseRendererWindowTitle` aceita JSON com qualquer conteúdo sem limite

- **Onde:** `src/extension/windowTitle.js`, usado em `src/extension/monitor.js:164-181`.
- **Por que importa:** O título da janela do renderer carrega um blob JSON `{state}|monitorIdx`. `JSON.parse` é chamado sem limite de tamanho. Mais importante: **qualquer outro app** que crie uma janela com título começando por `@io.github.mauriciobc.MilkdropRenderer!` e payload JSON válido é tratado como "uma das nossas janelas" pelo `_isRendererWindow` → entra na rota de `hide_from_window_list`, pode ser ocultada de alt-tab, etc. Baixa superfície de ataque, mas é facilmente spoofável localmente.
- **Pergunta:** Devemos corroborar com `Meta.WaylandClient.owns_window(window)` antes de aceitar uma janela como renderer (já existe esse caminho, mas `_isRendererWindow` tem um OR com title-only)? Ou o risco é baixo e OK manter?
- **Finding:**

### Q16. `monitor.js:_handleWindowMapped` captura `window` em `_managedWindows` sem garantir unicidade por processo

- **Onde:** `src/extension/monitor.js:1717-1750`.
- **Por que importa:** O mapa `_managedWindows` é indexado por `metaWindow`, não por `(rendererProcess, metaWindow)`. Se um renderer reabrir (ex.: wait_async disparou mas ainda não chegou `unmanaged`), o mesmo `process` pode ter `windowManaged=true` enquanto um novo mapping inicia. Pode deixar dangling.
- **Pergunta:** É seguro remover o `window` do mapa assim que o `unmanagedId` dispara dentro de `_clearManagedWindow`? A entrada "defer via GLib.idle_add" é o suficiente? Consegue revisar?
- **Finding:**

### Q17. `renderer.js:_isMain` usa `imports.system.programPath` sem fallback claro para GJS 1.86+

- **Onde:** `src/renderer/renderer.js:33-60`, `560-575`.
- **Por que importa:** `import.meta.main` foi removido no GJS 1.86 (GNOME 49). O código tenta usar `_isExecutedAsMain` que compara `import.meta.url` canonicalizado com `imports.system.programPath`. Em alguns cenários `programPath` pode ser `null` (por exemplo `gjs -m -c '...'`), e o match cai silenciosamente em `false`, então o app **não inicia**. `.kiro/specs/code-hygiene-fixes/requirements.md` Req 11 menciona esse problema.
- **Pergunta:** O caminho atual é robusto o suficiente para 47/48/49? Tem teste manual documentado? Devemos adicionar um flag explícito `--run` para não depender dessa detecção?
- **Finding:**

### Q18. `preset-loader-process.js` enumera recursivamente sem limite de profundidade ou tamanho

- **Onde:** `src/extension/preset-loader-process.js:18-54`.
- **Por que importa:** Se o usuário apontar `preset-directory` para `$HOME` ou `/tmp`, o subprocess vai descer recursivamente enumerando cada `.milk` encontrado. Não há cap no número de arquivos, profundidade de diretório ou tamanho de arquivo individual. `_readText` carrega o arquivo inteiro em memória. Poderia travar em edge-cases (symlink loops, `.milk` de 500MB).
- **Pergunta:** Adicionar `MAX_FILES=1000` + `MAX_DEPTH=8` + `MAX_SIZE=2MB` por preset? O subprocess de qualquer jeito está isolado do `gnome-shell`, mas ele ainda pode travar sozinho e bloquear `loadIndex()`.
- **Finding:**

### Q19. `validatePresetExpressions` joga fora o motivo do erro

- **Onde:** `src/extension/presets.js:178-212`.
- **Por que importa:** Um preset que falha a validação sai do índice silenciosamente (um `debug` log sem o erro). Usuários que editam `.milk` e percebem que "um preset sumiu" não tem como debugar sem ativar logs muito detalhados. O `.milk` é basicamente um ativo que o usuário cuida.
- **Pergunta:** Logar em `warn` com a mensagem do `catch` (ex.: "Unexpected token type ASSIGN at pos 42 — skipping `preset-foo.milk`")? É barulhento se o usuário tem 1k presets, mas só dispara no startup ou em reload.
- **Finding:**

### Q20. `GnomeShellOverride.setMediaOverlayVisibility` ignora erros silenciosamente em loop

- **Onde:** `src/extension/gnomeShellOverride.js:30-43`.
- **Por que importa:** Para cada `LiveWallpaper` no `_wallpaperActors`, é chamado `actor.ease` dentro de um `try{}catch(_e){}` vazio. Se o compositor mudou as assinaturas ou o actor foi finalizado, o loop continua. Sem debug log, não temos rastro. Confirmar o comportamento: errors aqui deveriam sinalizar um mismatch de versão de shell.
- **Pergunta:** Adicionar `_logger.debug` dentro do catch para facilitar triagem quando o overlay não fade-in/out?
- **Finding:**

### Q21. `Gst.parse_launch` com input do usuário — escape é parcial

- **Onde:** `src/extension/audio.js:29-32` (`escapePipeline`), `:283-315` (`_buildCandidates`).
- **Por que importa:** `audio-source` é uma string livre. `escapePipeline` escapa apenas `\` e `"`. A string é embutida em `pulsesrc device="${escaped}"`. GStreamer interpreta aspas, então payloads como `foo";fakesrc is-live=true name="bar` viram `device="foo\";fakesrc is-live=true name=\"bar"` — ok, fica como string única. Mas essa é uma whitelist por tentativa; outras variações (`\x` sequências, newlines) não são cobertas.
- **Pergunta:** É aceitável confiar no `parse_launch` + escape? Ou queremos montar o pipeline via API programática (`Gst.ElementFactory.make`) para não ter que escapar nada?
- **Finding:**

---

## 2. Architecture

### Q22. Duas cópias do evaluator (shell JS e projectM C++) produzem risco de drift de paridade

- **Onde:** `src/extension/expr/` (JS), `gl-helper.c` (via libprojectM).
- **Por que importa:** Temos um evaluator puro-JS completo (lexer, parser, compiler, per-frame, per-pixel) **e** confiamos no projectM nativo do lado do helper. Hoje só o helper afeta pixels. O evaluator JS só existe para: (a) paridade/testes, (b) fallback quando helper indisponível, (c) possivelmente um renderer GJS-only no futuro. Isso significa que:
  - Manter paridade com projectM demanda esforço contínuo (docs/`parity-validation-progress.md`).
  - Qualquer bug no evaluator JS não afeta usuários, mas gera tempo de dev.
- **Pergunta:** Qual é a estratégia? (a) manter como ferramenta de paridade (tests e goldens), (b) tornar o evaluator JS o autoritativo e remover projectM, (c) remover o evaluator JS e parar de perseguir paridade?
- **Finding:**

### Q23. `monitor.js` é uma god-class de 1874 linhas

- **Onde:** `src/extension/monitor.js`.
- **Por que importa:** Tem pelo menos 9 responsabilidades misturadas: `ManagedRendererWindow`, `RendererProcess`, `MonitorManager`, probe policy, crash quarantine glue, D-Bus export, visibility policy, MPRIS bridge, frame pump, helper launch. Qualquer mudança força ler muito contexto. Já existem arquivos dedicados (`preset-crash-quarantine.js`, `preset-probe-policy.js`) — podemos continuar extraindo.
- **Pergunta:** Aprovado dividir em: `monitor/manager.js`, `monitor/renderer-process.js`, `monitor/managed-window.js`, `monitor/visibility.js`, `monitor/probe.js`, `monitor/dbus.js`?
- **Finding:**

### Q24. `gl-bridge.js` tem 1110 linhas misturando transporte SHM, watchdog, writer queue e PerfCollector

- **Onde:** `src/renderer/gl-bridge.js`.
- **Por que importa:** Três preocupações independentes vivem no mesmo objeto: (i) controlar o processo C helper (spawn, stdout, watchdog, restart), (ii) transporte SHM via FD passing, (iii) back-pressure / writer queue. `PerfCollector` já está bem isolado como classe exportada, mas as demais estão entrelaçadas.
- **Pergunta:** Aprovado dividir em `HelperProcess`, `ShmReceiver`, `HelperWriter`? Deixa o `GlBridge` como fachada.
- **Finding:**

### Q25. Duplicação de `_hasSettingKey`/`_getStringSetting`/...

- **Onde:** `src/extension/monitor.js:1863-1872`, `src/extension/audio.js:580-605`, `src/extension/presets.js:452-473`.
- **Por que importa:** O mesmo padrão de acesso a `Gio.Settings` com schema check é copiado em três lugares (já mencionado em `BACKLOG.md` e `.kiro/specs/.../requirements.md` Req 3). Qualquer mudança em como tratamos chaves ausentes precisa ser aplicada três vezes.
- **Pergunta:** Aprovado criar `src/extension/settings-accessor.js` com uma fábrica (`const s = createSettingsAccessor(gioSettings)`; `s.getBoolean(key, fallback)`)? Ou a preferência é keyword arguments?
- **Finding:**

### Q26. `RENDER_CONTROL_DEFAULTS` só existe em `evaluator.js` (removeu duplicata no renderer?)

- **Onde:** `src/extension/evaluator.js:6-54`. `.kiro/specs/code-hygiene-fixes/requirements.md` Req 2 diz que existia uma duplicata em `gl-bridge.js`.
- **Por que importa:** Confirmei que hoje a duplicata em `gl-bridge.js` não existe. Ótimo. Mas o requirement fala em "shared defaults" — é seguro considerar esse item resolvido, ou tem algum outro ponto do renderer que ainda copia defaults?
- **Pergunta:** Você confirma que o Req 2 foi concluído e podemos fechar? Se sim, o `RENDER_CONTROL_DEFAULTS` só é lido pelo evaluator e é basicamente dead-output (ver Q5).
- **Finding:**

### Q27. `_windowRefreshActive` ainda é variável de módulo (Req 8 pendente)

- **Onde:** `src/extension/monitor.js:65-72`, `:187-196`.
- **Por que importa:** Flag global no escopo do módulo. Se dois `MonitorManager` coexistirem (teste, multi-instância), dividem a mesma flag. A resposta anterior (Q38) marcou como `partial`. Esta é a janela para promover para property de instância.
- **Pergunta:** Aprovado mover para `ManagedRendererWindow#_refreshActive` (com referência passada para `MonitorManager._handleWindowMapped` verificar)? Ou para `MonitorManager#_windowRefreshActive`?
- **Finding:**

### Q28. IPC não tem enum de `type` compartilhado — risco de typo silencioso

- **Onde:** `src/shared/ipc-protocol.js` só tem versão. Os strings `'frame'`, `'preset-load'`, `'frame-stat'`, `'helper-ready'`, `'helper-crashed'`, `'telemetry'`, `'shader_error'`, `'set-text-overlay-visible'`, `'ready'`, `'shutdown'` vivem em literal strings espalhados.
- **Pergunta:** Aprovado expor `MessageType = Object.freeze({FRAME: 'frame', PRESET_LOAD: 'preset-load', ...})` em `src/shared/ipc-protocol.js` e mudar todos os call sites? Zero custo de runtime, pega typos no parse inicial.
- **Finding:**

### Q29. Protocol version check é só warn, não desconecta

- **Onde:** `src/extension/ipc.js:255-263`, `src/renderer/ipc-client.js:267-279`.
- **Por que importa:** Se o renderer usar protocolo v99 vs server v2, só um `warn` é emitido e a comunicação continua. Não há política clara para "protocolo não suportado → fechar conexão e não retry".
- **Pergunta:** Queremos política estrita de versionamento (rejeita e não reconecta) ou best-effort (log e tenta)? A baseline é que extensão e renderer são co-instalados.
- **Finding:**

### Q30. Preset ID é `file:${absolutePath}` — expõe path em IPC, D-Bus, window title e quarentena persistida

- **Onde:** `src/extension/presets.js:76-78` (clone), `preset-loader-process.js:73` (id), `src/extension/frame-state.js:25-26` (`presetPath` em IPC).
- **Por que importa:** Path absoluto vaza `/home/<user>` no D-Bus (`GetWindowStatus`), no log, e no title da janela. Além disso, se o usuário renomeia/move o diretório, o crash-quarantine perde o rastro.
- **Pergunta:** Migrar para ID content-hashed (`file-sha256:...`) com um mapa lateral `path → id`? Ou ID baseado em `path` relativo à `preset-directory`? (`file:<relpath>`)
- **Finding:**

### Q31. `RendererProcess` tem 3 estratégias de launch mas só uma rota de "owns_window"

- **Onde:** `src/extension/monitor.js:340-364`.
- **Por que importa:** Em `wayland-launcher-spawnv` e `x11-launcher-spawnv`, `this._waylandClient` é `null`, e `ownsWindow()` sempre retorna `false`. O matching cai no parser de title — OK hoje, mas esse fallback é silencioso. Um usuário em GNOME 47 pode estar usando o caminho `Meta.WaylandClient.new` + `spawnv` e não saber.
- **Pergunta:** Logar em startup qual launch path foi usado? Documentar quais GNOME versions → quais paths?
- **Finding:**

### Q32. `wallpaper.js` polla 1Hz por renderer actor até achar

- **Onde:** `src/extension/wallpaper.js:57-122`.
- **Por que importa:** Até o renderer aparecer, cada `LiveWallpaper` (um por `BackgroundActor`) faz `get_window_actors(false)` a cada 1s. Em setups com overview ou multi-monitor, pode chegar a dezenas de polls. Poderíamos escutar `map` no `global.window_manager` ou `window-added` no workspace e reagir só quando um título casar com `RENDERER_TITLE_PREFIX`.
- **Pergunta:** Aprovado substituir o poll por event-driven?
- **Finding:**

### Q33. Dependência dura em APIs privadas do GNOME Shell

- **Onde:** `src/extension/gnomeShellOverride.js` (6 overrides via `InjectionManager`).
- **Por que importa:** `_createBackgroundActor`, `_isOverviewWindow`, `_updateWorkspacesViews`, `_updateBackgrounds` são todos privados. O alvo é GNOME 47/48/49; qualquer refactor upstream quebra. O código tem guards parciais mas não tem matriz de suporte documentada.
- **Pergunta:** Devemos documentar em `docs/architecture.md` exatamente quais overrides são feitos, em quais versões foram testados, e qual o plano de fallback caso uma das APIs suma em 50+?
- **Finding:**

---

## 3. Performance

### Q34. Frame pump `GLib.PRIORITY_DEFAULT` bloqueia main loop do Shell

- **Onde:** `src/extension/monitor.js:974`.
- **Por que importa:** A pump de frame + evaluator + IPC serialize + socket write roda na prioridade default da main loop do `gnome-shell`. Um preset lento de evaluator (ou serialização grande de PCM) pode atrasar input handling do GNOME. Já existe aviso `SLOW_FRAME_THRESHOLD_US=50ms`, mas só loga — não throttling, não skip.
- **Pergunta:** Estratégias possíveis: (a) `PRIORITY_DEFAULT_IDLE` para desacoplar, (b) coallescer frame pump se o anterior não foi entregue, (c) pump em thread separada (requer workers, GJS limita). Qual delas está na mesa?
- **Finding:**

### Q35. `snapshotAudioForFrame` re-aloca objeto a cada frame

- **Onde:** `src/extension/frame-state.js:5-18`.
- **Por que importa:** A cada frame (60fps × monitor count) criamos um novo objeto com 10 campos. Não é custoso por si só, mas acumula com o resto do hot path. Em multi-monitor o custo multiplica.
- **Pergunta:** Vale pool / reuso? Ou a alocação é insignificante comparado ao `JSON.stringify` de PCM?
- **Finding:**

### Q36. PCM sai do evaluator como JSON de 1152 números (10KB+) por frame

- **Onde:** `src/extension/ipc.js:138` (stringify), `src/renderer/gl-bridge.js:360-378` (também stringify pro helper).
- **Por que importa:** A 60fps: ~1.2MB/s de texto JSON entre shell e renderer, e mais 1.2MB/s entre renderer e helper. `JSON.parse` do lado receptor também não é barato. `.kiro/specs/.../requirements.md` Req 10 propõe Base64 ou binary channel. Hoje o gargalo é parsing JSON do helper em C com `json-glib`.
- **Pergunta:** Estratégia preferida: (a) Base64 de `Float32Array.buffer` (simples), (b) SHM separado para PCM (complexo, requer outro canal), (c) reduzir sample count (576 → 128), (d) omitir PCM quando o helper já tem o suficiente da última janela? Ver Q1 também — pode ser que consertar só a serialização já resolva.
- **Finding:**

### Q37. `ExpressionEvaluator.loadPreset` aloca 1MB `Float64Array` (megabuf) a cada preset change

- **Onde:** `src/extension/expr/context.js:218-220` (fill zero no `_megabuf`), `src/extension/expr/compiler.js:22-23` (aloca 1048576 doubles no execute).
- **Por que importa:** Trocar preset (rotação) causa `_ctx.resetForNewPreset()` que zera 1MB de `Float64Array`. `gmegabuf` é preservado. Em rotações a cada 15s + blend 2s, não é problema grave. Mas somado à Q5 (evaluator roda sem efeito), é overhead puro.
- **Pergunta:** Se mantivermos o evaluator do lado shell, vale deixar a alocação preguiçosa (só aloca se o preset usa `megabuf`)? Ou aceitar o custo?
- **Finding:**

### Q38. `compile()` cria uma closure por nó de AST

- **Onde:** `src/extension/expr/compiler.js`.
- **Por que importa:** Um preset com 500 equações e ASTs profundas gera milhares de closures aninhadas. Avaliar uma expressão complexa faz cascata de chamadas de função JS. Possivelmente lento comparado a um bytecode inline. Os benchmarks (`tests/bench/evaluator.bench.js`) existem; podemos medir.
- **Pergunta:** Vale explorar a compilação para bytecode array (`ops[i]` + switch) ou está rápido o bastante? É ortogonal à Q5 (se evaluator não é crítico, ignoremos).
- **Finding:**

### Q39. `forceGc()` a cada 100ms no renderer

- **Onde:** `src/renderer/gl-bridge.js:9-17`, `:974-985`.
- **Por que importa:** Chamar `imports.system.gc()` a cada 100ms é pesado — um GC síncrono pode pausar o loop. O objetivo é promover coleta do `GLib.Bytes` de 230KB. Se a pressão de C-heap não for visível para SpiderMonkey, o `gc()` forçado é necessário. Mas 10 GCs/s é agressivo.
- **Pergunta:** Experimentamos intervalos maiores (500ms, 1s)? Ou uma heurística baseada em número de frames acumulados? Há perf comparativo?
- **Finding:**

### Q40. `Gdk.MemoryTexture.new` a cada frame-pixels

- **Onde:** `src/renderer/glarea.js:197-237`.
- **Por que importa:** Cada frame cria uma nova textura de `bytes` (230KB+). O código explicitamente anula a anterior antes para ajudar GC (comentário na linha 226-227). Ainda assim, é 60 alocações/s de textura GDK. Em hardware com GL compartilhado pode estressar driver.
- **Pergunta:** Vale investigar textura "estática" atualizada via upload? Não sei se GDK4 expõe texture-update. Estado atual é aceitável?
- **Finding:**

### Q41. `reload` via `gl-bridge.js` re-cria SHM socket listener a cada start

- **Onde:** `src/renderer/gl-bridge.js:420-477`.
- **Por que importa:** A cada restart do helper (crash, watchdog), criamos novo socket path, novo `Gio.SocketListener`, nova conexão. OK para cenários raros. Se o watchdog dispara muito (helper instável), é churn desnecessário.
- **Pergunta:** Reutilizar o listener? Não vale a complexidade?
- **Finding:**

---

## 4. Code Structure & Dead Code

### Q42. `PerPixelEvaluator` é export público mas não tem consumidor em runtime

- **Onde:** `src/extension/expr/per-pixel.js` (classe), `meson.build:55` (é instalado), só usado em `tests/extension/expr/per-pixel.test.js`.
- **Por que importa:** Mesma história de Q5: projectM cuida de per-pixel. O evaluator JS existe só para paridade/testes.
- **Pergunta:** Confirmar se deve continuar no build em runtime ou mover para `tests/extension/expr/fixtures/`. Impacta `meson.build`.
- **Finding:**

### Q43. `pixel_eqs` parseado e compilado, mas nunca enviado ao helper

- **Onde:** `src/extension/milk-parser.js:218`, `src/extension/presets.js:188` (validação), `src/extension/monitor.js:493-496` (queuePresetLoad envia `pixel_eqs` no `preset-load`).
- **Por que importa:** A pipeline encaminha `pixel_eqs` ao renderer via `preset-load`. O renderer não usa (o helper só quer `presetPath`). `validatePresetExpressions` compila mais uma vez para checar sintaxe. Se projectM é autoritativo, bastaria mandar o caminho.
- **Pergunta:** Dropar `pixel_eqs`/`init_eqs`/`frame_eqs`/`customWaves`/`customShapes` do payload IPC de `preset-load`? Manter só `{id, name, source, path}`? Reduz payload.
- **Finding:**

### Q44. `evaluator.js:_blendExprMotion` muta `ctx` inline

- **Onde:** `src/extension/evaluator.js:186-217`.
- **Por que importa:** Depois de calcular `zoom/rot/dx/dy/decay` blended, o método sobrescreve `ctx.zoom/rot/...` para que um hipotético per-pixel evaluator veja os valores interpolados. Como não usamos per-pixel no shell (Q42), esses writes são sem efeito visível, mas deixam `ctx` em estado "híbrido" que futuros consumidores podem achar confuso.
- **Pergunta:** Remover a mutação? Ou manter porque um dia usaremos per-pixel no fallback?
- **Finding:**

### Q45. `monitor.js` ainda tem `_spawnRetryId` com lógica de retry 500ms quando `monitors.length === 0`

- **Onde:** `src/extension/monitor.js:927-937`.
- **Por que importa:** Retry polling de "quando vai aparecer um monitor". `Main.layoutManager` já emite `monitors-changed`. Deveríamos confiar no sinal em vez de retry.
- **Pergunta:** Remover o retry? Ou tem cenário onde `monitors-changed` não dispara (ex.: monitors-at-enable-time)?
- **Finding:**

### Q46. `waveData` já foi removido (Q52 do ciclo anterior) mas o nome sobreviveu em docs

- **Onde:** grep por `waveData` retorna só em `QUESTIONS.md` (este arquivo) e em `.kiro/specs/.../requirements.md`.
- **Por que importa:** Documentação histórica referencia campos que não existem mais. Pode confundir colaboradores.
- **Pergunta:** Atualizar `docs/architecture.md` e `CLAUDE.md` para remover menções a `spectrum`, `waveData`, `energy/bass/mid/treb` (já que audio atualmente só entrega PCM)? Ver Q4 antes.
- **Finding:**

### Q47. `tests/run-parity.js` e golden-frames dependem de libprojectM checked-out ao lado

- **Onde:** `CLAUDE.md:121-125`, `docs/projectm-parity.md`.
- **Por que importa:** Paridade só roda se o dev tiver `projectm/` clonado na raiz. CI não tem isso. Resulta em suite "verde" mas cobrindo muito pouco.
- **Pergunta:** Manter opt-in (como hoje) ou adicionar um Docker/container reproducível para rodar em CI? Já existe `.github/workflows/test.yml` com `meson test`.
- **Finding:**

### Q48. `tests/run.js` importa todos os módulos de teste em ordem fixa

- **Onde:** `tests/run.js:46-68`.
- **Por que importa:** Nenhum filtro, nenhum paralelismo, nenhum timeout. Se um teste trava, toda a suite trava. Se um teste vaza estado de módulo (ex.: Q27 `_windowRefreshActive`), contamina os seguintes.
- **Pergunta:** Aprovado adicionar `--filter <pattern>` + `--fail-fast` + reset de sinais GLib entre módulos? Ou é "mais tarde"?
- **Finding:**

### Q49. `tests/bench/run.js` roda benchmarks sem thresholds

- **Onde:** `tests/bench/run.js`.
- **Por que importa:** O CI roda `gjs -m tests/bench/run.js` e logo em seguida passa. Não há linha de base, não há regressão bloqueante. O script `tests/bench/check-regression.js` existe mas não está conectado ao CI workflow.
- **Pergunta:** Plugar `check-regression.js` no `.github/workflows/test.yml` com baseline `tests/bench/baseline.json`? Risco: variância de hardware em runners compartilhados.
- **Finding:**

### Q50. `tests/visual-expr.js` (10KB) — entrypoint não usado no runner

- **Onde:** `tests/visual-expr.js`, exposto via `just visual-expr`.
- **Por que importa:** É um utilitário de debug manual? Não participa de `run.js` nem `run-parity.js`. Tá documentado em algum lugar?
- **Pergunta:** Mover para `tools/`? Ou documentar que é um visualizer manual?
- **Finding:**

---

## 5. Security

### Q51. Subprocesso `preset-loader-process.js` corre com permissão total do usuário

- **Onde:** `src/extension/presets.js:425-451`.
- **Por que importa:** Spawna `gjs -m preset-loader-process.js <dirPath>`. O subprocess tem acesso total ao filesystem do usuário. Isso é deliberado para isolar parsing do `gnome-shell`, mas um `.milk` malicioso poderia acionar bugs do parser JS — afetando o subprocess, não o shell. OK para o objetivo. Mas não temos `setrlimit` nem `nice`/`ionice`, então um loop infinito no parser trava o `communicate_utf8_async` até você desabilitar.
- **Pergunta:** Adicionar timeout em `communicate_utf8_async` (matar subprocess após, p.ex., 10s)?
- **Finding:**

### Q52. `gl-helper.c` roda projectM e carrega shaders de disco sem sandbox

- **Onde:** `src/renderer/gl-helper.c:651-662`.
- **Por que importa:** `projectm_load_preset_file` lê `.milk` e compila GLSL. A superfície de ataque é projectM; estamos terceirizando isso. Mas o helper roda com permissão do usuário (sem seccomp, sem landlock). Preset malicioso poderia explorar bug em projectM para escalar.
- **Pergunta:** Alvo é aceitar o risco padrão (usuário escolheu o diretório)? Ou planos futuros para rodar o helper em bwrap/flatpak sandbox?
- **Finding:**

### Q53. D-Bus name é adquirido no session bus sem políticas restritas

- **Onde:** `src/extension/monitor.js:1636-1650`.
- **Por que importa:** Qualquer processo na sessão pode chamar `GetWindowStatus`. Não expomos métodos de escrita, mas a resposta inclui títulos de janela (que codificam posição/tamanho) e contadores internos. Isso é contornável com `hide_from_window_list`, mas ainda assim é ativo.
- **Pergunta:** Devemos ter um arquivo de policy XML limitando `GetWindowStatus` a um grupo específico? Baseline é que session bus já é "trusted", mas uma defesa em profundidade ajuda.
- **Finding:**

### Q54. `frame-state` em IPC contém `presetPath` (absoluto) — mesmo ponto de Q30

- **Onde:** `src/extension/frame-state.js:24-30`.
- **Por que importa:** Todo frame leva `presetPath` no JSON, então qualquer coisa que logue o stream vaza paths. Como é um socket Unix com permissão user-only, risco é baixo. Só menciono como data-point para Q30.
- **Pergunta:** Mandamos `presetPath` apenas no `preset-load` (control message) em vez de em todo frame? O helper pode lembrar o path.
- **Finding:**

---

## 6. Observability & UX

### Q55. `MILKDROP_DEBUG_IPC=1` logs a 1Hz no `warn`, poluem journal

- **Onde:** vários `_logger.warn?.(...)` em `src/extension/ipc.js`, `gl-bridge.js`, `monitor.js`.
- **Por que importa:** `docs/development.md` explica que `info` não aparece sem `G_MESSAGES_DEBUG=GNOME Shell`, então o projeto escolheu `warn` para mensagens de ciclo de vida. Mas isso poluiu o journal em produção (`milkdrop audio bus: add_watch attached`, etc.). Um usuário comum vendo `journalctl` nunca distingue o que é warning real do que é lifecycle.
- **Pergunta:** Abraçar `info` + documentar `G_MESSAGES_DEBUG='milkdrop'` (via `GLib.log_structured` com domain fixo) para quem quer debug? Ou manter `warn` e adicionar filtros?
- **Finding:**

### Q56. Sem backpressure notification para o usuário

- **Onde:** `src/extension/ipc.js:145-148`, `src/renderer/gl-bridge.js:572-598`.
- **Por que importa:** Drops de frame são só logados; usuário nunca é notificado que o sistema está apertado. Em laptops com baterias, isso seria um sinal útil ("extensão dropando 60% dos frames — desligar?").
- **Pergunta:** Contador de drops + notificação após N drops em M segundos? Ou "deferred"?
- **Finding:**

### Q57. Sysprof marks não têm verificação end-to-end

- **Onde:** `src/extension/perf.js`, `src/renderer/gl-helper.c` (`PERF_BEGIN/END`).
- **Por que importa:** `Q17` do ciclo anterior identificou que não temos validação automatizada de que os marks chegam no Sysprof.
- **Pergunta:** Algum plano para um `tools/capture-sysprof.sh` que tira uma amostra pequena e verifica presença dos marks esperados? Ou deixamos como "dev debug only"?
- **Finding:**

### Q58. `frame-stat` do helper não é agregada/exportada pelo D-Bus

- **Onde:** `src/renderer/gl-bridge.js:50-133` (PerfCollector coleta), mas só acessível via `getPerfStats()` no renderer.
- **Por que importa:** `getPerfStats()` é ilha. Não vai via IPC para a extensão, não aparece em `GetWindowStatus`, não é logada periodicamente. Usuários não têm como saber se estão rodando a 60fps ou 30fps.
- **Pergunta:** Adicionar campos `HelperRenderMs`, `HelperReadbackMs`, `HelperFps` ao `GetWindowStatus`? Custo: IPC periódico do renderer pra extensão (uma vez por segundo).
- **Finding:**

### Q59. Notification cooldown por chave é granular, mas sem "summary" ao fim

- **Onde:** `src/extension/audio.js:573-578`, `src/extension/monitor.js:819-825`.
- **Por que importa:** O usuário só vê a **primeira** notificação de um tipo. Se o problema ressurge 11s depois, não tem update. Nada crítico, só DX.
- **Pergunta:** Queremos notification "atualizável" com contador? `isTransient: false` + `source.addNotification` de novo já faz isso?
- **Finding:**

---

## 7. Tests & Tooling

### Q60. `meson.build` instala `expr_sources` em dois lugares (duplicata)

- **Onde:** `meson.build:113-114`.
- **Por que importa:**
  ```
  install_data(expr_sources, install_dir: join_paths(extension_dir, 'expr'))
  install_data(expr_sources, install_dir: join_paths(extension_dir, 'extension', 'expr'))
  ```
  Os arquivos são instalados duas vezes: `~/.local/share/gnome-shell/extensions/<uuid>/expr/` e `<uuid>/extension/expr/`. Um dos dois caminhos é o "certo". O código da extensão importa `from './expr/compiler.js'` relativo a `src/extension/*` — então esperaria `<uuid>/expr/...` via symlink `shared -> ../shared`. Confundi-me no mapeamento.
- **Pergunta:** Qual dos dois destinos é realmente necessário? Remover o outro?
- **Finding:**

### Q61. `src/extension/shared -> ../shared` symlink no source tree

- **Onde:** `ls src/extension/` mostra `shared -> ../shared`.
- **Por que importa:** Permite ao extension importar `./shared/ipc-protocol.js`. Mas só funciona se o sistema de arquivos/empacotamento segue symlinks, e `install_data` não copia symlinks — ele copia `src/shared/ipc-protocol.js` explicitamente para `<uuid>/shared/` (linha 104-107). OK em runtime. Mas o symlink no source é frágil (git preserva, mas é uma pegadinha em Windows ou tarballs).
- **Pergunta:** Poderíamos usar `../shared/ipc-protocol.js` diretamente nos imports e remover o symlink? Ou manter (é mais limpo)?
- **Finding:**

### Q62. `metadata.json.in` não tem campo `version` obrigatório para gnome-extensions.gnome.org

- **Onde:** `src/extension/metadata.json.in`.
- **Por que importa:** O `version` não está no template. `meson.build` tem `version: '0.1.0'` mas não é injetado no `metadata.json`. Se um dia submeter para extensions.gnome.org, a review rejeita.
- **Pergunta:** Adicionar `"version": @version@` + `metadata_conf.set('version', meson.project_version())`? Ou ainda não é prioridade (local install only per `docs/development.md`)?
- **Finding:**

### Q63. Não há lint nem formatter configurado

- **Onde:** `.vscode/`, `.gitignore`, ausência de `.eslintrc*` / `prettier` / `.editorconfig`.
- **Por que importa:** Projeto em JS puro sem gardrails. PR reviewer vira o linter.
- **Pergunta:** `BACKLOG.md` já menciona "Add ESLint Configuration". Aprovado adicionar ESLint + `eslint-config-gnome` ou preset custom para GJS? Rules mínimas: no-var, prefer-const, no-unused-vars, semi.
- **Finding:**

### Q64. Sem type annotations (JSDoc ou TypeScript `.d.ts`)

- **Onde:** todo o código JS.
- **Por que importa:** Algumas funções já têm JSDoc (`expr/compiler.js:16`), outras não. Editores sem type ajuda são mais propensos a erros como o da Q3 (duas props quase-iguais `_appsink` vs `_appSink`).
- **Pergunta:** Adotar JSDoc extensivo em módulos-chave + `//@ts-check` em `.js`? Ou full TypeScript (requer build step)?
- **Finding:**

---

## 8. Edge Cases & Subtle Behaviors

### Q65. `Gst.init(null)` chamado lazy por pipeline — thread safety?

- **Onde:** `src/extension/audio.js:22-27`.
- **Por que importa:** `ensureGstInit` é chamada de `_startPipeline`. Se `enable()` for chamado de duas threads (não é o caso hoje em GJS), `gstInitialized` sem mutex poderia inicializar duas vezes.
- **Pergunta:** Confirmar que GJS main loop é single-thread em `gnome-shell` (sim, é) e encerrar como `verified`.
- **Finding:**

### Q66. `_stopPipeline` não faz `set_state(NULL)` **antes** de `_detachBus`

- **Onde:** `src/extension/audio.js:206-219`.
- **Por que importa:** Ordem atual: `stopAppsinkPoll` → `detachBus` → clearSources → `pipeline.set_state(NULL)`. O contrato GStreamer é desanexar bus **depois** de `set_state(NULL)`, senão mensagens pendentes do state change podem ser perdidas ou disparar após callback removido.
- **Pergunta:** Inverter para `pipeline.set_state(NULL)` → `detachBus`?
- **Finding:**

### Q67. `_readPcm` assume stride fixo de ch*bps, sem padding

- **Onde:** `src/extension/audio.js:486-494`.
- **Por que importa:** `const count = (map.size / (bps * ch)) | 0;` — assume que os samples vêm "empacotados". GStreamer pode usar layouts planar (`GST_AUDIO_LAYOUT_NON_INTERLEAVED`) via `audioconvert`. Não verificamos `layout`. Se por algum motivo chegar planar (improvável depois de `audioconvert` para interleaved), corrompe.
- **Pergunta:** Adicionar check `layout === 'interleaved'`?
- **Finding:**

### Q68. `wallpaper.js` destroy handler depende do idle callback e guarda `try{}catch{}` no JS disposed

- **Onde:** `src/extension/wallpaper.js:80-103`.
- **Por que importa:** Já tem comentário explicativo longo sobre `already disposed`. O design é defensivo. Mas o padrão de `try{... try{...} catch{} }` aninhado é difícil de ler. Uma função `safeAccess(cb)` centralizaria.
- **Pergunta:** Extrair helper? Ou manter como está porque já foi testado em campo?
- **Finding:**

### Q69. `LiveWallpaper` não reage a mudança de monitor do renderer

- **Onde:** `src/extension/wallpaper.js:123-131`.
- **Por que importa:** `_getRenderer` compara `meta_window.get_monitor()` com `this._monitorIndex`. Se o renderer migrar para outro monitor (hot-plug), o clone fica órfão. OK para o design atual (uma renderer por monitor), mas não expresso.
- **Pergunta:** Documentar invariante? Ou adicionar reaction a `workspace-changed` / `monitor-changed`?
- **Finding:**

### Q70. `MprisWatcher` trata `NameOwnerChanged` mesmo quando não está habilitado

- **Onde:** `src/extension/mpris-watcher.js:108-136`.
- **Por que importa:** O signal está subscrito em `enable()` e des-subscrito em `disable()`. Tudo ok. Mas se `_addPlayer` dispara entre `disable()` intermediário (callback async), o guard `if (!this._enabled)` em `_addPlayer` dentro do callback do `MprisPlayerProxy` (linha 197) devia pegar. Tem que ser validado.
- **Pergunta:** Confirma que há teste para `disable()` no meio de `_addPlayer`? Se não, vale adicionar.
- **Finding:**

### Q71. `monitor.js:_applyPreset` não limpa `_helperPresetEnabled` ao trocar de `file` → null

- **Onde:** `src/extension/monitor.js:1432-1453`.
- **Por que importa:** Se `presetForHelper` é null, `_helperPresetEnabled = (null?.source === 'file')` → false. OK. Mas se `preset.source === 'builtin'` (bootstrap), `_helperPresetEnabled = false`. Certo. Esse campo só vira true com `source === 'file'`. Consistente com `attachPresetPathForHelper`. 
- **Pergunta:** Só confirmação mesmo: posso fechar como `verified`?
- **Finding:**

### Q72. `_scheduleRestart` em `_onRendererExit` não respeita `_probeActive` explicitamente

- **Onde:** `src/extension/monitor.js:869-892`.
- **Por que importa:** Chamamos `_rollbackProbe` antes de agendar restart — a quarantine é atualizada. Mas o `_scheduleRestart` não tem guard "se estou no meio de um probe, não spawne agora". Parece OK porque `_rollbackProbe` desliga `_probeActive`. Mesmo assim, vale exercício: o `setTimeout` de 150ms + outro `monitors-changed` pode encavalar.
- **Pergunta:** Me mostre que caminho eu preocuparia sem motivo, ou vale um teste cobrindo "dupla entrada em _restartAll"?
- **Finding:**

### Q73. `RendererProcess.queuePresetLoad` clona o objeto preset em linhas 482-497

- **Onde:** `src/extension/monitor.js:482-500`.
- **Por que importa:** Cópia rasa + campos explícitos para "preservar expression payload". Por que não usar spread `{...preset}`? Se algum campo novo for adicionado ao preset (ex.: `baseVals2`), o clone aqui esquece. Risco manutenção.
- **Pergunta:** Trocar para `{...preset}`? Ou motivo técnico para a lista explícita?
- **Finding:**

### Q74. `buildManagedWindowTitle` embute `size`, `position`, `keepAtBottom`, `keepMinimized`, `keepPosition` no título

- **Onde:** `src/renderer/renderer.js:18-31`.
- **Por que importa:** Desses, `monitor` é o único realmente necessário para matching. Os outros viajam por alguma razão histórica? `ManagedRendererWindow` lê `position`, `keepMinimized`, `keepAtBottom`, `keepPosition`, `desktopType`. `desktopType` nem é setado no renderer. A simetria não é limpa.
- **Pergunta:** Consolidar o que vai no título — só `monitor` + `position` (para posicionamento inicial pelo shell)? Os outros flags são defaults fixos.
- **Finding:**

### Q75. `GJS` e `Gst.parse_launch` falham silenciosamente com pipeline inválido em alguns cenários

- **Onde:** `src/extension/audio.js:157-194`.
- **Por que importa:** Se `parse_launch` falha (pipeline mal formado), o `try` pega e registra `candidate failed`. OK. Mas se `set_state(PLAYING)` retorna `ASYNC` e depois o bus reporta erro, o pipeline já é considerado "started" nesse momento, `return`, e a falha vem depois pelo bus handler — que chama `_scheduleRestart`. Em cenários de race (o bus falha antes do handler estar anexado), podemos ficar com um pipeline zombie.
- **Pergunta:** Movi `attachBus` para **antes** de `set_state(PLAYING)`? Hoje é depois (linha 188).
- **Finding:**

---

## 9. Documentation Drift

### Q76. `CLAUDE.md` lista `MILKDROP_DEBUG_BEAT=1` mas nenhuma referência existe no código

- **Onde:** `CLAUDE.md:41`, grep por `MILKDROP_DEBUG_BEAT` retorna vazio.
- **Por que importa:** Documentação promete flag de debug que nunca existiu (ou foi removida). Frustra quem tenta usar.
- **Pergunta:** Adicionar a implementação em `audio.js` ou remover da doc?
- **Finding:**

### Q77. `CLAUDE.md` descreve "projectM-compatible shaders in gl-helper.c" e overlay programs

- **Onde:** `CLAUDE.md:89-96`.
- **Por que importa:** Texto fala em dois shader programs, attribute layout `aPosition/aColor/aUV`, "projectM-compatible shaders in gl-helper.c". O `gl-helper.c` atual **não compila** shaders customizados — delega tudo para `projectm_opengl_render_frame_fbo`. Nada de `overlay_untextured_program`/`overlay_textured_program` existe.
- **Pergunta:** Re-escrever essa seção do CLAUDE.md para refletir o estado atual (projectM embutido, sem overlays custom no helper)?
- **Finding:**

### Q78. `CLAUDE.md` fala em `preset resilience (journal-backed)` e outros safeguards

- **Onde:** `CLAUDE.md:25-35`.
- **Por que importa:** Menciona "journal-backed" quarentena, mas a quarentena é session-only (ver `preset-crash-quarantine.js` e Q22 do ciclo anterior). "Journal-backed" sugere persistência, que não temos.
- **Pergunta:** Atualizar frase para "session-only memory map" ou implementar persistência?
- **Finding:**

### Q79. `README.md` declara "dual evaluator path" e "preset custom shapes evaluator"

- **Onde:** `README.md:18-28`.
- **Por que importa:** "Legacy WaveSpec preset evaluation" foi removido (`BACKLOG.md` item 8 - Done). "custom shapes evaluator" também está morto (Q42, Q43). README desatualizado confunde contribuidores.
- **Pergunta:** Reescrever a seção "Implementado e funcionando" para refletir a realidade atual?
- **Finding:**

### Q80. `docs/architecture.md` descreve IPC contracts sem os types atualmente usados

- **Onde:** `docs/architecture.md:64-79`.
- **Por que importa:** Menciona `type=frame`, `preset-load`, `set-text-overlay-visible`, `ready`, `helper-ready`, `frame-stat`, `telemetry`, `shader_error`, `helper-crashed`. Bate com o código, mas omite `shutdown` (usado pelo renderer para receber fim). Não é erro grave.
- **Pergunta:** Completar a lista e padronizar com `src/shared/ipc-protocol.js` (se Q28 aprovar enum)?
- **Finding:**

---

## 10. Build, Distribution & Lifecycle

### Q81. Binário `milkdrop-gl-helper` é symlink no source tree

- **Onde:** `src/renderer/milkdrop-gl-helper -> ../../build/milkdrop-gl-helper`.
- **Por que importa:** No tarball distribuído (via `install_data`), o binário está em `<extension_dir>/renderer/milkdrop-gl-helper` via `executable()` + `install_dir`. O symlink no source é só para facilitar `just renderer` standalone. OK, mas pode confundir (o symlink quebra antes do primeiro `meson compile`).
- **Pergunta:** Documentar? Adicionar ao `.gitignore` (se não está)?
- **Finding:**

### Q82. `tools/install.sh`, `tools/reload.sh`, `tools/watch.sh` não foram inspecionados

- **Onde:** `tools/*.sh`.
- **Pergunta:** Quer que eu revise esses scripts num próximo ciclo?
- **Finding:**

### Q83. Sem CI job verificando o build do helper nativo

- **Onde:** `.github/workflows/test.yml:9-29`.
- **Por que importa:** CI roda `meson setup build` + `meson test -C build unit-tests` + `gjs -m tests/bench/run.js` + `gjs -m tests/run-parity.js`. Não roda `meson compile -C build` explicitamente. Sem isso, um bug em `gl-helper.c` não quebra CI até alguém rodar local.
- **Pergunta:** Adicionar `meson compile -C build` como step obrigatório? Instalar `libprojectM-4-dev`, `libepoxy-dev`, etc.?
- **Finding:**

### Q84. `meson.build` marca `projectm_dep = dependency('projectM-4', required: true)` só dentro do `has_c_compiler` block

- **Onde:** `meson.build:65-101`.
- **Por que importa:** Se o projeto for compilado sem compilador C (`has_c_compiler=false`), nunca checa projectM — e instala sem helper. Uma mensagem é emitida, mas não é óbvia. Em ambientes de empacotamento (Flatpak, nixpkgs), tentar pular `has_c_compiler` gera extensão sem helper silenciosamente.
- **Pergunta:** Adicionar um `summary()` meson dizendo "gl-helper: will be built/skipped" para visibilidade? Um `error()` se `required_helper: true` opção?
- **Finding:**

### Q85. Não há `.gitattributes` para normalizar EOLs em `.milk` / GLSL

- **Onde:** ausência.
- **Por que importa:** Presets `.milk` vindos de Windows têm CRLF. `milk-parser.js` faz `split('\n')` e o `\r` residual pode aparecer em strings. Menor impacto, mas gera caos em contribuição cross-platform.
- **Pergunta:** Adicionar `.gitattributes` com `*.milk text eol=lf` e fazer `milk-parser` strip `\r`?
- **Finding:**

---

## 11. Miscellaneous

### Q86. `AGENTS.md` contém `Workspace Rules` — alinhado com o CLAUDE.md em alguns pontos, mas não em outros

- **Onde:** `AGENTS.md`, `CLAUDE.md`.
- **Por que importa:** Divergência pode causar agent confusion.
- **Pergunta:** Unificar em um único "contributor guide" em `docs/` e deixar CLAUDE.md/AGENTS.md como wrappers apontando pra ele?
- **Finding:**

### Q87. `BACKLOG.md` reporta "Pending Items" sobrepostos com itens "fixed" do ciclo anterior de QUESTIONS.md

- **Onde:** `BACKLOG.md`, `QUESTIONS.md` antigo (substituído por este).
- **Por que importa:** O BACKLOG diz que `getBootstrapPreset` retorna null (linha 94-99), mas o QUESTIONS.md antigo e o código atual mostram que retorna `clonePreset(BOOTSTRAP_PRESET)`. BACKLOG desatualizado.
- **Pergunta:** Arquivar/atualizar o BACKLOG? Ou deixá-lo como snapshot de um ciclo antigo?
- **Finding:**

### Q88. `REFACTOR_CHECKLIST.md` é o "contrato de refactor" mas não é aplicado via CI

- **Onde:** `REFACTOR_CHECKLIST.md`.
- **Por que importa:** Obrigações como "não mudar contratos IPC/D-Bus/GSettings" são policy humana. Não existe teste que detecte se alguém remove `GetWindowStatus` ou renomeia um campo.
- **Pergunta:** Gerar teste de smoke que chama `GetWindowStatus` e valida os keys esperados? Contract-test para a lista de GSettings keys (tá em `settings-contract.test.js`, OK).
- **Finding:**

### Q89. `ZERO_THRESHOLD` vs `EPSILON` no evaluator — valores diferentes, uso inconsistente

- **Onde:** `src/extension/expr/functions.js:1-3`, `src/extension/expr/compiler.js:83-92`.
- **Por que importa:** `EPSILON = 0.00001` é usado em `==`/`!=` (comparação fuzzy). `ZERO_THRESHOLD = 1e-6` é usado em `&`/`|`/`!`/`bnot`/`bor`/`band`/`if`. Então `0.0005 == 0.0005` é true (EPSILON), mas `0.0005 & 1` também é true (ZERO_THRESHOLD). Esses thresholds precisam ser iguais? projectM original usa um único threshold para tudo (~1e-5).
- **Pergunta:** Consolidar para um único threshold (`1e-5`, matching projectM)?
- **Finding:**

### Q90. `context.js:applyBaseVals` tem ordem estranha (primeiro zera, depois aplica)

- **Onde:** `src/extension/expr/context.js:109-122`.
- **Por que importa:** Já apontado como Q55 do ciclo anterior (marcado `approved` — "suboptimal ordering but not harmful"). Volto aqui porque o código ainda está assim. Vale a correção trivial: `this._baseVals = {...RW_DEFAULTS}` uma vez, depois loop sobre `vals`.
- **Pergunta:** Aplicar essa limpeza?
- **Finding:**

### Q91. `FrameContext._baseVals` é recriado com `{...RW_DEFAULTS}` em `applyBaseVals`?

- **Onde:** `src/extension/expr/context.js:112-114`.
- **Por que importa:** Na verdade não é; o loop sobrescreve chave a chave. `applyBaseVals` pode ser chamado várias vezes — cada vez limpa e reaplica. OK, só observação.
- **Pergunta:** Irrelevante se Q90 for aplicado.
- **Finding:**

### Q92. `milk-parser.js` guarda `currentSection` mas só o usa para `name`

- **Onde:** `src/extension/milk-parser.js:15-27`.
- **Por que importa:** O parser tenta detectar secções `[preset01]`. Se múltiplas, só a última manda pra `name`. MilkDrop só tem uma section por arquivo, mas não validamos isso. Um arquivo corrompido com duas secções `[presetA]` e `[presetB]` silenciosamente escolhe a última.
- **Pergunta:** Warn em múltiplas secções?
- **Finding:**

### Q93. Não há um único diagrama de fluxo de threads/loops

- **Onde:** `docs/architecture.md` tem um mermaid, mas só de data flow.
- **Por que importa:** Temos: main loop do gnome-shell (extensão), main loop do GTK4 (renderer), event loop do helper (blocking getline + GL ops). Cada sinal `map`, `monitors-changed`, MPRIS properties change, D-Bus calls, GLib.idle_add, GLib.timeout_add atravessa alguma dessas loops. Não tem um mapa.
- **Pergunta:** Adicionar um `docs/loops-and-threads.md` como referência?
- **Finding:**

### Q94. `perf.js` chama `GLib.log_structured` mas log domain é `'milkdrop-perf'` sem prefixo de extensão

- **Onde:** `src/extension/perf.js:33`.
- **Por que importa:** Outros logs usam `'[GNOME Milkdrop]'` como prefixo. `perf.js` usa domain `milkdrop-perf`. Não é ruim, mas é inconsistente.
- **Pergunta:** Padronizar?
- **Finding:**

### Q95. `expr/compiler.js:safeNum` e `expr/functions.js:safe` são a mesma função

- **Onde:** `src/extension/expr/compiler.js:31-33`, `src/extension/expr/functions.js:5-7`.
- **Por que importa:** Duplicação trivial. Ambas garantem "finite number or 0". Podiam vir de `expr/utils.js`.
- **Pergunta:** Consolidar em helper compartilhado?
- **Finding:**

---

## 12. Meta / Process

### Q96. O `QUESTIONS.md` anterior tinha 70 perguntas e foi fechado — este tem ~96 novas

- **Por que importa:** Se formos iterar nesse formato, o arquivo cresce indefinidamente. Um ciclo A → responde → aplica → um novo `QUESTIONS.md` vazio → ciclo B. Preservar o histórico em `docs/reviews/questions-YYYY-MM-DD.md`.
- **Pergunta:** Concorda? Este passa a ser `questions-2026-04-16.md` quando fechado?
- **Finding:**

### Q97. Review tooling

- **Pergunta:** Você quer que eu implemente fixes conforme as respostas chegam, ou que eu faça um PR separado por categoria (bugs críticos → arquitetura → cleanup)?
- **Finding:**

---

## Suggested answer tags (recap)

- `intended` — comportamento deliberado.
- `bug` — é bug, corrigir. (inclua comportamento esperado se ajudar)
- `approved` — melhoria aprovada para este PR.
- `deferred` — adiar.
- `out-of-scope` — fora do escopo.
- `verified` — confirmado por inspeção.
- `needs-investigation` — preciso verificar antes de decidir.
- `skip` — passa por cima desta pergunta.
