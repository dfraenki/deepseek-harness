# DebateHarness Roadmap – PRD & Roadmap Design por Debate Multi-Agente

## Visión
DebateHarness es una app minimalista de chat multi-agente centrada en diseñar PRDs y hojas de ruta de proyecto mediante debate estructurado entre IAs. Cada proyecto es un chat con memoria compartida y configuración de cooperación.

## Principios de diseño
* Minimalismo serio, esquinas redondas, paleta reducida
* Todo configurable: agentes, herramientas, visibilidad, memoria
* Sin referencias a DeepSeek, marca propia DebateHarness

## Fase 0 – Fundamentos y Re-branding
Objetivo: base limpia y marca consistente
- Actualizar README, BRAND_GUIDELINES, UI strings
- Bundle de perfil debate-harness-profile con branding UI
- Habilitar agent-team, presets UI, session-projection
- Seed de 3 agentes base: Product Manager, UX Researcher, Engineer
Entregable: app arranca con branding DebateHarness sin rastro DeepSeek

## Fase 1 – Contactos y Agentes Configurables
Objetivo: crear, editar y usar contactos como agentes persistentes
- Panel lateral Contactos con lista de presets
- Editor de contacto: nombre, avatar, rol, system prompt, personalidad, herramientas, modelo
- Persistencia de presets y permisos por contacto
- Plantillas de agente para PRD: Strategist, Skeptic, Builder
Entregable: usuario crea agentes con máxima libertad

## Fase 2 – Proyecto Chat con Memoria Compartida
Objetivo: cada chat es un proyecto PRD con memoria viva
- Modelo Proyecto: nombre, brief, memoria compartida, historial
- Panel Memoria Compartida: documento vivo auto-resumido
- Configuración de chat: visibilidad entre agentes, acceso a objetivo, nivel de memoria
- Exportar PRD preliminar a Markdown
Entregable: chat con memoria compartida y configuración

## Fase 3 – Debate Estructurado para PRD
Objetivo: debatir ideas y generar PRD
- Creador de debate: seleccionar participantes, tema, formato
- Formatos: Brainstorm 3x3, Debate por rondas, Critica constructiva, Moderador
- Presets de debate de muestra editables:
  * PRD Discovery Debate
  * Feature Prioritization Debate
  * Roadmap Trade-off Debate
- Visualización de sala de debate con roles y resumen
Entregable: generar borrador de PRD mediante debate

## Fase 4 – Hoja de Ruta y Planificación
Objetivo: convertir debate en hoja de ruta ejecutable
- Herramienta Roadmap Builder: extrae decisiones de memoria compartida
- Generación de milestones, tareas y dependencias
- Vista Gantt/Timeline minimalista
- Exportar hoja de ruta a Markdown/CSV
Entregable: PRD + hoja de ruta clara

## Fase 5 – Calidad y Pulido UX
Objetivo: app pulida e interactiva
- UI minimalista con esquinas redondas, micro-interacciones
- Modo foco, atajos de teclado
- Búsqueda en proyectos y debates
- Templates de proyecto para iniciar rápido
Entregable: experiencia final pulida

## Fase 6 – Expansión futura
- Cooperación para creación de productos digitales completos
- Integración con herramientas externas
- Colaboración multi-usuario

## Criterios de aceptación por fase
- Fase 0: arranca web y desktop con branding propio
- Fase 1: crear/editar agentes funciona y persiste
- Fase 2: memoria compartida visible y editable
- Fase 3: debate genera PRD borrador
- Fase 4: hoja de ruta generada desde debate
- Fase 5: UI minimalista y fluida

## Próximo paso inmediato
Crear bundle debate-harness-profile con branding y panel de contactos + seed de agentes base para PRD.
