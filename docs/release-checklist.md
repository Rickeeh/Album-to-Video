# Release Checklist — Album to Video (Deterministic Publisher)

## Princípios (não-negociáveis)

- O produto publica: não edita, não anima, não inventa.
- Render determinístico: mesmos inputs -> mesmos outputs.
- Cancelamento é real: mata processo + cleanup total.
- Logs são parte do produto (suporte e auditoria).

## 0) Pré-flight (antes de tudo)

- `git status` está limpo (sem mudanças locais).
- Branch correta.
- `node --check main.js && node --check preload.js` ✅

## 1) Gates automáticos (obrigatórios)

Executar:

- `npm test` ✅
- `npm run verify:win-bins` ✅ (Windows: presença + integridade + SHA256 pinado)
- `npm run dist:win` ✅ (gera instalador/portable Windows)
- `npm run release:win` ✅ (gera `dist` + `SHA256SUMS.txt`)
- `npm run dist:mac` ✅ (se aplicável)

`FAIL = parar. Não “tentar na sorte”.`

## 2) Evidência de build (obrigatória)

Guardar/colar no PR/Release Notes:

- Nome do artefacto e tamanho
- SHA256 do artefacto
- (Windows) listagem de:
  - `dist/win-unpacked/resources/bin/win32/ffmpeg.exe`
  - `dist/win-unpacked/resources/bin/win32/ffprobe.exe`
- SHA256 dos dois binários dentro do unpacked

## 3) Smoke test runtime (Windows/Parallels)

Abrir a app e verificar o session log (o próprio log diz o caminho):

- procurar `logger.ready` e abrir o ficheiro indicado. (O logger cria JSONL e roda sessões antigas automaticamente.)

Sinais vitais obrigatórios no topo do log:

- `engine.binaries`:
  - `FFMPEG_SOURCE = vendored`
  - `FFPROBE_SOURCE = vendored`
  - `FFMPEG_BIN = true`
  - `FFPROBE_BIN = true`
- `engine.startup_probe`:
  - `expectedWinFfmpegExists = true`
  - `expectedWinFfprobeExists = true`

## 4) Smoke test funcional (publish-grade)

Import

- Importar `.mp3` ✅
- Importar `.wav` ✅
- Não pode aparecer “unsupported format”.

Render mínimo

- Render de 1-2 faixas para um export folder limpo ✅
- Esperar por `render.success` no log ✅

## 5) Teste de cancelamento “implacável”

Durante um render:

- clicar `Cancel`
- no log tem de aparecer:
  - `cleanup.start reason=CANCELLED`
  - `cleanup.ffmpeg_killed` (ou equivalente)
  - `cleanup.end ... cleanupRemovedEmptyFolder=true`

Confirmar no filesystem:

- sem `.tmp` órfãos
- sem outputs parciais (ou removidos conforme política)

## 6) UX invariants (Apple rules)

- Não existe zoom acidental (teclas, wheel, pinch).
- UI não reflow/desalinha quando o export folder aparece.
- Presets são intenção editorial (sem opções técnicas na UI).

## 7) Arquivos e suporte

- O artefacto final + SHA256 ficam guardados.
- O `session-*.jsonl` de um run “PASS” fica guardado (1 exemplo por release).

## Atualização mínima no README.md (3 linhas)

Adicionar uma secção “Release” com:

- “Para fazer release, siga `docs/release-checklist.md`”
- “Windows requer bins vendorizados + `verify:win-bins`”
- “Logs por sessão em `%APPDATA%/.../logs/...` (ver `logger.ready`)”
