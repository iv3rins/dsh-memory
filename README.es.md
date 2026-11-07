# dsh-project-memory

**Idiomas:** [English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · Español

Memoria de proyecto para [DeepSeek Harness](https://github.com/deepseek-ai): tus documentos, tu estado de desarrollo y átomos de memoria duraderos que sobreviven a reinicios y a la compactación del contexto. Un plugin cordis solo del lado del host, más un panel lateral.

```
MIT · Node 20+ · sin dependencias en tiempo de ejecución
```

## El problema

Un agente empieza cada sesión en blanco. Así que vuelves a explicar la estructura, vuelve a leer los mismos documentos, vuelve a tomar una decisión que cerraste la semana pasada y repite un error que ya cometió.

Dentro de una misma sesión lo mismo ocurre de forma más silenciosa. Cuando el contexto se alarga, el harness lo compacta: los turnos originales se sustituyen por un resumen. El contexto sigue siendo asequible, y todo lo que el resumen omitió se pierde para siempre.

Este plugin da al proyecto una memoria guardada **en el repositorio**, no en una ventana de contexto.

## Cómo funciona

Tres almacenes, porque lo que *escribiste*, lo que *estás haciendo* y lo que *decidiste* tienen vidas distintas:

| sistema | guarda | lo escribe | sobrevive a |
|---|---|---|---|
| **A — documentos** | tu Markdown | tú, en git | todo |
| **B — estado** | tarea, progreso, bloqueos, decisiones | `state_update` / `state_handoff` | reinicios, compactación |
| **C — átomos** | afirmaciones duraderas y breves | el observador de compactación, `memory_remember` | reinicios, compactación |

El interesante es **C**:

```
sesión larga ──▶ compactación ──▶ resumen con pérdida (lo que el modelo ve después)
                      │
                      └──▶ átomos breves ──▶ .dsh-memory/memory/atoms.jsonl
                                                    │
siguiente paso ──▶ selección dispersa para ESTA petición ──┘
                   └──▶ unos pocos átomos, dentro de un techo de tokens
```

Cuatro propiedades lo abaratan lo suficiente para ejecutarlo en cada paso:

1. **Disperso, no volcado.** Un puñado de átomos entre cientos, ordenados para *esta* petición. Un techo duro de tokens hace que el coste lo fije la configuración y no el tamaño del proyecto.
2. **Registrado, no recolectado.** El estado y los átomos los escriben llamadas a herramientas. Un agente que nunca llama a `state_update` no tiene memoria de estado: un fallo visible, no un error silencioso. La única excepción deliberada es el observador de compactación, que lee resúmenes de compactación: exactamente lo que el sistema C existe para rescatar.
3. **Las reglas pesan más que la relevancia.** Un átomo `constraint` es **permanente** (*standing*): se selecciona antes de cualquier puntuación y se conserva aunque la redacción de la petición no coincida. Una regla que solo se aplica cuando casualmente la mencionas no es una regla.
4. **La selección nunca escribe.** El subagente router opcional solo puede responder con ids que se le ofrecieron; un id inventado se descarta. La mutación queda en código determinista.

### Niveles del router

| `routerTier` | comportamiento | coste |
|---|---|---|
| `off` | solo puntuación determinista | gratis |
| `smart` (por defecto) | escala solo cuando la pasada determinista no halló nada relevante o coincidió débilmente | gratis hasta que haya proveedor **y** modelo |
| `always` | cada paso pregunta al router | una llamada por paso |

`smart` no cuesta nada de fábrica: necesita `routerProvider` y `routerModel`. `routerStrategy` (`task` / `compliance` / `orient`) cambia las instrucciones que recibe el router, así que dos perfiles con los mismos átomos pueden recuperar distinto.

### «Permanente» no es «peso»

El peso (1–5) es una entrada de **ordenación**; la permanencia es una entrada de **elegibilidad**, decidida por el tipo (`constraint`), nunca por el peso. Fusionarlos fue un fallo real: reglas auténticas guardadas con el peso por defecto perdían en silencio su condición de regla dura. Los átomos permanentes siguen sujetos a los topes de cantidad y de tokens: una cuota del presupuesto, no una exención.

## Instalación

```
git clone https://github.com/iv3rins/dsh-memory.git
```

El manifiesto declara `dsh.bundle`, así que un solo comando añade la dependencia **y** la entrada del bundle:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:D:\path\to\dsh-memory"
```

Reinicia el host y llama a `project_inspect`: una raíz de proyecto resuelta y un recuento de documentos indexados significan que está activo.

`engines.dsh` es `>=0.2.0-rc.0 <0.3.0`, deliberadamente estrecho: una versión menor del host puede cambiar el subconjunto de esquema de herramientas o la forma de los mensajes, y entonces este plugin fallaría al **montarse** en vez de al instalarse. Amplía el rango después de reejecutar la suite.

## Herramientas

Dieciocho herramientas. Empieza cualquier sesión desconocida con `memory_status`.

| Herramienta | Qué responde |
|---|---|
| `memory_status` | ¿Está inicializada? ¿Qué revisión? ¿Obsoleta respecto a git? ¿Cuántos átomos? |
| `memory_bootstrap` | Todo lo que necesita una sesión nueva, en una llamada con presupuesto. |
| `memory_search` | ¿Qué documentos hablan de esto? Ordenados, con filtros status/kind/path. |
| `memory_read` | Lee un documento, o una sección `##`, enmarcado como datos. |
| `memory_recall` | ¿Qué átomos guardados encajan con esta pregunta? Ordenados, con presupuesto y ruta. |
| `memory_intent` | Lo mismo, mediante una Task Intent estructurada (tarea, módulos, operación, categorías). |
| `memory_remember` | Guarda hechos, restricciones y decisiones duraderas. |
| `memory_forget` | Retira átomos por id; la lápida es pegajosa. |
| `memory_lifecycle` | Inspecciona y ajusta los niveles de los átomos (HOT / WARM / COLD). |
| `memory_metrics` | Llamadas al router, latencia, aciertos de caché, entregas frente a usos, coste en tokens. |
| `state_get` / `state_update` | Lee el estado; registra un cambio. Compare-and-set, los conflictos se informan. |
| `state_handoff` | Nota de fin de sesión para que la siguiente empiece orientada. |
| `project_init` / `project_inspect` | Crea `.dsh-memory/`; diagnóstico de solo lectura. |
| `docs_check` / `docs_sync` | Problemas de front-matter; propone un cambio de documento (nunca in situ). |
| `architecture_check` | Comprobación determinista de reglas de import contra `.dsh-memory/arch.json`. |

**Comandos:** `/memory-status`, `/memory-context`, `/memory-init`, `/memory-handoff`, `/memory-recall`, `/memory-route`, `/memory-forget`, `/memory-sync`, `/architecture-check`. `/memory-route` es un ensayo: muestra qué ruta tomaría el nivel actual y por qué, sin gastar una llamada al modelo.

**Panel lateral.** Una entrada en la barra lateral abre un panel sobre la pregunta que la gente realmente tiene: *¿la compactación conservó mi memoria?* Muestra la última compactación en una frase, una línea de tiempo de las recientes de más nueva a más antigua (las silenciosas atenuadas, no ocultas), recuentos de activos y olvidados, reglas duras permanentes y el desglose por tipo y peso. Los controles del router están plegados por defecto. No tiene ningún control que modifique la memoria: los átomos los escriben la compactación y herramientas que llevan procedencia, así que la eliminación sigue siendo `memory_forget`. Sus dos rutas (`/project-memory/status`, `/project-memory/config`) son solo de loopback.

**Inyección de contexto.** En el primer paso el plugin inyecta una línea base con presupuesto (identidad, hechos de git, tarea, invariantes, próximos pasos, bloqueos, decisiones, mapa de documentos) y la reenvía solo cuando cambia la identidad. Cada paso puede recibir además un bloque de recall, deduplicado contra la superficie visible de la sesión. Ambos llegan como mensajes propiedad del plugin dentro de una valla con nonce: el texto del proyecto es dato, nunca instrucción.

## Configuración

Todos los campos tienen un valor por defecto funcional; los valores inválidos se reparan, nunca son fatales.

| Campo | Defecto | Significado |
|---|---|---|
| `enabled` | `true` | Interruptor maestro. |
| `injectContext` / `injectRecall` | `true` | Inyecta la línea base / el recall por paso. |
| `l0Budget` / `l1Budget` / `l2Budget` | `300` / `1200` / `2000` | Tokens: línea base mínima, completa, una lectura. |
| `recallBudget` / `recallLimit` | `400` / `8` | Techo y número para un recall. |
| `routerTier` / `routerStrategy` | `smart` / `task` | Ver la tabla de niveles. |
| `routerProvider` / `routerModel` | `''` / `''` | El modelo del router. Vacío significa sin llamadas. |
| `routerTimeoutMs` / `routerDigestBudget` | `20000` / `900` | Límite de la llamada; techo de tokens del resumen que se le ofrece. |
| `extractOnCompaction` / `extractUserRules` | `true` | Extrae átomos de resúmenes y de reglas enunciadas. |
| `semanticRouting`, `lifecycleEnabled`, `taskIntentEnabled` | `false` | Capas opcionales; un flag de vuelta a `false` restaura el comportamiento anterior. |
| `protectedPaths` | `AGENTS.md`, `docs/decisions/`, `docs/adr/`, `.git/` | `docs_sync` nunca escribe ahí. |

Seis campos pueden sobrescribirse por proyecto — `routerTier`, `routerStrategy`, `routerProvider`, `routerModel`, `recallBudget`, `recallLimit` — en `.dsh-memory/settings/<project-key>.json`. El resto sigue siendo global a propósito: las rutas y los techos de escritura describen la instalación, no un repositorio.

## Almacenamiento

Todo vive bajo `.dsh-memory/`. Commitéalo para memoria compartida del equipo, o ignóralo para una privada: ambas opciones son coherentes.

```
.dsh-memory/
  project.json       projectId estable + hechos de git vistos por primera vez
  state/current.json el documento de estado (con recuento de revisión)
  state/journal.jsonl registro de solo anexado de escrituras aceptadas
  state/compactions.jsonl una fila por compactación observada, incluidas las silenciosas
  memory/atoms.jsonl átomos duraderos, un registro JSON por línea
  memory/metrics.json contadores de eventos acotados
  index.json         caché derivada — seguro de borrar
  settings/<key>.json sobrescrituras por proyecto
```

Los ids de los átomos son direccionados por contenido (hash del tipo y el texto normalizado), así que ver la misma afirmación dos veces refuerza un registro. `memory_forget` escribe una lápida en lugar de borrar la línea, así que una extracción posterior no puede resucitarla. Un archivo corrupto se renombra y se informa, no se sustituye en silencio.

## Qué está medido y qué no

**Medido** (`docs/design/benchmark-compaction-loss.md`): sobre 80 preguntas de un conjunto de datos real, un contexto con solo el resumen acertó un 16.3% y solo la cola cruda un 15.0%; resumen más recall de átomos, un 25.0%. Todos los intervalos de confianza cruzan cero, así que esto es una **dirección consistente, no un efecto establecido**.

**No medido**:

- **Precisión del router: cero.** El subagente router nunca se ha ejecutado contra un modelo real. Sus pruebas cubren timeout, aborto, respuestas malformadas e ids desconocidos con un delegado simulado; no se ha observado ningún spawn real produciendo una selección real. Su **tasa de disparo** en `smart` tampoco está medida: las reglas de escalado están en `decideRoute`, la frecuencia con que se disparan no tiene cifra.
- **Coste del escaneo completo.** `gateAtoms` puntúa cada átomo vivo en cada recall (`core/gate.js`). Medido aquí — almacén de 401 registros, esta máquina — un `readAtoms` cuesta ≈ 5.6 ms y un `gateAtoms` ≈ 9.4 ms; sobre átomos sintéticos uniformes la puerta crece
casi linealmente en ≈ 0.7 / 1.0 / 1.6 / 3.3 ms para 100 / 200 / 400 / 800 átomos. No
existe índice invertido. La selección de átomos permanentes es una **pasada** aparte, pero reutiliza el mismo escaneo, así que no es un canal de candidatos independiente.
- **Coste de parseo de `atoms.jsonl`.** Cada recall relee y reparsea el archivo completo (`lib/recall.js`); no hay caché de instantánea en proceso. Cualquier caché necesita invalidación entre procesos (otra sesión, otro proceso o `memory_forget` pueden reescribir el archivo), y por eso es un tema de diseño y no un parche.

La búsqueda es léxica, no semántica. El router degrada a selección determinista al agotarse el tiempo, así que su peor caso es perder una mejora, no romper el paso.

## Lo que no hará

- No modificará `AGENTS.md`, `docs/decisions/`, `docs/adr/` ni `.git/`. `docs_sync` rechaza esas rutas y nombra el rechazo.
- No hará commit, ramas ni push. Registra hechos de git; no ejecuta operaciones de git.
- No inventará estado en silencio. Toda escritura es compare-and-set; las escrituras concurrentes entran en conflicto en lugar de sobrescribirse.
- No reescribirá un documento autoritativo. Las propuestas van a `docs/proposals/`.

## Verificación

```powershell
npm run setup        # extrae y enlaza los paquetes del host (una vez, idempotente)
npm test             # 14 pruebas unitarias para la capa core/ pura
npm run test:host    # 28 comprobaciones encadenadas contra el harness real
```

La suite del host cubre los esquemas de herramientas que el harness impone, la inyección y la deduplicación, el bucle completo compactación → recall → olvido mediante eventos reales, la seguridad y el rechazo de rutas, la degradación elegante, la compatibilidad del manifiesto, el comportamiento HTTP del panel, los ajustes por proyecto y la mitad Cliente. Una comprobación omitida imprime `SKIP` y no demuestra nada.

**Una suite en verde no es una instalación funcionando.** La suite monta el plugin en un contexto cordis que el repositorio construye; solo arrancar el host demuestra que el perfil lo carga. Haz ambas cosas.

## Estructura

```
core/   Node puro, sin importar DSH — el núcleo comprobable
        memory.js  gate.js  state.js  retrieval.js  category.js  lifecycle.js
        extract.js  config.js  index.js  search.js  store.js  paths.js  ...
lib/    la capa cordis: index.js  tools.js  commands.js  panel.js  recall.js
        router.js  semantic.js  delegate.js  compaction-memory.js
client.js  el panel lateral (mitad Cliente)
tests/     unit/ (node --test) y comprobaciones *.mjs del host
docs/      notas de diseño y propuestas de documentos
```

`docs/design/system-c-memory-atoms.md` explica la capa de átomos en profundidad, incluidas las dos trampas encontradas probando en lugar de leyendo: un softmax sobre puntuaciones crudas colapsa a un solo experto, y ordenar solo por solapamiento descarta las restricciones duras justo cuando importan.

## Licencia

[MIT](./LICENSE) © 2026 iverins
