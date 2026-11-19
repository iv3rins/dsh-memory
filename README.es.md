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
| **C — grupos de memoria** | átomos duraderos agrupados por tema | el observador de compactación, `memory_remember` | reinicios, compactación |

El interesante es **C**:

```
sesión larga ──▶ compactación ──▶ resumen con pérdida (lo que el modelo ve después)
                      │
                      └──▶ grupos de memoria ──▶ .dsh-memory/memory/atoms.jsonl
                                                    │
siguiente paso ──▶ grupos relacionados con la tarea ───────┘
                   └──▶ átomos candidatos dentro del presupuesto
```

Cuatro propiedades lo abaratan lo suficiente para ejecutarlo en cada paso:

1. **Primero los grupos.** La recuperación busca temas relacionados por vocabulario, etiquetas y rutas de archivo, y después selecciona átomos dentro del presupuesto de tokens.
2. **Registrado, no recolectado.** El estado y los átomos los escriben llamadas a herramientas. Un agente que nunca llama a `state_update` no tiene memoria de estado: un fallo visible, no un error silencioso. La única excepción deliberada es el observador de compactación, que lee resúmenes de compactación: exactamente lo que el sistema C existe para rescatar.
3. **La recuperación determinista reserva presupuesto para reglas permanentes.** Estas reglas pueden recuperarse aunque no coincidan las palabras. Con un modelo de enrutamiento configurado, el modelo de ejecución decide qué átomos propuestos puede recibir.
4. **La selección es de solo lectura.** El modelo de enrutamiento solo puede elegir los ID que recibe. El código determinista descarta los ID desconocidos y realiza las escrituras.

### Niveles del modelo de enrutamiento

| `routerTier` | comportamiento | coste |
|---|---|---|
| `off` | solo puntuación determinista | gratis |
| `smart` (por defecto) | escala solo cuando la pasada determinista no halló nada relevante o coincidió débilmente | gratis hasta que haya proveedor **y** modelo |
| `always` | cada recuperación elegible consulta al modelo de enrutamiento | hasta una llamada por consulta |

El modelo de enrutamiento de DSH exige `routerProvider` y `routerModel`. `routerStrategy` (`task` / `compliance` / `orient`) ajusta las instrucciones que recibe.

#### Revisar o afinar una propuesta de memoria

Con un modelo de enrutamiento configurado, el hook `agent/pre-step` puede ofrecer al modelo de ejecución los ID, tipos, grupos y archivos relacionados de los candidatos. El modelo de ejecución puede leer el proyecto actual y decidir qué memoria cargar. Las consultas explícitas con `memory_intent` utilizan el mismo flujo.

1. Consulta con `memory_intent({ task_summary: "Explicar cómo se guardan los ajustes", affected_modules: ["lib/panel.js"] })`.
2. Envía el `proposal_id` y `accept_memory_ids` a `memory_intent` para cargar solo el texto aprobado. Una lista vacía rechaza toda la propuesta.
3. Envía el `proposal_id` y `feedback` con evidencia del proyecto para solicitar otra propuesta. La consulta incorpora esa evidencia y excluye los ID ya rechazados. Repite la revisión según sea necesario.

El modelo de enrutamiento puede devolver un resultado vacío. Tanto una abstención como un fallo dejan la consulta sin texto recuperado. Sin un modelo configurado o con el enrutamiento desactivado, se usa la recuperación determinista.

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
| `memory_recall` | Búsqueda determinista de átomos relevantes en los grupos de memoria del proyecto. |
| `memory_intent` | Consulta memoria por tarea para aprobar, rechazar o afinar la propuesta. |
| `memory_remember` | Guarda hechos, restricciones y decisiones duraderas. |
| `memory_forget` | Retira átomos por id; la lápida es pegajosa. |
| `memory_lifecycle` | Inspecciona y ajusta los niveles de los átomos (HOT / WARM / COLD). |
| `memory_metrics` | Llamadas al modelo de enrutamiento, latencia, aciertos de caché, entregas frente a usos, coste en tokens. |
| `state_get` / `state_update` | Lee el estado; registra un cambio. Compare-and-set, los conflictos se informan. |
| `state_handoff` | Nota de fin de sesión para que la siguiente empiece orientada. |
| `project_init` / `project_inspect` | Crea `.dsh-memory/`; diagnóstico de solo lectura. |
| `docs_check` / `docs_sync` | Problemas de front-matter; propone un cambio de documento (nunca in situ). |
| `architecture_check` | Comprobación determinista de reglas de import contra `.dsh-memory/arch.json`. |

**Comandos:** `/memory-status`, `/memory-context`, `/memory-init`, `/memory-handoff`, `/memory-recall`, `/memory-route`, `/memory-forget`, `/memory-sync`, `/architecture-check`. `/memory-route` es un ensayo: muestra qué ruta tomaría el nivel actual y por qué, sin gastar una llamada al modelo.

**Panel lateral.** Muestra el resultado de las compactaciones recientes, los recuentos de memoria activa y olvidada, las reglas permanentes y la distribución de la memoria. Los controles del modelo de enrutamiento están plegados por defecto. Puedes retirar memoria con `memory_forget`. Las interfaces del panel solo están disponibles desde la dirección de bucle local.

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
| `routerProvider` / `routerModel` | `''` / `''` | Modelo de enrutamiento de DSH. |
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
  memory/atoms.jsonl un registro JSON por grupo activo o lápida
  memory/metrics.json contadores de eventos acotados
  index.json         caché derivada — seguro de borrar
  settings/<key>.json sobrescrituras por proyecto
```

El almacén lee los registros anteriores y los migra a grupos en la siguiente escritura que cambie su contenido. Conserva los ID, la procedencia, las reglas permanentes y las lápidas. Las observaciones repetidas refuerzan el mismo átomo. `memory_forget` escribe una lápida para impedir que se extraiga de nuevo.

## Qué está medido y qué no

**Medido** (`docs/design/benchmark-compaction-loss.md`): sobre 80 preguntas de un conjunto de datos real, un contexto con solo el resumen acertó un 16.3% y solo la cola cruda un 15.0%; resumen más recall de átomos, un 25.0%. Todos los intervalos de confianza cruzan cero, así que esto es una **dirección consistente, no un efecto establecido**.

**No medido**:

- **Precisión y frecuencia de las llamadas al modelo de enrutamiento.** Las pruebas usan un delegado simulado para comprobar los tiempos de espera, las cancelaciones, las respuestas no válidas y los ID desconocidos. La precisión de un modelo de enrutamiento de DSH real y la frecuencia de las llamadas en `smart` están pendientes de medición.
- **Rendimiento de la recuperación por grupos.** Cada consulta analiza `atoms.jsonl` y ordena los átomos de los grupos relacionados. Las mediciones anteriores corresponden al escaneo completo previo a la migración.

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
        memory.js  clusters.js  gate.js  state.js  retrieval.js  category.js  lifecycle.js
        extract.js  config.js  index.js  search.js  store.js  paths.js  ...
lib/    la capa cordis: index.js  tools.js  commands.js  panel.js  recall.js
        recall-review.js  router.js  semantic.js  delegate.js  compaction-memory.js
client.js  el panel lateral (mitad Cliente)
tests/     unit/ (node --test) y comprobaciones *.mjs del host
docs/      notas de diseño y propuestas de documentos
```

`docs/design/system-c-memory-atoms.md` explica la capa de átomos en profundidad, incluidas las dos trampas encontradas probando en lugar de leyendo: un softmax sobre puntuaciones crudas colapsa a un solo experto, y ordenar solo por solapamiento descarta las restricciones duras justo cuando importan.

## Licencia

[MIT](./LICENSE) © 2026 iverins
