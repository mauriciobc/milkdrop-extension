# Paridade visual com projectM

O renderer agora usa **libprojectM** como backend padrão: a extensão envia PCM, tempo e o caminho do preset `.milk` para o `milkdrop-gl-helper`, que usa libprojectM para desenhar. A paridade visual com o projectM oficial depende de:

- Mesmo preset (arquivo `.milk`)
- Mesma fonte de áudio (ou mesmo arquivo PCM de teste)
- Mesma resolução e FPS (dentro do que o projectM usa internamente)

## Como validar paridade visual

1. **Requisitos**
   - Extensão compilada com `milkdrop-gl-helper` (libprojectM-4 instalada no sistema).
   - projectM SDL (frontend oficial) instalado para comparação, ou builds do repositório projectM em `projectm/`.

2. **Preset e áudio**
   - Escolha um preset `.milk` (por exemplo dos presets do projectM em `projectm/presets/tests/` ou de um pack).
   - Para comparação lado a lado: use a mesma fonte de áudio (ex.: saída do sistema ou um arquivo WAV) no projectM SDL e na extensão (fonte de áudio configurada nas preferências).

3. **Extensão**
   - Selecione o mesmo preset (diretório de presets apontando para a mesma pasta que o projectM, se aplicável).
   - Reproduza áudio e observe a visualização.

4. **Comparação**
   - Abra o projectM SDL com o mesmo preset e a mesma fonte de áudio.
   - Compare visualmente: formas, cores e reação ao beat devem ser muito próximas. Pequenas diferenças podem vir de FPS, tamanho de janela ou versão exata da libprojectM.

## Teste automatizado (helper path e payload)

O suite de testes unitários verifica que:

- O GlBridge usa o caminho do `milkdrop-gl-helper`.
- O payload de frame enviado ao helper inclui `presetPath` quando o frame state o contém.

Execute:

```bash
gjs -m tests/run.js
```

Os testes em `tests/renderer/gl-bridge.test.js` cobrem a escolha do helper e o envio de `presetPath`.

## Limitações

- Presets **built-in** (não arquivo) não têm `presetPath`; o projectM backend pode exibir o preset idle ou o último preset carregado até que um preset de arquivo seja selecionado.
- Texturas referenciadas nos presets devem estar acessíveis nos caminhos configurados (ex.: `--texture-path` para o helper ou diretórios de textura do projectM).
