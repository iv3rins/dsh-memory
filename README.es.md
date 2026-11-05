# dsh-project-memory

**Idiomas:** [English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · Español


Conocimiento persistente a nivel de proyecto y memoria del estado de desarrollo para [DeepSeek Harness](https://github.com/deepseek-ai).

Un agente lo olvida todo cuando termina una sesión, cuando se compacta el contexto o cuando cambias de rama. Para un proyecto que sobrevive a decenas de sesiones, eso significa volver a deducir las mismas decisiones, releer los mismos documentos y repetir los mismos errores. Este plugin le da a un proyecto una memoria que vive **en el repositorio en lugar de en una ventana de contexto**.

Es un **plugin de [cordis](https://github.com/deepseek-ai/cordis) centrado en el host**: registra herramientas de agente, una sección del system prompt y comandos de barra. También incluye una pequeña **mitad de navegador**: un panel en la barra lateral que lee el host por dos rutas de loopback y no añade trabajo al host. No modifica DSH.

```
Licencia MIT · Node 20+ · plugin de host + un panel lateral
```

---

## Índice

- [Tres sistemas, a propósito](#tres-sistemas-a-propósito)
- [Lo que no hará](#lo-que-no-hará)
- [Instalación](#instalación)
- [Herramientas](#herramientas)
- [Estructura de almacenamiento](#estructura-de-almacenamiento)
- [Verificación](#verificación)
- [Configuración](#configuración)
- [Ajustes por proyecto](#ajustes-por-proyecto)
- [Estructura del proyecto](#estructura del proyecto)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Licencia](#licencia)

---


## Tres sistemas, a propósito

**Sistema A — conocimiento documental.** El Markdown del repositorio es la fuente de verdad. El plugin lo indexa, lo busca y lee secciones concretas. Nunca reescribe tus documentos autorizados; cuando propone un cambio, escribe en `docs/proposals/`.

**Sistema B — estado de desarrollo.** Tarea, progreso, bloqueos, decisiones, siguientes pasos, datos de git y notas de traspaso se persisten mediante una llamada a herramienta, así que sobreviven a un reinicio o a una compactación. **La llamada a la herramienta es lo que persiste.** Un agente que nunca llama a `state_update` no obtiene memoria de estado: el plugin no escarba en la conversación.

**Sistema C — átomos de memoria.** Registros durables y direccionables, extraídos de los resúmenes de compactación y de las reglas que el usuario declara explícitamente, y luego recordados **de forma selectiva** en la siguiente petición. Esta es la respuesta a la pérdida por compactación: un resumen de punto de control reemplaza los turnos originales, y todo lo que descarta desaparece. Los átomos le dan a ese contenido una segunda vida, fuera de la ventana de contexto, recuperable por relevancia en lugar de por la suerte de haber sobrevivido al resumen.

El recuerdo sigue un patrón de compuerta dispersa en vez de un volcado. La puntuación es determinista (solapamiento léxico, prioridad de tipo, refuerzo, recencia), la selección es dispersa (pocos átomos entre muchos, ordenados) y el coste está acotado (un techo de tokens que quien llama no puede exceder por accidente). Es el planteamiento de MemGPT —la ventana de contexto como memoria de trabajo, el almacén como el espacio de memoria mayor, intercambiados bajo demanda— expresado como una compuerta de mezcla de expertos: los tipos son expertos, los átomos compiten dentro de un experto, y el softmax decide qué expertos están activos para **esta** petición.

Un subagente puede actuar como enrutador cuando la puntuación léxica no basta. Tres niveles:

| `routerTier` | Comportamiento | Coste |
| --- | --- | --- |
| `off` | Solo compuerta determinista. | Gratis |
| `smart` (por defecto) | Compuerta determinista, escalando al enrutador solo cuando no seleccionó nada relevante o coincidió débilmente. | Casi gratis; una llamada solo cuando la ruta barata falló |
| `always` | Cada paso pregunta al subagente enrutador. | Una llamada por paso — úsalo con un modelo barato |

`smart` no cuesta nada hasta que `routerProvider` **y** `routerModel` estén ambos definidos, así que el plugin no gasta ninguna llamada al modelo recién instalado.

### Dos propiedades independientes

Un átomo tiene un **peso** (weight, 1–5: cuán importante es) y una marca de **permanencia** (standing: si es una regla que debe cumplirse). Son cosas distintas a propósito, y confundirlas fue un defecto real:

- el peso es una entrada de **ordenación**: un hecho de peso alto va antes que uno de peso bajo;
- la permanencia es una entrada de **elegibilidad**: una regla permanente se conserva **aunque no coincida con la petición actual**, porque una regla que solo se aplica cuando casualmente la mencionas no es una regla.

La permanencia la decide el tipo (`constraint`), nunca el peso. `STANDING_MIN_WEIGHT` era el criterio antiguo y está obsoleto: descartaba en silencio toda restricción guardada con peso 2, lo que en un almacén real significaba que 32 de 66 reglas duras quedaban inelegibles. Los átomos permanentes siguen sujetos a los topes de recuento y de tokens —es una cuota del presupuesto, no una excepción—, así que esto no es un muro de reglas; en un recuerdo real medido solo un átomo se conservó **únicamente** por permanencia y el resto coincidía de verdad.

El enrutador no puede anular esto. Los átomos permanentes se eligen **antes** de consultar al enrutador, y un enrutador que responde vacío, responde mal o agota el tiempo no los elimina. El enrutador decide qué **añadir**, nunca qué **quitar**.

## Lo que no hará

- No modificará `AGENTS.md`, `docs/decisions/`, `docs/adr/` ni `.git/`. `docs_sync` rechaza esas rutas y nombra el rechazo.
- No hará commit, branch ni push. Registra datos de git; no ejecuta operaciones de git.
- No inventará estado en silencio. Toda mutación pasa por `state_update` con una revisión de comparar-y-establecer, y las escrituras concurrentes entran en conflicto en vez de sobrescribirse.

---

## Instalación

Primero clona el repositorio:

```
git clone https://github.com/iv3rins/dsh-memory.git
```

Un comando. El host añade la dependencia **y** la entrada del bundle por sí mismo, porque el manifiesto declara `dsh.bundle` — `reconcileProfilePlugins()` promueve cualquier dependencia recién instalada que lo lleve.

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:D:\path\to\dsh-memory"
```

Reinicia el host después. Verifica con `project_inspect`: la raíz del proyecto y un recuento de documentos indexados significan que el plugin está vivo.

Editar el perfil a mano también funciona (una entrada en `dependencies` más una entrada en `dsh.profile.bundles`), pero es el camino lento y fácil de dejar a medias: una dependencia sin la entrada del bundle se instala y luego nunca carga.

pnpm avisa de que una dependencia `link:` no resuelve los peers desde el `node_modules` del destino. Eso es esperado e inofensivo aquí: este plugin no tiene dependencias en tiempo de ejecución, y su único peer (`@deepseek-ai/dsh-llm`) lo aporta el host.

El parche del bundle (`cordis.patch.yml`) inserta una fila:

```yaml
- insert:
    - id: project-memory
      name: '@dsh-external/dsh-project-memory'
```

Se puede dar configuración en esa fila si los valores por defecto no encajan:

```yaml
- insert:
    - id: project-memory
      name: '@dsh-external/dsh-project-memory'
      config:
        l0Budget: 300
        l1Budget: 1200
        registerCommands: true
        routerTier: smart
```

### Actualización

`engines.dsh` es `>=0.2.0-rc.0 <0.3.0`. Es deliberadamente estrecho en vez de abierto: una versión menor del host puede cambiar el subconjunto de esquemas de herramientas o la forma del mensaje inyectado, y entonces este plugin fallaría **en silencio al montar** en lugar de ruidosamente al instalar. El rango declara lo que realmente se ha probado (0.2.1-rc.2); ámplialo tras volver a ejecutar la suite contra un host más nuevo.

Cuando `engines.dsh` está presente, el host lee **solo** eso e ignora por completo los rangos de `peerDependencies` (`unmetRequirements` en `dsh-app-boot`). La entrada de peer se mantiene como declaración de lo que el paquete importa en tiempo de ejecución, no como una segunda compuerta.

`npm run test:host` comprueba esto directamente: `tests/compat.mjs` pasa el manifiesto real a la propia `evaluatePluginCompatibility` del host, así que el rango no puede desincronizarse del runtime sin que falle una prueba.

---

## Herramientas

Quince herramientas. `memory_status` es la primera que hay que llamar en cualquier sesión desconocida.

| Herramienta | Qué responde |
| --- | --- |
| `memory_bootstrap` | Todo lo que necesita una sesión nueva, en una llamada y dentro de un presupuesto de tokens. |
| `memory_status` | ¿Está inicializada la memoria? ¿Qué revisión? ¿Está desactualizada respecto a git? ¿Cuántos átomos? También puede reconstruir el índice. |
| `memory_search` | ¿Qué documentos hablan de esto? Ordenados, con filtros de estado/tipo/ruta. |
| `memory_read` | Lee un documento, o una sección `##` concreta, acotado y enmarcado como datos. |
| `memory_recall` | ¿Qué átomos guardados son relevantes para esta pregunta? Ordenados, con presupuesto, ruta y confianza. |
| `memory_remember` | Guarda hechos durables, restricciones y decisiones para que una sesión posterior pueda encontrarlos. |
| `memory_forget` | Retira átomos por id. La lápida es pegajosa: la reextracción no puede resucitarlos. |
| `state_get` | La tarea actual, el progreso, los bloqueos, las decisiones, los siguientes pasos. |
| `state_update` | Registra un cambio. Comparar-y-establecer; los conflictos se informan, no se sobrescriben. |
| `state_handoff` | Escribe una nota de fin de sesión para que la siguiente empiece orientada. |
| `project_init` | Crea `.dsh-memory/` para este proyecto. No se crea nada automáticamente. |
| `project_inspect` | Raíz, datos de git, presencia de memoria, estado del índice — diagnóstico de solo lectura. |
| `docs_check` | Problemas de front-matter y de estado en todo el conjunto de documentación. |
| `docs_sync` | Actualiza un documento o propone un cambio, rechazando rutas protegidas. |
| `architecture_check` | Comprobación determinista de reglas de import contra `.dsh-memory/arch.json`. |

### Comandos

`/memory-status`, `/memory-context`, `/memory-init`, `/memory-handoff`, `/memory-recall`, `/memory-route`, `/memory-forget`, `/memory-sync`, `/architecture-check`.

`/memory-route` es un simulacro: muestra qué ruta tomaría el nivel actual y por qué, **sin gastar** ninguna llamada al modelo.

### Panel de la barra lateral

El plugin añade una entrada a la barra lateral izquierda — **memoria del proyecto** — que abre un panel con:

- el número de átomos vigentes y olvidados, **cuántos son reglas duras permanentes**, y el desglose por tipo y por peso;
- el registro de compactaciones: cuántas se observaron, cuántas produjeron átomos y por qué el resto no produjo nada;
- el presupuesto y los límites de recuerdo actuales;
- los controles de enrutado: **cuándo** enrutar (`off` / `smart` / `always`), **qué priorizar** (`task` / `compliance` / `orient`), y el proveedor y el modelo.

La estrategia no es decoración: cada valor envía un conjunto distinto de instrucciones al modelo enrutador, así que los mismos átomos se ponderan de otra manera. `compliance` pide al enrutador que conserve las reglas que gobiernan los archivos en juego aunque su redacción parezca ajena a la petición; `task` pide que prefiera aquello que este paso está a punto de hacer; `orient` pide que prefiera cómo funciona el subsistema, para peticiones que buscan entender en lugar de actuar.

Guardar pasa por el `configEditor` del host, así que un cambio se aplica igual que cualquier otro cambio de configuración: no queda un YAML editado a mano que no surte efecto hasta reiniciar y que mientras tanto contradice la configuración en ejecución. Si un perfil no expone `configEditor`, el panel lo dice en lugar de informar de un guardado que no ocurrió.

El panel no tiene controles que modifiquen la memoria. Los átomos los escriben la compactación y las herramientas que llevan procedencia y respetan las lápidas; un botón del navegador que borrara uno saltaría ambos, así que la eliminación sigue siendo `memory_forget`.

Sus dos endpoints son solo de loopback. Revelan la memoria del proyecto y pueden cambiar el comportamiento del enrutado, así que una petición de otro host se rechaza en lugar de atenderse.

### Inyección de contexto

En el primer paso de una sesión, el plugin inyecta una línea base (identidad del proyecto, datos de git, tarea actual, invariantes, siguientes pasos, bloqueos, decisiones, mapa de documentos) que cabe en `l0Budget`/`l1Budget`. Solo la reenvía cuando cambia la identidad, y comprueba la superficie de la sesión antes de enviar, de modo que una sesión compactada o reanudada no reciba un duplicado. Un reenvío es una línea base; no se inyecta nada cuando nada cambió.

Cada paso puede recibir además un **bloque de recuerdo**: los átomos seleccionados para la petición de ese paso, con su tipo, procedencia y puntuación. Es un mensaje aparte con su propio tipo de origen, así que quien revise puede distinguir la línea base durable de una selección ordenada para ese paso. Se deduplica por **conjunto de átomos** contra la superficie de la sesión: repetir átomos que el modelo ya puede ver gastaría el presupuesto que este sistema existe para proteger, mientras que una selección **nueva** (o una eclipsada por la compactación) sí se envía.

La línea base llega como un **mensaje de usuario propiedad del plugin, dentro de una valla nonce**. El texto del proyecto es dato, nunca instrucción: los prefijos de rol se neutralizan, la frase "ignore previous instructions" se elimina, los caracteres invisibles y bidireccionales se quitan, y las vallas de código se cierran para que un documento no pueda escapar del marco. El mismo enmarcado se aplica a los átomos recordados.

---

## Estructura de almacenamiento

Todo vive bajo `.dsh-memory/` en la raíz del proyecto. Confirmarlo o ignorarlo: ambas opciones son coherentes. Confirmarlo da estado compartido al equipo; ignorarlo da uno privado a cada desarrollador.

```
.dsh-memory/
  project.json          projectId estable + datos de git vistos por primera vez
  state/
    current.json        el documento de estado (esquema 2, con revisiones)
    journal.jsonl       registro de solo-añadir de escrituras aceptadas
    compactions.jsonl   una fila por compactación observada, incluidas las silenciosas
    .lock               bloqueo de escritura de corta duración
  memory/
    atoms.jsonl         átomos durables, un registro JSON por línea
    .lock               bloqueo de escritura de corta duración
  index.json            caché derivada — seguro de borrar, se reconstruye bajo demanda
  arch.json             reglas de arquitectura opcionales
  settings/
    <project-key>.json  sobrescrituras por proyecto — solo existe para proyectos que tienen una
```

`atoms.jsonl` es de solo-añadir y direccionado por contenido: el id de un átomo es un hash de su tipo y su texto normalizado, así que ver la misma afirmación dos veces refuerza un registro en lugar de añadir una copia. `memory_forget` escribe una lápida en lugar de borrar la línea: el registro queda como evidencia, y la lápida es pegajosa para que una pasada de extracción posterior no pueda traerlo de vuelta.

`compactions.jsonl` es el registro operativo: una fila por cada compactación que este plugin presenció, **incluidas las que no produjeron átomos**, cada una con un `skipReason` de un conjunto cerrado (`empty-summary`, `no-extractable-statements`, `store-write-failed`, etc.). El almacén de átomos solo muestra éxitos, así que sin este archivo un extractor roto y un proyecto inactivo se ven iguales. `/memory-status` lo resume.

`index.json` es una caché. Si está mal o se borra, `memory_status` lo reconstruye. Un `current.json` corrupto se renombra a `current.json.corrupt-<marca de tiempo>` y se informa en el resultado en lugar de reemplazarse en silencio: el archivo dañado es evidencia.

> El `.dsh-memory/` de este repositorio está en gitignore: es la **salida** del plugin, no el plugin. Un equipo que quiera compartir memoria debe quitar el ignore en su propio proyecto.

---

## Verificación

```powershell
npm run setup        # extrae del app.asar instalado los paquetes del host y los enlaza
npm test             # 14 pruebas unitarias de la capa core/ pura (sin DSH)
npm run test:host    # quince comprobaciones a nivel de host contra el harness real
```

`npm run setup` es el requisito previo, de una sola vez (e idempotente), para `test:host`. Lee los paquetes del payload de escritorio instalado en lugar de usar `npm install`, así que las pruebas se ejecutan contra el host exacto en el que este plugin se cargará.

`npm run test:host` ejecuta, en orden:

| Comprobación | Qué demuestra |
| --- | --- |
| `smoke.mjs` | El grafo de módulos carga y exporta la forma de plugin de cordis. |
| `tools.mjs` | Todo esquema de herramienta es aceptado por el subconjunto de JSON Schema que el harness impone. |
| `cordis-semantics.mjs` | El comportamiento de resolución de servicios del que depende el plugin, medido en vez de asumido. |
| `inject.mjs` | Composición de la línea base, etiquetado de mensajes y deduplicación por superficie. |
| `safety.mjs` | Rutas protegidas rechazadas, originales idénticos byte a byte, traversal bloqueado, escrituras obsoletas en conflicto, pasajes enmarcados como datos. |
| `degrade.mjs` | Las 15 herramientas siguen registrándose y funcionando cuando faltan servicios opcionales. |
| `continuity.mjs` | Estado, decisiones, bloqueos y documentos sobreviven a un reinicio simulado; la obsolescencia sigue a un HEAD real en movimiento. |
| `root.mjs` | Descubrimiento de raíz: los subdirectorios comparten memoria, los directorios no relacionados no la heredan, git y la configuración mandan. |
| `compat.mjs` | La propia `evaluatePluginCompatibility` del host acepta este manifiesto y rechaza un rango insatisfacible. |
| `patch.mjs` | `cordis.patch.yml` resuelve a través de los `bundlePatchPaths` del propio host e inserta un plugin cargable. |
| `mount.mjs` | El plugin monta en un contexto cordis real con el `ToolRuntime` real, y se desmonta limpiamente. |
| `loop.mjs` | El bucle cerrado: un evento de compactación escribe átomos por el bus de eventos real, el siguiente paso los recuerda de forma dispersa, una repetición es idempotente, un duplicado no se reinyecta y un olvido se respeta. |
| `panel.mjs` | Los endpoints de la barra lateral sobre HTTP real: informan del mismo almacén y registro que leen las herramientas, escriben ajustes solo mediante el `configEditor` del host, rechazan un valor fuera del conjunto aceptado, rechazan a un par que no sea loopback y declaran una línea corrupta en lugar de informar de un almacén vacío. |
| `client.mjs` | La mitad de navegador: una entrada lateral y un panel principal **que le corresponde**, todas las cadenas presentes en ambos idiomas con los mismos marcadores, y rutas y opciones idénticas a las del host. |

`npm test` cubre contención de rutas, análisis de front-matter, derivación del índice, ordenación de búsqueda, enmarcado de guard, ajuste al presupuesto, comprobación de arquitectura, escrituras atómicas, bloqueo, fusión de estado y toda la capa de átomos (identidad, lápidas, la compuerta dispersa, niveles de ruta, extracción, el enrutador, el recuerdo y el observador de compactación).

Cada prueba de host necesita los paquetes extraídos y **se salta** (código de salida 0) cuando faltan. Un salto se imprime como `SKIP` y nunca cuenta como aprobado: si una ejecución muestra `SKIP`, no demuestra nada.

**Una suite en verde no es lo mismo que una instalación funcionando.** La suite monta el plugin en un contexto cordis que el repositorio construye; solo arrancar el host demuestra que el perfil realmente lo carga. Haz ambas cosas: `npm run test:all`, luego reinicia y llama a `project_inspect`.

---

## Configuración

Cada campo tiene un valor por defecto funcional. Los valores inválidos se reparan, no son fatales: un plugin de memoria no debería detener una sesión porque un archivo de configuración tenga una errata.

| Campo | Por defecto | Significado |
| --- | --- | --- |
| `enabled` | `true` | Interruptor maestro; `false` no registra nada. |
| `injectContext` | `true` | Inyecta la línea base en sesiones nuevas. |
| `announceToAgent` | `true` | Añade la sección de orientación al system prompt. |
| `registerCommands` | `true` | Registra los nueve comandos de barra. |
| `l0Budget` / `l1Budget` | `300` / `1200` | Presupuestos de tokens, línea base mínima y completa. |
| `l2Budget` | `2000` | Presupuesto de tokens para una lectura. |
| `maxDocuments` | `5000` | Tope de documentos indexados. |
| `gitTimeoutMs` | `4000` | Tiempo límite de sondeo de git; un git lento nunca bloquea un paso. |
| `includePrefixes` | `docs/`, `README.md`, … | Qué se indexa. |
| `excludePrefixes` | `.git/`, `node_modules/`, … | Qué nunca se indexa. |
| `protectedPaths` | `AGENTS.md`, `docs/decisions/`, … | Rutas que `docs_sync` rechaza. |
| `projectRoot` | cwd de la sesión | Sobrescribe la raíz detectada. |
| `extractOnCompaction` | `true` | Convierte un resumen de compactación en átomos. |
| `extractUserRules` | `true` | Cosecha las reglas que el usuario declara explícitamente. |
| `injectRecall` | `true` | Permite que un paso reciba un bloque de recuerdo. |
| `recallBudget` / `recallLimit` | `400` / `8` | Techo de tokens y número de átomos por recuerdo. |
| `routerTier` | `smart` | `off`, `smart` o `always`. Ver la tabla de niveles arriba. |
| `routerStrategy` | `task` | `task`, `compliance` u `orient`. Elige el conjunto de instrucciones que recibe el modelo enrutador. |
| `routerProvider` / `routerModel` | `''` / `''` | El modelo del enrutador. `smart` sigue siendo gratis hasta que ambos estén definidos. |
| `routerReasoningEffort` | `''` | Se pasa al modelo enrutador, cuando lo soporta. |
| `routerTimeoutMs` | `20000` | Cota de una llamada al enrutador. |
| `routerCooldownSteps` | `1` | Pasos a esperar antes de volver a enrutar la misma petición. |
| `routerDigestBudget` | `900` | Techo de tokens del resumen de átomos que recibe el enrutador. |

---

## Ajustes por proyecto

Un perfil es una sola configuración para todos los repositorios. Eso está mal para al menos un ajuste: el modelo de enrutador que sirve a un monorepo grande de TypeScript no es el que quieres revisando el recuerdo en un repositorio de notas, y pagar por un enrutador en un proyecto mientras se mantiene gratis en otro es una decisión por proyecto, no global.

Por eso seis campos se pueden sobrescribir por proyecto:

`routerTier`, `routerStrategy`, `routerProvider`, `routerModel`, `recallBudget`, `recallLimit`

Todo lo demás sigue siendo global a propósito. Las rutas, los presupuestos de la línea base, los interruptores de extracción y las rutas protegidas describen la instalación, no un repositorio; hacerlos por proyecto permitiría que un proyecto cambiara qué puede escribir el plugin.

**Cómo se guarda.** Una sobrescritura es un archivo pequeño dentro del proyecto:

```
<project>/.dsh-memory/settings/<project-key>.json
{ "schema": 1, "root": "<absolute project root>", "values": { "routerModel": "deepseek-reasoner" } }
```

La clave es la ruta absoluta con los separadores y el dos puntos de la unidad convertidos en guiones, así que en un host insensible a mayúsculas `D:\x\proj` y `D:/x/proj/` son el mismo proyecto. Cada paso resuelve `effectiveSettings(profile, root)` una vez, y todo lo que viene después —el modelo del enrutador, el nivel, la estrategia, el presupuesto de recuerdo— usa los valores combinados. Ningún otro lugar del plugin sabe que existe una segunda capa.

**Tres reglas que importan:**

- Un valor igual al global se guarda igualmente como sobrescritura. «Este proyecto usa `task` aunque el perfil pase a `compliance`» es una decisión real, y descartarla en silencio haría que el proyecto siguiera la siguiente edición global.
- Quitar una sobrescritura es explícito. Poner el valor en `null` la borra y restaura la herencia; el archivo desaparece cuando se va su última clave. Nunca se deja un archivo vacío, porque se leería como una decisión que nadie tomó.
- Un archivo de ajustes corrupto se reporta, nunca se adivina. Los valores del perfil se siguen aplicando —un archivo malo no debe dejar sin memoria a un proyecto— y el panel muestra el motivo.

**En el panel.** El panel lateral tiene un selector de proyecto, un interruptor Global / Este proyecto, y una marca en cada campo sobrescrito. No se escribe nada hasta pulsar Guardar, y la capa que estás editando aparece junto a los controles, no solo en el selector.

---

## Estructura del proyecto

```
core/          Node puro, sin importar DSH — el corazón comprobable
  memory.js    almacén de átomos, identidad, fusión, lápidas
  gate.js      selección dispersa de mezcla de expertos y decisión de ruta
  extract.js   extracción determinista de resúmenes y reglas de usuario
  state.js     documento de estado, comparar-y-establecer, diario
  projects.js  registro de proyectos, ajustes por proyecto, combinación efectiva
  indexer.js   índice de documentos   search.js   ordenación léxica
  context.js   presupuestos de tokens   guard.js   marco de datos-no-instrucciones
lib/           la capa cordis
  index.js     cuerpo del plugin, inyección en agent/pre-step
  tools.js     15 herramientas de agente   commands.js   9 comandos de barra
  compaction-memory.js  observador de session/event
  recall.js    recuerdo de un paso   router.js   prompt y análisis del enrutador
  delegate.js  activación del subagente
  panel.js     las dos rutas de loopback del panel lateral
  settings-write.js  persiste un cambio del panel mediante configEditor
client.js      el panel lateral (mitad de navegador, la carga el shell web)
tests/unit/    pruebas del core puro (node --test)
tests/*.mjs    comprobaciones a nivel de host contra el harness real
docs/          notas de diseño y propuestas de documentos
scripts/       extracción y enlace de paquetes del host para las pruebas
```

`docs/design/system-c-memory-atoms.md` explica en profundidad la capa de átomos y la compuerta, incluidas las dos trampas de implementación que se encontraron **probando y no leyendo** (un softmax sobre puntuaciones crudas colapsa a un solo experto; ordenar solo por solapamiento descarta las restricciones duras justo cuando importan).

---

## Limitaciones conocidas

Ver [LIMITATIONS.md](./LIMITATIONS.md). La versión corta: la búsqueda es léxica, no semántica; el enrutador está acotado por `routerTimeoutMs` y degrada a selección determinista; los átomos no son documentos autorizados; y no hay commit automático ni consulta entre proyectos.

El subagente enrutador **nunca se ha ejecutado contra un modelo real**. Sus pruebas unitarias cubren tiempo de espera, aborto, respuesta malformada e ids desconocidos con un delegado simulado, y su construcción se comprueba contra la firma real de `startActivation` — pero no se ha observado ningún spawn real produciendo una selección real. El fallo degrada a selección determinista, así que el peor caso es perder una mejora, no romper un paso. Por eso su prompt está **sin medir**: las estrategias cambian qué se le pide, y no se afirma ninguna cifra de precisión para ninguna de ellas.

El extractor es más estricto que antes —solo lee secciones de compactación conocidas, solo los elementos de lista de Markdown se convierten en átomos, y un encabezado de sección ya no decide el tipo—, pero sigue siendo coincidencia de patrones determinista, no criterio. Un párrafo que enuncia una regla sin viñeta no se extrae: decláralo con `memory_remember`.

---

## Licencia

[MIT](./LICENSE) © 2026 iverins
